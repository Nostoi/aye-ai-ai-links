import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import type { Database } from "better-sqlite3";
import { createApp } from "./app.js";
import { keyIdentify } from "./auth/agent-keys.js";
import { openAuthDatabase } from "./auth/better-auth.js";
import { buildAuth } from "./auth/build-auth.js";
import type { MetadataRefresher } from "./auth/metadata-refresher.js";
import type { JsonFetch } from "./auth/metadata-stash.js";
import { modelRoot, type ServerConfig } from "./config.js";
import type { PageExtractor } from "./core/extract.js";
import type { ImageFetcher, LinkChecker, PageFetcher } from "./core/fetch.js";
import { createImageIndexer, type ImageIndexer } from "./core/image-indexer.js";
import { createCopyKeeper } from "./core/keep-copy.js";
import { createLinkCheckRunner, type LinkCheckRunner } from "./core/link-check-runner.js";
import type { FolderCheck } from "./core/saved-copy.js";
import { createSnapshotRunner } from "./core/snapshot-runner.js";
import { createVectorIndexer } from "./core/vector-indexer.js";
import { type AppDeps, createDeps } from "./deps.js";
import { createChildExtractor } from "./fetch/extract-runner.js";
import { createGuardedFetcher } from "./fetch/guarded-fetcher.js";
import { createImageFetcher } from "./fetch/image-fetcher.js";
import { createJsonFetcher } from "./fetch/json-fetcher.js";
import { createLinkChecker } from "./fetch/link-checker.js";
import type { Embedder } from "./search/embedder.js";
import { MODEL_KEY, revisionDir } from "./search/model.js";
import { loadTransformersEmbedder } from "./search/transformers-embedder.js";
import { openDatabase } from "./store/database.js";
import { SqliteKeyStore } from "./store/key-store.js";
import { SqliteSavedCopyStore } from "./store/saved-copies.js";

const DRAIN_MS = 10_000;
/** The drain, this wait and the closes must end inside launchd's 20 s `ExitTimeOut`. */
const SETTLE_MS = 5_000;

function folderMessage(folder: Exclude<FolderCheck, { state: "ready" }>): string {
  const advice =
    folder.state === "mismatch"
      ? " To start a new, empty folder, move this one aside and restart."
      : /EPERM|EACCES/.test(folder.detail)
        ? " Grant the Node binary access to this folder in System Settings → Privacy & Security, then restart the service."
        : "";
  return `[saved copies] paused: ${folder.detail}${advice}`;
}

/**
 * Seams for tests: `decorateDeps` wraps the deps (the snapshot runner uses the wrapped store),
 * `drainMs`, `settleMs` and `saveWaitMs` shorten the waits, `embedder` replaces the model, and
 * `fetcher` and `extractor` replace the real page pipeline, which is otherwise the guarded
 * fetcher (5 MiB cap) and the child extractor. `imageFetcher` replaces the guarded image fetcher
 * the image pass uses. `linkChecker` replaces the guarded link checker the check runner uses.
 * `wrapAuthMigrations` runs around the auth migrations, so a test can hold
 * them. `jsonFetcher` replaces the guarded JSON fetcher that fetches OAuth client metadata.
 */
export type StartOptions = {
  decorateDeps?: (deps: AppDeps) => AppDeps;
  drainMs?: number;
  settleMs?: number;
  /** How long a new link's save waits for its page; core's `SAVE_WAIT_MS` when left out. */
  saveWaitMs?: number;
  /** Answers query embeddings; the pinned model loaded from `modelRoot()` when left out. */
  embedder?: Embedder;
  fetcher?: PageFetcher;
  extractor?: PageExtractor;
  imageFetcher?: ImageFetcher;
  /** Time between image pass sweeps; its 15 s default when left out. */
  imagePollMs?: number;
  /** Replaces the guarded link checker the dead-link checks use. */
  linkChecker?: LinkChecker;
  /** Time between check sweeps; its 60 s default when left out. */
  checkPollMs?: number;
  wrapAuthMigrations?: (migrate: () => Promise<void>) => Promise<void>;
  jsonFetcher?: { fetch: JsonFetch; close: () => Promise<void> };
  refresherIntervalMs?: number;
  /** Receives the request log, one line per request; stdout when left out. */
  requestLog?: (line: string) => void;
};

/**
 * Loads the model, opens the database, checks the saved-copy folder and undoes any copy left
 * mid-write (before anything listens; an unready folder only pauses copies), opens the auth
 * database, builds the auth side (migrations,
 * internal client, and the client metadata of every connected OAuth client) and serves on
 * loopback; Tailscale Serve reaches it from the tailnet and a Cloudflare Tunnel from the internet.
 * The auth database stays locked against every other process until it closes, so the owner CLI
 * runs only while the server is stopped.
 * The snapshot runner, the vector indexer, the image pass, the check runner and the metadata
 * refresher start once the server is listening. Any failure before that closes what was already opened.
 *
 * `stop` shuts down in this order, so no write is cut off and no job's attempt is wasted:
 * 1. The runner, the indexer, the image pass and the check runner take no new work; running jobs,
 *    an embedding, an image fetch and a link check in flight carry on.
 * 2. The HTTP drain: no new connections, and requests in flight get up to the drain limit.
 * 3. The runner aborts its jobs, which give their attempts back, the image pass aborts its fetch,
 *    leaving that image pending, and the check runner aborts its check, recording nothing, so the
 *    link stays due. Stop waits for them, for the indexer's sweep and for any tool call still
 *    running, up to the settle limit.
 * 4. The metadata refresher stops: it aborts every metadata fetch in flight and waits for them.
 *    The image pass's and the check runner's stops are awaited again. Then the JSON fetcher
 *    closes, the image fetcher, the link checker, the page fetcher, and the extractor (killing
 *    any child).
 * 5. The MCP handler closes, then the database, then the auth database.
 * A call or job still running after step 3 fails on the closed database; the error is caught
 * and logged.
 */
export async function startServer(
  config: ServerConfig,
  {
    decorateDeps = (d) => d,
    drainMs = DRAIN_MS,
    settleMs = SETTLE_MS,
    saveWaitMs,
    embedder,
    fetcher = createGuardedFetcher({ version: config.version }),
    extractor = createChildExtractor(),
    imageFetcher = createImageFetcher({ version: config.version }),
    imagePollMs,
    linkChecker = createLinkChecker({ version: config.version }),
    checkPollMs,
    wrapAuthMigrations = (migrate) => migrate(),
    jsonFetcher = createJsonFetcher({ version: config.version }),
    refresherIntervalMs,
    requestLog = console.log,
  }: StartOptions = {},
) {
  // Loading first means a missing or tampered model fails the start with nothing to close.
  const model = embedder ?? (await loadTransformersEmbedder(revisionDir(modelRoot())));

  let db: Database | undefined;
  let authDb: Database | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  let refresher: MetadataRefresher | undefined;
  let images: ImageIndexer | undefined;
  let checks: LinkCheckRunner | undefined;
  const closeAll = async () => {
    await refresher?.stop();
    // Its fetch must end before the fetcher closes, or a closed fetcher would end it as a failure.
    await images?.stop();
    // The same for the check in flight and its checker.
    await checks?.stop();
    await jsonFetcher.close();
    await imageFetcher.close();
    await linkChecker.close();
    await fetcher.close();
    await extractor.close();
    await closeApp?.();
    db?.close();
    authDb?.close();
  };

  let runner: ReturnType<typeof createSnapshotRunner>;
  let indexer: ReturnType<typeof createVectorIndexer>;
  let calls: ReturnType<typeof createApp>["calls"];
  let server: Server;
  try {
    db = openDatabase(config.dbPath);
    const deps = decorateDeps(createDeps(db, model));
    // Before anything can listen or save: an unready folder pauses copies, it never refuses the start.
    const savedCopies = new SqliteSavedCopyStore(db, config.savedCopies.dir);
    const folder = await savedCopies.checkFolder();
    if (folder.state !== "ready") console.error(folderMessage(folder));
    const undone = await savedCopies.undoUnconfirmed();
    if (undone.copies + undone.images > 0) {
      console.error(
        `[saved copies] undid ${undone.copies} copies and ${undone.images} images left mid-write`,
      );
    }
    runner = createSnapshotRunner({
      store: deps.store,
      fetcher,
      extractor,
      now: deps.now,
      copies: createCopyKeeper({
        copies: savedCopies,
        tools: deps.tools,
        limitBytes: config.savedCopies.limitBytes,
        now: deps.now,
      }),
    });
    // The same embedder as search, so documents and queries share its one queue.
    indexer = createVectorIndexer({
      store: deps.vectorIndex,
      embedder: model,
      modelKey: MODEL_KEY,
      now: deps.now,
    });
    images = createImageIndexer({
      store: deps.images,
      fetcher: imageFetcher,
      now: deps.now,
      ...(imagePollMs !== undefined && { pollMs: imagePollMs }),
    });
    checks = createLinkCheckRunner({
      checks: deps.checks,
      checker: linkChecker,
      now: deps.now,
      ...(checkPollMs !== undefined && { pollMs: checkPollMs }),
    });
    authDb = openAuthDatabase(config.auth.dbPath);
    const keys = new SqliteKeyStore(db);
    const auth = await buildAuth({
      db: authDb,
      secret: config.auth.secret,
      baseUrl: config.auth.baseUrl,
      fetch: jsonFetcher.fetch,
      keys: keyIdentify(keys),
      wrapMigrations: wrapAuthMigrations,
      refresherOptions: { intervalMs: refresherIntervalMs },
    });
    refresher = auth.refresher;
    const built = createApp({
      deps: { ...deps, snapshots: runner, saveWaitMs, version: config.version },
      identify: auth.identify,
      auth: { ...auth, keys },
      allowedHosts: config.allowedHosts,
      log: requestLog,
    });
    closeApp = built.close;
    calls = built.calls;
    server = await new Promise<Server>((resolve, reject) => {
      const s = serve({
        fetch: built.app.fetch,
        hostname: "127.0.0.1",
        port: config.port,
      }) as Server;
      s.once("error", reject);
      s.once("listening", () => resolve(s));
    });
  } catch (error) {
    await closeAll().catch((e) => console.error("[server] cleanup after a failed start:", e));
    throw error;
  }
  runner.start();
  indexer.start();
  images?.start();
  checks?.start();
  refresher.start();

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
    let indexEnded = false;
    const indexStopped = indexer.stop().then(() => {
      indexEnded = true;
    });
    let imagesEnded = false;
    const imagesStopped = (images?.stop() ?? Promise.resolve()).then(() => {
      imagesEnded = true;
    });
    let checksEnded = false;
    const checksStopped = (checks?.stop() ?? Promise.resolve()).then(() => {
      checksEnded = true;
    });
    let bound: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<true>((resolve) => {
      bound = setTimeout(() => resolve(true), settleMs);
    });
    const ended = Promise.all([
      stopped,
      indexStopped,
      imagesStopped,
      checksStopped,
      calls().ended,
    ]).then(() => false as const);
    try {
      if (await Promise.race([ended, timedOut])) {
        console.error(
          `[server] closing after ${settleMs} ms with ${calls().running} MCP call(s) running; snapshot jobs ${jobsEnded ? "ended" : "still running"}; vector indexer ${indexEnded ? "ended" : "still running"}; image pass ${imagesEnded ? "ended" : "still running"}; link checks ${checksEnded ? "ended" : "still running"}`,
        );
      }
    } finally {
      clearTimeout(bound);
    }
  };

  const shutdown = async () => {
    runner.quiesce();
    indexer.quiesce();
    images?.quiesce();
    checks?.quiesce();
    await drain();
    await settle();
    await closeAll();
  };

  let stopping: Promise<void> | undefined;
  return { port, stop: () => (stopping ??= shutdown()) };
}
