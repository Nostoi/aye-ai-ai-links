import type { PageExtractor, PageMetadata } from "./extract.js";
import type { PageFetcher } from "./fetch.js";
import type { IconBackfillStore, IconCandidate } from "./icon-backfill-store.js";
import { MAX_IMAGE_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_MS } from "./image-indexer.js";
import { transientFetch } from "./snapshot-outcome.js";
import { boundedIconUrls } from "./snapshot-store.js";
import { isWordPictureHost, keptPreview } from "./word-picture-host.js";

export type IconBackfillOptions = {
  store: IconBackfillStore;
  pages: PageFetcher;
  /** The pass's own extractor. */
  extractor: PageExtractor;
  canResolve: (signal?: AbortSignal) => Promise<boolean>;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Time between sweeps. Default 15 s. */
  pollMs?: number;
  /** Candidates read per page. Default 100. */
  pageSize?: number;
};

export type IconBackfill = {
  /** Sweep now and every `pollMs`. */
  start(): void;
  /** Take no new work: stop sweeping. An attempt in flight carries on. */
  quiesce(): void;
  /** Quiesce, abort the fetch or extraction in flight, and wait for the sweep to end. Writes nothing for it. */
  stop(): Promise<void>;
  /** One sweep. Resolves when it ends. */
  sweep(): Promise<void>;
};

/**
 * The icons to record from the metadata of a page saved at `url`: none when it was not read, or
 * when it names a preview that is kept (`keptPreview`).
 */
export function iconsToRecord(url: string, metadata: PageMetadata | null): string[] {
  if (metadata === null || keptPreview(url, metadata.imageUrl ?? null) !== null) return [];
  return boundedIconUrls(metadata.iconUrls);
}

/** What one attempt came to: recorded, cut off by `stop`, the network down, or a failure of the link. */
type Attempt =
  | { kind: "recorded" }
  | { kind: "stopped" }
  | { kind: "offline" }
  | { kind: "failed"; why: string; error?: unknown };

type Failure = { attempts: number; retryAt: number };

/** A link to read for its icons, and how what was found is recorded. */
type Job = {
  c: IconCandidate;
  write: (icons: string[]) => Promise<boolean>;
  /** Back off, recording nothing, after a fetch failure that may pass (`transientFetch`). */
  keepOnTransient: boolean;
};

const backoff = (attempts: number) => Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Reads, in the background, the pages of two kinds of link for their icons: one page per sweep,
 * through the page fetcher and the pass's own extractor. It never re-runs a snapshot.
 *
 * - First, a link on a word-picture host whose snapshot still names a preview (#193): saved before
 *   that rule, or restored by a delete's Undo. Its page is read afresh, so its icons are the
 *   page's current ones; the preview and its fetched picture are dropped, and the icons recorded.
 * - Then, a link snapshotted before icons were looked for (#149). It records the page's icons
 *   when it names no preview, else none.
 *
 * The image pass then fetches a recorded icon. Every attempt either records the link, which ends
 * its candidacy for good, or backs it off, so no sweep fetches the same page as the last. A link
 * that fails `MAX_IMAGE_ATTEMPTS` times (a child that could not run, an abort nobody asked for, a
 * store write that failed) is left alone for the life of the process, with nothing written. While
 * the network is down a link only waits. Backoffs are kept in memory, so a restart tries those
 * links again. `stop` writes nothing for the attempt it cuts off.
 */
export function createIconBackfill(o: IconBackfillOptions): IconBackfill {
  const { store, pages, extractor, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 15_000;
  const pageSize = o.pageSize ?? 100;

  /** Links waiting out a backoff, by owner and link. */
  const failures = new Map<string, Failure>();
  const abort = new AbortController();
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sweep in flight. */
  let running: Promise<void> | undefined;

  const keyOf = (c: IconCandidate) => JSON.stringify([c.owner, c.linkId]);

  async function record(job: Job, icons: string[]): Promise<Attempt> {
    try {
      return (await job.write(icons))
        ? { kind: "recorded" }
        : { kind: "failed", why: "the store refused the check" };
    } catch (error) {
      return { kind: "failed", why: "a store call failed", error };
    }
  }

  /** Fetches and reads one candidate's page and records what came of it. */
  async function attempt(job: Job): Promise<Attempt> {
    const { c } = job;
    const { signal } = abort;
    const page = await pages.fetch(c.url, signal);
    if (signal.aborted) return { kind: "stopped" };
    if (page.kind === "aborted") return { kind: "failed", why: "fetch:aborted" };
    if (page.kind !== "ok") {
      if (page.kind === "network_error" || page.kind === "timeout") {
        const up = await o.canResolve(signal);
        if (signal.aborted) return { kind: "stopped" };
        if (!up) return { kind: "offline" };
      }
      if (job.keepOnTransient && transientFetch(page)) {
        return { kind: "failed", why: `fetch:${page.kind}` };
      }
      return record(job, []);
    }
    const out = await extractor.extract(page.html, page.finalUrl, signal);
    if (signal.aborted) return { kind: "stopped" };
    if (out.kind === "aborted") return { kind: "failed", why: "extract:aborted" };
    if (out.kind === "spawn_failed") {
      return { kind: "failed", why: `extract:spawn_failed:${out.detail}` };
    }
    if (job.keepOnTransient && out.kind !== "ok" && out.metadata === null) {
      return { kind: "failed", why: `extract:${out.kind}` };
    }
    return record(job, iconsToRecord(c.url, out.metadata));
  }

  /** Attempts one candidate and books the result: done, a backoff, or the end of its budget. */
  async function take(job: Job, key: string): Promise<void> {
    const result = await attempt(job);
    if (result.kind === "stopped") return;
    if (result.kind === "recorded") {
      failures.delete(key);
      return;
    }
    const before = failures.get(key)?.attempts ?? 0;
    const at = now().getTime();
    if (result.kind === "offline") {
      failures.set(key, { attempts: before, retryAt: at + backoff(Math.max(before, 1)) });
      return;
    }
    const attempts = before + 1;
    const message = `icon backfill ${key}: ${result.why} (attempt ${attempts})`;
    if (result.error === undefined) log(message);
    else log(message, result.error);
    const retryAt =
      attempts < MAX_IMAGE_ATTEMPTS ? at + backoff(attempts) : Number.POSITIVE_INFINITY;
    failures.set(key, { attempts, retryAt });
  }

  /**
   * Pages through one kind of candidate from the first, and attempts the first that `wanted`
   * keeps and is not waiting out a backoff. True when it attempted one, or the pass went quiet.
   */
  async function scanFor<C extends IconCandidate>(
    read: (afterId: string | null, limit: number) => Promise<C[]>,
    wanted: (c: C) => boolean,
    write: (c: C) => Job["write"],
    keepOnTransient: boolean,
  ): Promise<boolean> {
    let after: string | null = null;
    for (;;) {
      const rows = await read(after, pageSize);
      for (const c of rows) {
        if (quiet) return true;
        if (!wanted(c)) continue;
        const key = keyOf(c);
        const failed = failures.get(key);
        if (failed && now().getTime() < failed.retryAt) continue;
        await take({ c, write: write(c), keepOnTransient }, key);
        return true;
      }
      if (rows.length < pageSize) return false;
      after = (rows.at(-1) as C).linkId;
      await nextTurn();
      if (quiet) return true;
    }
  }

  /** One sweep: at most one page fetch, word-picture links first. */
  async function scan(): Promise<void> {
    const tookOne = await scanFor(
      (afterId, limit) => store.wordPictureCandidates(afterId, limit),
      (c) => isWordPictureHost(c.url),
      (c) => (icons) => store.recordWordPictureCheck(c.owner, c.linkId, c.imageUrl, icons),
      true,
    );
    if (tookOne) return;
    await scanFor(
      (afterId, limit) => store.iconCandidates(afterId, limit),
      () => true,
      (c) => (icons) => store.recordIconCheck(c.owner, c.linkId, icons),
      false,
    );
  }

  async function sweepOnce(): Promise<void> {
    if (quiet) return;
    try {
      await scan();
    } catch (error) {
      log("icon backfill sweep failed", error);
    }
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
