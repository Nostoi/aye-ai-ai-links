import type { PageExtractor } from "./extract.js";
import type { FetchOutcome, ImageFetcher, PageFetcher } from "./fetch.js";
import { judgeImage, MAX_IMAGE_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_MS } from "./image-indexer.js";
import type { CopyKeeper } from "./keep-copy.js";
import {
  type CopyCandidate,
  type CopyRef,
  copyLimits,
  type FolderCheck,
  finishedMarkdown,
  MAX_COPY_BYTES,
  type PendingCopyImage,
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

/** Failure budgets for one kind of entry (links, images), by key. */
type Budget = Map<string, Failure>;

/** What one attempt on a candidate came to. */
type Attempt = "done" | "transient" | "abandon" | "unavailable";

/** A finishing call that takes longer than this is left running and tried again later. */
const FINISH_TIMEOUT_MS = 10_000;
/** The orphan sweep leaves a folder or temporary file younger than this alone. */
const ORPHAN_GRACE_MS = 60 * 60_000;

const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(1);
const backoff = (attempts: number) => Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

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
 * Finishes what a save started, in the background. Each sweep re-checks the folder, backfills a
 * copy for a link saved without one, fetches the images of saved copies, finishes copies whose
 * images have settled, sweeps orphans every `sweepEveryMs`, and logs usage thresholds.
 *
 * The backfill fetches at most one page per sweep. A transient failure of a page or an image is
 * tried again after a backoff and settles (`failed` for a link, `none` for an image) on its
 * `MAX_IMAGE_ATTEMPTS`th; a spent budget is never fetched again, only its final write is retried.
 * A folder that is not `ready` is no failure and ends the sweep. Backoffs are kept in memory, so
 * a restart tries everything again. A fetch or extraction aborted by `stop` leaves its link a
 * candidate or its image pending, and nothing is counted or written after `stop`.
 */
export function createCopyPass(o: CopyPassOptions): CopyPass {
  const { copies, keeper, pages, extractor, limitBytes, dir, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 15_000;
  const pageSize = o.pageSize ?? 100;

  const sweepEveryMs = o.sweepEveryMs ?? 6 * 3_600_000;

  /** Links with a spent or running budget, by owner and link. Dropped only when the link is done. */
  const failures: Budget = new Map();
  /** Images with a spent or running budget, by owner, link and number. */
  const imageFailures: Budget = new Map();
  /** Copies whose finishing failed, with the time they are next tried. */
  const finishFailures = new Map<string, { attempts: number; retryAt: number }>();
  const unknownLogged = new Set<string>();
  let lastOrphanSweep: number | undefined;
  let level: "low" | "high" | "full" = "low";
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

  /** Runs an entry's last write, then drops its budget. */
  async function finish(budget: Budget, key: string, write: () => Promise<unknown>): Promise<void> {
    await write();
    budget.delete(key);
  }

  /** Counts a failed attempt: a backoff, or on the last one the entry's final write. */
  async function countFailure(
    budget: Budget,
    key: string,
    what: string,
    why: string,
    settle: () => Promise<unknown>,
  ): Promise<void> {
    const attempts = (budget.get(key)?.attempts ?? 0) + 1;
    log(`${what} ${key}: ${why} (attempt ${attempts})`);
    if (attempts < MAX_IMAGE_ATTEMPTS) {
      budget.set(key, { attempts, retryAt: now().getTime() + backoff(attempts), settle: false });
      return;
    }
    budget.set(key, { attempts, retryAt: 0, settle: true });
    await finish(budget, key, settle);
  }

  /** Records a link as having no copy. */
  async function recordNone(c: CopyCandidate, key: string): Promise<void> {
    await finish(failures, key, () => copies.recordNoCopy(c.owner, c.linkId, "none"));
  }

  /** The final write of a link whose budget is spent. */
  const settleLink = (c: CopyCandidate) => () => copies.recordNoCopy(c.owner, c.linkId, "failed");

  /** The final write of an image whose budget is spent. */
  const settleImage = (p: PendingCopyImage) => () =>
    copies.endCopyImage(p.owner, p.linkId, p.n, p.url, "none");

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
   * the sweep ends paused); otherwise the throw counts as one failed attempt, unless the entry was
   * already only waiting for its final write.
   */
  async function afterThrow(
    budget: Budget,
    key: string,
    what: string,
    error: unknown,
    settle: () => Promise<unknown>,
  ): Promise<boolean> {
    log(`${what} ${key}: a store call failed`, error);
    if (abort.signal.aborted || !(await folderReady())) return false;
    if (budget.get(key)?.settle) return true;
    try {
      await countFailure(budget, key, what, "a store call failed", settle);
    } catch (settleError) {
      log(`${what} ${key}: could not record the failure`, settleError);
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

  /**
   * Runs a writing phase. True when the sweep must end: the folder cannot be written to. A throw
   * that leaves the folder ready ends only this phase.
   */
  async function guarded(name: string, work: () => Promise<boolean>): Promise<boolean> {
    try {
      return await work();
    } catch (error) {
      log(`copy pass ${name} failed`, error);
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
            await finish(failures, key, settleLink(c));
            continue;
          }
          if (failed && now().getTime() < failed.retryAt) continue;
          if (await keeper.refuse(c.owner, c.linkId)) {
            failures.delete(key);
            continue;
          }
          fetched = true;
          const result = await attempt(c, key);
          if (result === "transient") {
            await countFailure(failures, key, "copy", "could not be copied", settleLink(c));
          }
          return result === "unavailable";
        } catch (error) {
          if (!(await afterThrow(failures, key, "copy", error, settleLink(c)))) return true;
          if (fetched) return false;
        }
      }
      if (rows.length < pageSize) return false;
      after = (rows.at(-1) as CopyCandidate).linkId;
      await nextTurn();
      if (quiet) return false;
    }
  }

  /** Fetches one pending image and records what came of it. "unavailable": the folder is not ready. */
  async function takeImage(p: PendingCopyImage, key: string): Promise<"unavailable" | undefined> {
    const { signal } = abort;
    const failed = imageFailures.get(key);
    if (failed?.settle) {
      await finish(imageFailures, key, settleImage(p));
      return;
    }
    if (failed && now().getTime() < failed.retryAt) return;
    const outcome = await o.images.fetch(p.url, signal);
    if (signal.aborted) return;
    const verdict = judgeImage(outcome);
    if ("abandon" in verdict) return;
    if ("store" in verdict && outcome.kind === "ok") {
      const { contentType, bytes } = outcome;
      const image = { contentType, bytes };
      const limits = copyLimits(limitBytes);
      const saved = await copies.saveCopyImage(p.owner, p.linkId, p.n, p.url, image, limits);
      if (saved === "unavailable") return "unavailable";
      imageFailures.delete(key);
      return;
    }
    if ("end" in verdict) {
      const { end } = verdict;
      await finish(imageFailures, key, () =>
        copies.endCopyImage(p.owner, p.linkId, p.n, p.url, end),
      );
      return;
    }
    await countFailure(imageFailures, key, "copy image", outcome.kind, settleImage(p));
  }

  /** The image phase, one image at a time. True when the sweep must end. */
  async function imagePages(): Promise<boolean> {
    const seen = new Set<string>();
    let after: { linkId: string; n: number } | null = null;
    for (;;) {
      const rows = await copies.pendingCopyImages(after, pageSize);
      for (const p of rows) {
        if (quiet) return false;
        const key = JSON.stringify([p.owner, p.linkId, p.n]);
        seen.add(key);
        try {
          if ((await takeImage(p, key)) === "unavailable") return true;
        } catch (error) {
          const settle = settleImage(p);
          if (!(await afterThrow(imageFailures, key, "copy image", error, settle))) return true;
        }
      }
      if (rows.length < pageSize) break;
      const last = rows[rows.length - 1] as PendingCopyImage;
      after = { linkId: last.linkId, n: last.n };
      await nextTurn();
      if (quiet) return false;
    }
    for (const key of imageFailures.keys()) if (!seen.has(key)) imageFailures.delete(key);
    return false;
  }

  /**
   * Calls `finishCopy`, giving up after `FINISH_TIMEOUT_MS` or on `stop`. A call left running gets
   * a `.catch` that logs, so its late failure is never unhandled.
   */
  async function finishWithin(c: CopyRef, key: string): Promise<boolean | "timeout" | "aborted"> {
    const call = copies.finishCopy(c.owner, c.linkId, finishedMarkdown, now());
    const { signal } = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const cut = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), FINISH_TIMEOUT_MS);
      onAbort = () => resolve("aborted");
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([call, cut]);
      if (typeof result === "string") {
        call.catch((error) => log(`copy ${key}: the abandoned finish failed`, error));
      }
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Puts a copy on the finishing backoff; the attempt number. */
  function backOffFinishing(key: string): number {
    const attempts = (finishFailures.get(key)?.attempts ?? 0) + 1;
    finishFailures.set(key, { attempts, retryAt: now().getTime() + backoff(attempts) });
    return attempts;
  }

  /** The finishing phase: copies whose images have all settled. */
  async function finishPages(): Promise<void> {
    const seen = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const rows = await copies.unfinishedCopies(after, pageSize);
      for (const c of rows) {
        if (quiet) return;
        const key = JSON.stringify([c.owner, c.linkId]);
        seen.add(key);
        const failed = finishFailures.get(key);
        if (failed && now().getTime() < failed.retryAt) continue;
        try {
          const result = await finishWithin(c, key);
          if (result === "aborted") return;
          if (result === "timeout") {
            log(`copy ${key}: finishing timed out`);
            backOffFinishing(key);
          } else if (result) {
            finishFailures.delete(key);
          } else {
            backOffFinishing(key);
          }
        } catch (error) {
          if (abort.signal.aborted) return;
          if (backOffFinishing(key) === 1) log(`copy ${key}: finishing failed`, error);
        }
      }
      if (rows.length < pageSize) break;
      after = (rows.at(-1) as CopyRef).linkId;
      await nextTurn();
      if (quiet) return;
    }
    for (const key of finishFailures.keys()) if (!seen.has(key)) finishFailures.delete(key);
  }

  /** Sweeps orphan files on the first sweep and then every `sweepEveryMs`. */
  async function orphanSweep(): Promise<void> {
    const at = now();
    if (lastOrphanSweep !== undefined && at.getTime() - lastOrphanSweep < sweepEveryMs) return;
    lastOrphanSweep = at.getTime();
    const report = await copies.sweep(ORPHAN_GRACE_MS, at);
    if (report.folders || report.temp || report.images) {
      log(
        `[saved copies] removed ${report.folders} stray folders, ${report.temp} temporary files and ${report.images} stray images`,
      );
    }
    for (const name of report.unknown) {
      if (unknownLogged.has(name)) continue;
      unknownLogged.add(name);
      log(`[saved copies] unexpected file in ${dir}: ${name}`);
    }
  }

  /** Logs when use crosses 80% of the limit, fills it, or falls back below 80%. */
  async function usage(): Promise<void> {
    if (!keeper.wanted) return;
    const used = await copies.usedBytes();
    const next =
      limitBytes - used < MAX_COPY_BYTES ? "full" : used >= 0.8 * limitBytes ? "high" : "low";
    if (next === level) return;
    level = next;
    if (next === "full") {
      log(
        "[saved copies] are full, so new links aren't getting one. Raise AYE_SAVED_COPY_LIMIT_GB or remove some copies.",
      );
    } else if (next === "high") {
      log(`[saved copies] use ${gib(used)} of ${gib(limitBytes)} GiB`);
    } else {
      log("[saved copies] back below 80% of the limit");
    }
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
    if (keeper.wanted) {
      if (await guarded("backfill", backfillPages)) return;
      if (quiet || (await guarded("images", imagePages))) return;
    }
    if (quiet) return;
    await phase("finishing", finishPages);
    if (quiet) return;
    await phase("orphan sweep", orphanSweep);
    if (quiet) return;
    await phase("usage", usage);
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
