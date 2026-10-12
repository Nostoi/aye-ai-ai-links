import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { keyIdentify } from "./auth/agent-keys.js";
import type { ServerConfig } from "./config.js";
import type { PageExtractor } from "./core/extract.js";
import type { PageFetcher } from "./core/fetch.js";
import { createSnapshotRunner } from "./core/snapshot-runner.js";
import { type AppDeps, createDeps } from "./deps.js";
import { createChildExtractor } from "./fetch/extract-runner.js";
import { createGuardedFetcher } from "./fetch/guarded-fetcher.js";
import { openDatabase } from "./store/database.js";
import { SqliteKeyStore } from "./store/key-store.js";

const DRAIN_MS = 10_000;
/** The drain, this wait and the closes must end inside launchd's 20 s `ExitTimeOut`. */
const SETTLE_MS = 5_000;

/**
 * Seams for tests: `decorateDeps` wraps the deps (the snapshot runner uses the wrapped store),
 * `drainMs` and `settleMs` shorten the waits, and `fetcher` and `extractor` replace the real
 * page pipeline, which is otherwise the guarded fetcher (5 MiB cap) and the child extractor.
 */
export type StartOptions = {
  decorateDeps?: (deps: AppDeps) => AppDeps;
  drainMs?: number;
  settleMs?: number;
  fetcher?: PageFetcher;
  extractor?: PageExtractor;
};

/**
 * Opens the database and serves on loopback; Tailscale Serve is what reaches it from the tailnet.
 * The snapshot runner starts once the server is listening.
 *
 * `stop` shuts down in this order, so no write is cut off and no job's attempt is wasted:
 * 1. The runner takes no new work; running jobs carry on.
 * 2. The HTTP drain: no new connections, and requests in flight get up to the drain limit.
 * 3. The runner aborts its jobs, which give their attempts back, and stop waits for them and
 *    for any tool call still running, up to the settle limit.
 * 4. The fetcher closes, then the extractor (killing any child).
 * 5. The MCP handler closes, then the database.
 * A call or job still running after step 3 fails on the closed database; the error is caught
 * and logged.
 */
export async function startServer(
  config: ServerConfig,
  {
    decorateDeps = (d) => d,
    drainMs = DRAIN_MS,
    settleMs = SETTLE_MS,
    fetcher = createGuardedFetcher(),
    extractor = createChildExtractor(),
  }: StartOptions = {},
) {
  const db = openDatabase(config.dbPath);
  const deps = decorateDeps(createDeps(db));
  const runner = createSnapshotRunner({ store: deps.store, fetcher, extractor, now: deps.now });
  const { app, close, calls } = createApp({
    deps: { ...deps, snapshots: runner },
    identify: keyIdentify(new SqliteKeyStore(db)),
    allowedHosts: config.allowedHosts,
  });
  const closeAll = async () => {
    await fetcher.close();
    await extractor.close();
    await close();
    db.close();
  };

  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port }) as Server;
      s.once("error", reject);
      s.once("listening", () => resolve(s));
    });
  } catch (error) {
    await closeAll();
    throw error;
  }
  runner.start();

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  const drain = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Connections that go idle after their last response would otherwise hold the close open.
    const sweep = setInterval(() => server.closeIdleConnections(), 100);
    server.closeIdleConnections();
    const limit = setTimeout(() => server.closeAllConnections(), drainMs);
    try {
      await closed;
    } finally {
      clearInterval(sweep);
      clearTimeout(limit);
    }
  };

  const settle = async () => {
    let jobsEnded = false;
    const stopped = runner.stop().then(() => {
      jobsEnded = true;
    });
    let bound: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<true>((resolve) => {
      bound = setTimeout(() => resolve(true), settleMs);
    });
    const ended = Promise.all([stopped, calls().ended]).then(() => false as const);
    try {
      if (await Promise.race([ended, timedOut])) {
        console.error(
          `[server] closing after ${settleMs} ms with ${calls().running} MCP call(s) running; snapshot jobs ${jobsEnded ? "ended" : "still running"}`,
        );
      }
    } finally {
      clearTimeout(bound);
    }
  };

  const shutdown = async () => {
    runner.quiesce();
    await drain();
    await settle();
    await closeAll();
  };

  let stopping: Promise<void> | undefined;
  return { port, stop: () => (stopping ??= shutdown()) };
}
