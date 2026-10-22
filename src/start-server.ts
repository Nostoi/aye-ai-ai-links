import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import type { Database } from "better-sqlite3";
import { createChatModel } from "./ai/create-model.js";
import { createSummarizer } from "./ai/summarize.js";
import { createApp } from "./app.js";
import { keyIdentify } from "./auth/agent-keys.js";
import { openAuthDatabase } from "./auth/better-auth.js";
import { buildAuth } from "./auth/build-auth.js";
import type { MetadataRefresher } from "./auth/metadata-refresher.js";
import type { JsonFetch } from "./auth/metadata-stash.js";
import { modelRoot, type ServerConfig } from "./config.js";
import { type CopyPass, createCopyPass } from "./core/copy-pass.js";
import type { ExportBuilds } from "./core/export-builds.js";
import type { PageExtractor } from "./core/extract.js";
import type { ImageFetcher, LinkChecker, PageFetcher } from "./core/fetch.js";
import { createIconBackfill, type IconBackfill } from "./core/icon-backfill.js";
import { createImageIndexer, type ImageIndexer } from "./core/image-indexer.js";
import { createCopyKeeper } from "./core/keep-copy.js";
import { createLinkCheckRunner, type LinkCheckRunner } from "./core/link-check-runner.js";
import { createLinkPurger } from "./core/link-removal.js";
import { pausedMessage } from "./core/saved-copy.js";
import { createSnapshotRunner } from "./core/snapshot-runner.js";
import { createSummaryPass, type SummaryPass } from "./core/summary-pass.js";
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

const DRAIN_MS = 10_000;
/** The drain, this wait and the closes must end inside launchd's 20 s `ExitTimeOut`. */
const SETTLE_MS = 5_000;

/**
 * Seams for tests: `decorateDeps` wraps the deps (the snapshot runner uses the wrapped store),
 * `drainMs`, `settleMs` and `saveWaitMs` shorten the waits, `embedder` replaces the model, and
 * `fetcher` and `extractor` replace the real page pipeline, which is otherwise the guarded
 * fetcher (5 MiB cap) and the child extractor. `imageFetcher` replaces the guarded image fetcher
 * the image pass uses. `copyExtractor` replaces the copy pass's own child extractor, and
 * `copyPollMs` its sweep interval. `iconExtractor` replaces the icon backfill's own child extractor, and
 * `iconPollMs` its sweep interval. `summaryPollMs` and `summaryGapMs` set the summary pass's sweep interval and the gap between its AI calls. `linkChecker` replaces the guarded link checker the check runner uses.
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
  /** Time between purges of links deleted over a minute ago; its 60 s default when left out. */
  linkPurgeMs?: number;
  /** The copy pass's own extractor; a second child extractor when left out. */
  copyExtractor?: PageExtractor;
  /** Time between copy pass sweeps; its 15 s default when left out. */
  copyPollMs?: number;
  /** The icon backfill's own extractor; a third child extractor when left out. */
  iconExtractor?: PageExtractor;
  /** Time between icon backfill sweeps; its 15 s default when left out. */
  iconPollMs?: number;
  /** Time between summary pass sweeps; its 60 s default when left out. */
  summaryPollMs?: number;
  /** Time between the summary pass's AI calls; its 5 s default when left out. */
  summaryGapMs?: number;
  wrapAuthMigrations?: (migrate: () => Promise<void>) => Promise<void>;
  jsonFetcher?: { fetch: JsonFetch; close: () => Promise<void> };
  refresherIntervalMs?: number;
  /** Receives the request log, one line per request; stdout when left out. */
  requestLog?: (line: string) => void;
};

/**
 * Loads the model, opens the database, checks the saved-copy folder and undoes any copy left
 * mid-write (before anything listens; an unready folder only pauses copies), readies the export
 * folder beside the database and deletes the exports and temporary files builds left there (a
 * symlink or non-directory refuses the start), opens the auth
 * database, builds the auth side (migrations,
 * internal client, and the client metadata of every connected OAuth client) and serves on
 * loopback; Tailscale Serve reaches it from the tailnet and a Cloudflare Tunnel from the internet.
 * The auth database stays locked against every other process until it closes, so the owner CLI
 * runs only while the server is stopped.
 * The snapshot runner, the vector indexer, the image pass, the copy pass, the icon backfill, the summary pass (only when the AI is set up), the check runner, the link purger and the
 * metadata refresher start once the server is listening. Any failure before that closes what was already opened.
 *
 * `stop` shuts down in this order, so no write is cut off and no job's attempt is wasted:
 * 1. In-app AI turns are stopped first: a model call in flight is aborted and the turn answers
 *    that the server is stopping, so its request ends before the drain; a tool call already
 *    running carries on, and step 3 waits for it.
 *    The runner, the indexer, the image pass, the copy pass, the icon backfill, the summary pass and the check runner take no new work;
 *    running jobs, an embedding, an image fetch, a copy in the making, a page being read for its icon,
 *    a summary being written and a link check in flight carry on.
 * 2. The HTTP drain: no new connections, and requests in flight get up to the drain limit.
 * 3. The runner aborts its jobs, which give their attempts back, the image pass aborts its fetch,
 *    leaving that image pending, the copy pass aborts its fetch or extraction, leaving the copy for
 *    the next sweep, the icon backfill aborts its fetch or extraction, recording nothing, so the link
 *    stays a candidate, the summary pass aborts its AI call, writing nothing, so the link stays a
 *    candidate, and the check runner aborts its check, recording nothing, so the
 *    link stays due. Stop waits for them, for the indexer's sweep and for any tool call still
 *    running, up to the settle limit.
 * 4. Export builds are told to stop, before any wait: a running build stops at its next read and
 *    discards its temporary file, or the next start deletes it.
 *    The metadata refresher stops: it aborts every metadata fetch in flight and waits for them.
 *    The image pass's, the copy pass's, the icon backfill's, the summary pass's and the check runner's stops are awaited again. Then the
 *    JSON fetcher closes, the image fetcher, the link checker, the page fetcher, and the three
 *    extractors (killing any child).
 * 5. The MCP handler closes, then the database, then the auth database.
 * The link purger runs through steps 1-3 and stops as the closes begin, so no purge meets a closed database.
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
    linkPurgeMs,
    copyExtractor = createChildExtractor(),
    copyPollMs,
    iconExtractor = createChildExtractor(),
    iconPollMs,
    summaryPollMs,
    summaryGapMs,
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
  let copyPass: CopyPass | undefined;
  let iconBackfill: IconBackfill | undefined;
  let summaryPass: SummaryPass | undefined;
  let checks: LinkCheckRunner | undefined;
  let purger: ReturnType<typeof createLinkPurger> | undefined;
  let exports: ExportBuilds | undefined;
  const closeAll = async () => {
    purger?.stop();
    // Before any await: a running build stops at its next read instead of reading a closed database.
    exports?.stop();
    await refresher?.stop();
    // Its fetch must end before the fetcher closes, or a closed fetcher would end it as a failure.
    await images?.stop();
    await copyPass?.stop();
    await iconBackfill?.stop();
    await summaryPass?.stop();
    // The same for the check in flight and its checker.
    await checks?.stop();
    await jsonFetcher.close();
    await imageFetcher.close();
    await linkChecker.close();
    await fetcher.close();
    await extractor.close();
    await copyExtractor.close();
    await iconExtractor.close();
    await closeApp?.();
    db?.close();
    authDb?.close();
  };

  let runner: ReturnType<typeof createSnapshotRunner>;
  let indexer: ReturnType<typeof createVectorIndexer>;
  let calls: ReturnType<typeof createApp>["calls"];
  let stopTurns: ReturnType<typeof createApp>["stopTurns"];
  let server: Server;
  try {
    db = openDatabase(config.dbPath);
    const deps = decorateDeps(
      createDeps(db, model, config.savedCopies.dir, join(dirname(config.dbPath), "exports")),
    );
    exports = deps.exports;
    // Before anything can listen or save: an unready folder pauses copies, it never refuses the start.
    const savedCopies = deps.savedCopies;
    const folder = await savedCopies.checkFolder();
    if (folder.state !== "ready") console.error(pausedMessage(config.savedCopies.dir, folder));
    const undone = await savedCopies.undoUnconfirmed();
    if (undone.copies + undone.images > 0) {
      console.error(
        `[saved copies] undid ${undone.copies} copies and ${undone.images} images left mid-write`,
      );
    }
    // A build in progress when the server last stopped left at most a temporary file; no export survives a restart.
    await deps.exportFolder.reset();
    const keeper = createCopyKeeper({
      copies: savedCopies,
      tools: deps.tools,
      limitBytes: config.savedCopies.limitBytes,
      now: deps.now,
    });
    runner = createSnapshotRunner({
      store: deps.store,
      fetcher,
      extractor,
      now: deps.now,
      copies: keeper,
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
    copyPass = createCopyPass({
      copies: savedCopies,
      keeper,
      pages: fetcher,
      extractor: copyExtractor,
      images: imageFetcher,
      limitBytes: config.savedCopies.limitBytes,
      dir: config.savedCopies.dir,
      now: deps.now,
      gate: deps.readGate,
      canResolve: (signal) => linkChecker.canResolve(signal),
      ...(copyPollMs !== undefined && { pollMs: copyPollMs }),
    });
    iconBackfill = createIconBackfill({
      store: deps.images,
      pages: fetcher,
      extractor: iconExtractor,
      canResolve: (signal) => linkChecker.canResolve(signal),
      now: deps.now,
      ...(iconPollMs !== undefined && { pollMs: iconPollMs }),
    });
    // One connection for the web door's chat and the summary pass.
    const chat = config.ai && createChatModel(config.ai);
    if (chat) {
      summaryPass = createSummaryPass({
        store: deps.store,
        pages: deps.store,
        summarizer: createSummarizer(chat),
        now: deps.now,
        ...(summaryPollMs !== undefined && { pollMs: summaryPollMs }),
        ...(summaryGapMs !== undefined && { gapMs: summaryGapMs }),
      });
    }
    checks = createLinkCheckRunner({
      checks: deps.checks,
      checker: linkChecker,
      now: deps.now,
      ...(checkPollMs !== undefined && { pollMs: checkPollMs }),
    });
    purger = createLinkPurger({
      store: deps.store,
      now: deps.now,
      ...(linkPurgeMs !== undefined && { everyMs: linkPurgeMs }),
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
      deps: {
        ...deps,
        snapshots: runner,
        saveWaitMs,
        copyLimitBytes: config.savedCopies.limitBytes,
        version: config.version,
        ai: chat,
      },
      identify: auth.identify,
      auth: { ...auth, keys },
      allowedHosts: config.allowedHosts,
      log: requestLog,
    });
    closeApp = built.close;
    calls = built.calls;
    stopTurns = built.stopTurns;
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
  copyPass?.start();
  iconBackfill?.start();
  summaryPass?.start();
  checks?.start();
  purger?.start();
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
    let copiesEnded = false;
    const copiesStopped = (copyPass?.stop() ?? Promise.resolve()).then(() => {
      copiesEnded = true;
    });
    let iconsEnded = false;
    const iconsStopped = (iconBackfill?.stop() ?? Promise.resolve()).then(() => {
      iconsEnded = true;
    });
    let summariesEnded = false;
    const summariesStopped = (summaryPass?.stop() ?? Promise.resolve()).then(() => {
      summariesEnded = true;
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
      copiesStopped,
      iconsStopped,
      summariesStopped,
      checksStopped,
      calls().ended,
    ]).then(() => false as const);
    try {
      if (await Promise.race([ended, timedOut])) {
        console.error(
          `[server] closing after ${settleMs} ms with ${calls().running} MCP call(s) running; snapshot jobs ${jobsEnded ? "ended" : "still running"}; vector indexer ${indexEnded ? "ended" : "still running"}; image pass ${imagesEnded ? "ended" : "still running"}; copy pass ${copiesEnded ? "ended" : "still running"}; icon backfill ${iconsEnded ? "ended" : "still running"}; summary pass ${summariesEnded ? "ended" : "still running"}; link checks ${checksEnded ? "ended" : "still running"}`,
        );
      }
    } finally {
      clearTimeout(bound);
    }
  };

  const shutdown = async () => {
    stopTurns();
    runner.quiesce();
    indexer.quiesce();
    images?.quiesce();
    copyPass?.quiesce();
    iconBackfill?.quiesce();
    summaryPass?.quiesce();
    checks?.quiesce();
    await drain();
    await settle();
    await closeAll();
  };

  let stopping: Promise<void> | undefined;
  return { port, stop: () => (stopping ??= shutdown()) };
}
