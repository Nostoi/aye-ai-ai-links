import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { keyIdentify } from "./auth/agent-keys.js";
import type { ServerConfig } from "./config.js";
import { type AppDeps, createDeps } from "./deps.js";
import { openDatabase } from "./store/database.js";
import { SqliteKeyStore } from "./store/key-store.js";

const DRAIN_MS = 10_000;

/** `decorateDeps` and `drainMs` exist for tests. */
export type StartOptions = { decorateDeps?: (deps: AppDeps) => AppDeps; drainMs?: number };

/**
 * Opens the database and serves on loopback; Tailscale Serve is what reaches it from the tailnet.
 * `stop` drains before it closes: no new connections, in-flight requests finish (up to the
 * drain limit), then the MCP handler and the database close, so a running write is not cut off.
 */
export async function startServer(
  config: ServerConfig,
  { decorateDeps = (d) => d, drainMs = DRAIN_MS }: StartOptions = {},
) {
  const db = openDatabase(config.dbPath);
  const { app, close } = createApp({
    deps: decorateDeps(createDeps(db)),
    identify: keyIdentify(new SqliteKeyStore(db)),
    allowedHosts: config.allowedHosts,
  });
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port }) as Server;
      s.once("error", reject);
      s.once("listening", () => resolve(s));
    });
  } catch (error) {
    await close();
    db.close();
    throw error;
  }

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
    await close();
    db.close();
  };

  let stopping: Promise<void> | undefined;
  return { port, stop: () => (stopping ??= drain()) };
}
