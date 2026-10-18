import type { PageExtractor } from "./extract.js";
import type { FetchOutcome, ImageFetcher, PageFetcher } from "./fetch.js";
import { MAX_IMAGE_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_MS } from "./image-indexer.js";
import type { CopyKeeper } from "./keep-copy.js";
import {
  type CopyCandidate,
  type FolderCheck,
  MAX_COPY_BYTES,
  pausedMessage,
  type SavedCopyMaintenance,
  type SavedCopyUsage,
  type SavedCopyWriter,
} from "./saved-copy.js";

export type CopyPassOptions = {
  copies: SavedCopyWriter & Omit<SavedCopyMaintenance, "purgeRemoved"> & SavedCopyUsage;
  keeper: CopyKeeper;
  pages: PageFetcher;
  /** The pass's own extractor. */
  extractor: PageExtractor;
  images: ImageFetcher;
  limitBytes: number;
  /** The saved-copy folder, for log lines only. */
  dir: string;
  /** The start-up folder check, so a folder paused at start is not logged twice. */
  initialCheck: FolderCheck;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Time between sweeps. Default 15 s. */
  pollMs?: number;
  /** Time between orphan sweeps. Default 6 h. */
  sweepEveryMs?: number;
  /** Rows read per page. Default 100. */
  pageSize?: number;
  /** Test seam: called each time the sweep reaches the later phases. */
  onLaterPhases?: () => void;
};

export type CopyPass = {
  /** Sweep now and every `pollMs`. */
  start(): void;
  /** Take no new work: stop sweeping. A sweep in flight carries on. */
  quiesce(): void;
  /** Quiesce, abort the fetch or extraction in flight, and wait for the sweep to end. */
  stop(): Promise<void>;
  /** One sweep. Resolves when it ends. */
  sweep(): Promise<void>;
};

/** A link waiting out a backoff, or (`settle`) waiting only for its final `failed` write. */
type Failure = { attempts: number; retryAt: number; settle: boolean };

/** What one attempt on a candidate came to. */
type Attempt = "done" | "transient" | "abandon" | "unavailable";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** What a failed page fetch means: no copy, a failure to retry, or nothing. */
function judgePage(page: Exclude<FetchOutcome, { kind: "ok" }>): "none" | "transient" | "abandon" {
  switch (page.kind) {
    case "refused":
    case "not_html":
    case "too_large":
      return "none";
    case "http_error": {
      const s = page.status;
      return s === 408 || s === 429 || s >= 500 ? "transient" : "none";
    }
    case "network_error":
    case "timeout":
      return "transient";
    case "aborted":
      return "abandon";
    default: {
      const unreachable: never = page;
      return unreachable;
    }
  }
}

/**
 * Finishes what a save started, in the background: it re-checks the folder and backfills copies
 * for links saved without one.
 *
 * The backfill fetches at most one page per sweep. A transient failure is tried again after a
 * backoff and settles `failed` on its `MAX_IMAGE_ATTEMPTS`th; a spent budget is never fetched
 * again, only its final write is retried. A folder that is not `ready` is no failure. Backoffs
 * are kept in memory, so a restart tries every link again. A fetch or extraction aborted by
 * `stop` leaves its link a candidate.
 */
export function createCopyPass(o: CopyPassOptions): CopyPass {
  const { copies, keeper, pages, extractor, limitBytes, dir, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 15_000;
  const pageSize = o.pageSize ?? 100;

  /** Links with a spent or running budget, by owner and link. Dropped only when the link is done. */
  const failures = new Map<string, Failure>();
  const abort = new AbortController();
  let lastState = o.initialCheck.state;
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sweep in flight. */
  let running: Promise<void> | undefined;

  const keyOf = (c: CopyCandidate) => JSON.stringify([c.owner, c.linkId]);

  /** Logs a change of folder state; true when the folder is ready. */
  function observe(check: FolderCheck): boolean {
    if (check.state !== lastState) {
      lastState = check.state;
      log(check.state === "ready" ? "[saved copies] resumed" : pausedMessage(dir, check));
    }
    return check.state === "ready";
  }

  async function recordNone(c: CopyCandidate, key: string): Promise<void> {
    await copies.recordNoCopy(c.owner, c.linkId, "none");
    failures.delete(key);
  }

  /** The final write of a link whose budget is spent. */
  async function settleFailed(c: CopyCandidate, key: string): Promise<void> {
    await copies.recordNoCopy(c.owner, c.linkId, "failed");
    failures.delete(key);
  }

  /** Counts a failed attempt: a backoff, or on the last one the `failed` row. */
  async function countFailure(c: CopyCandidate, key: string, why: string): Promise<void> {
    const attempts = (failures.get(key)?.attempts ?? 0) + 1;
    log(`copy ${key}: ${why} (attempt ${attempts})`);
    if (attempts < MAX_IMAGE_ATTEMPTS) {
      const wait = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      failures.set(key, { attempts, retryAt: now().getTime() + wait, settle: false });
      return;
    }
    failures.set(key, { attempts, retryAt: 0, settle: true });
    await settleFailed(c, key);
  }

  /** Fetches and extracts one candidate and records what came of it. Throws for a store error. */
  async function attempt(c: CopyCandidate, key: string): Promise<Attempt> {
    const { signal } = abort;
    const page = await pages.fetch(c.url, signal);
    if (signal.aborted) return "abandon";
    if (page.kind !== "ok") {
      const verdict = judgePage(page);
      if (verdict !== "none") return verdict;
      await recordNone(c, key);
      return "done";
    }
    const out = await extractor.extract(page.html, page.finalUrl, signal, { copy: true });
    if (signal.aborted) return "abandon";
    if (out.kind === "aborted") return "abandon";
    if (out.kind !== "ok" || out.copy === undefined) return "transient";
    if (out.copy === null) {
      await recordNone(c, key);
      return "done";
    }
    if ((await keeper.keep(c.owner, c.linkId, out.copy)) === "unavailable") return "unavailable";
    failures.delete(key);
    return "done";
  }

  /**
   * After a thrown store call: false when the folder is no longer ready (nothing is counted and
   * the sweep ends paused); otherwise the throw counts as one failed attempt, unless the link was
   * already only waiting for its final write.
   */
  async function afterThrow(c: CopyCandidate, key: string, error: unknown): Promise<boolean> {
    log(`copy ${key}: a store call failed`, error);
    if (abort.signal.aborted || !(await folderReady())) return false;
    if (failures.get(key)?.settle) return true;
    try {
      await countFailure(c, key, "a store call failed");
    } catch (settleError) {
      log(`copy ${key}: could not record the failure`, settleError);
    }
    return true;
  }

  /** Re-checks the folder; a check that throws counts as not ready and changes no logged state. */
  async function folderReady(): Promise<boolean> {
    try {
      return observe(await copies.checkFolder());
    } catch (error) {
      log("copy pass backfill failed", error);
      return false;
    }
  }

  /** The backfill. True when the sweep must end: the folder cannot be written to. */
  async function backfill(): Promise<boolean> {
    try {
      return await backfillPages();
    } catch (error) {
      log("copy pass backfill failed", error);
      return !(await folderReady());
    }
  }

  /** The backfill's page-through: at most one page fetch. */
  async function backfillPages(): Promise<boolean> {
    const retryNoRoom = limitBytes - (await copies.usedBytes()) >= MAX_COPY_BYTES;
    let after: string | null = null;
    for (;;) {
      const rows = await copies.backfillCandidates(after, pageSize, { retryNoRoom });
      for (const c of rows) {
        if (quiet) return false;
        const key = keyOf(c);
        const failed = failures.get(key);
        let fetched = false;
        try {
          if (failed?.settle) {
            await settleFailed(c, key);
            continue;
          }
          if (failed && now().getTime() < failed.retryAt) continue;
          if (await keeper.refuse(c.owner, c.linkId)) {
            failures.delete(key);
            continue;
          }
          fetched = true;
          const result = await attempt(c, key);
          if (result === "transient") await countFailure(c, key, "could not be copied");
          return result === "unavailable";
        } catch (error) {
          if (!(await afterThrow(c, key, error))) return true;
          if (fetched) return false;
        }
      }
      if (rows.length < pageSize) return false;
      after = (rows.at(-1) as CopyCandidate).linkId;
      await nextTurn();
      if (quiet) return false;
    }
  }

  /** The later phases (images, finishing, orphans, usage). */
  async function laterPhases(): Promise<void> {
    o.onLaterPhases?.();
  }

  async function phase(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      log(`copy pass ${name} failed`, error);
    }
  }

  async function sweepOnce(): Promise<void> {
    if (quiet) return;
    let ready = false;
    await phase("check", async () => {
      ready = observe(await copies.checkFolder());
    });
    if (!ready) return;
    let paused = false;
    if (keeper.wanted) {
      await phase("backfill", async () => {
        paused = await backfill();
      });
    }
    if (paused || quiet) return;
    await phase("later", laterPhases);
  }

  /** Runs `work` as the one thing in flight, so `stop` can wait for it and sweeps never overlap. */
  function exclusive(work: () => Promise<void>): Promise<void> {
    const prior = running ?? Promise.resolve();
    const mine = prior.then(work);
    running = mine;
    return mine.finally(() => {
      if (running === mine) running = undefined;
    });
  }

  function quiesce(): void {
    quiet = true;
    clearTimeout(timer);
  }

  return {
    start() {
      if (started || quiet) return;
      started = true;
      const tick = async () => {
        await exclusive(sweepOnce);
        if (!quiet) timer = setTimeout(tick, pollMs);
      };
      void tick();
    },

    quiesce,

    async stop() {
      quiesce();
      abort.abort();
      await running;
    },

    sweep: () => exclusive(sweepOnce),
  };
}
