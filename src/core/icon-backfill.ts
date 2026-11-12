import type { PageExtractor, PageMetadata } from "./extract.js";
import type { PageFetcher } from "./fetch.js";
import type { FaviconCandidate, IconBackfillStore, IconCandidate } from "./icon-backfill-store.js";
import { MAX_IMAGE_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_MS } from "./image-indexer.js";
import { type AttemptOutcome, outcomeFavicons, transientFetch } from "./snapshot-outcome.js";
import { boundedFaviconUrls, boundedIconUrls } from "./snapshot-store.js";
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

/** The kinds of candidate, in the order they are looked at. */
type Kind = "wordPicture" | "icons" | "favicon";

/** A link to read, and how what was found is recorded. */
type Job = {
  c: IconCandidate;
  kind: Kind;
  /** Its failure budget: by kind as well as owner and link. */
  key: string;
  /** `favicons` is null when no page metadata was read (#272). */
  write: (icons: string[], favicons: string[] | null) => Promise<boolean>;
};

const backoff = (attempts: number) => Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Reads, in the background, the pages of three kinds of link: one page per sweep, through the page
 * fetcher and the pass's own extractor. It never re-runs a snapshot.
 *
 * - First, a link on a word-picture host whose snapshot still names a preview (#193): saved before
 *   that rule, or restored by a delete's Undo. Its page is read afresh, so its icons are the
 *   page's current ones; the preview and its fetched picture are dropped, and the icons recorded.
 *   When its page's metadata was read, its favicon candidates are rewritten in the same write (#272).
 * - Then, a link snapshotted before icons were looked for (#149). It records the page's icons
 *   when it names no preview, else none. When its metadata was read it also hands over the page's
 *   favicon candidates, which are written only while the link has no favicon row or a stale
 *   unsuccessful one (#272).
 * - Last, a link with a terminal snapshot and no favicon row, or a `none`/`refused` one from an
 *   older discovery version (#272): saved before favicons, or whose icon check could not read
 *   its page. It records `outcomeFavicons` of what its page came to, so a short link that ends at
 *   a PDF or an HTTP error gets the destination's root guesses. A fetch failure that may pass
 *   backs off, and on its last attempt it records what the outcome gives instead of parking the
 *   link. An extraction that fails on the page's content is recorded at once. A child that could
 *   not run and an abort nobody asked for are faults of the machine, not the page: they back off
 *   and are never recorded.
 *
 * The image pass then fetches a recorded icon, and the favicon pass a recorded favicon. Every
 * attempt either records the link, which ends its candidacy for that kind, or backs it off, so
 * no sweep fetches the same page as the last. Each kind keeps its own budget per link: one that
 * fails `MAX_IMAGE_ATTEMPTS` times (a child that could not run, an abort nobody asked for, a store
 * write that failed) is left alone for the life of the process, with nothing written (the favicon
 * kind's passing fetch failures aside, as above). While the network is down a link only waits. Backoffs are kept in
 * memory, so a restart tries those links again. `stop` writes nothing for the attempt it cuts off.
 */
export function createIconBackfill(o: IconBackfillOptions): IconBackfill {
  const { store, pages, extractor, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 15_000;
  const pageSize = o.pageSize ?? 100;

  /** Links waiting out a backoff, by kind, owner and link. */
  const failures = new Map<string, Failure>();
  const abort = new AbortController();
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sweep in flight. */
  let running: Promise<void> | undefined;

  const keyOf = (kind: Kind, c: IconCandidate) => JSON.stringify([kind, c.owner, c.linkId]);

  async function record(job: Job, icons: string[], favicons: string[] | null): Promise<Attempt> {
    try {
      return (await job.write(icons, favicons))
        ? { kind: "recorded" }
        : { kind: "failed", why: "the store refused the check" };
    } catch (error) {
      return { kind: "failed", why: "a store call failed", error };
    }
  }

  /** Fetches and reads one candidate's page and records what came of it. */
  async function attempt(job: Job): Promise<Attempt> {
    const { c, kind } = job;
    const { signal } = abort;
    const settle = (outcome: AttemptOutcome) => record(job, [], outcomeFavicons(outcome));
    // The favicon kind settles on its last attempt rather than parking the link unrecorded.
    const lastTry =
      kind === "favicon" && (failures.get(job.key)?.attempts ?? 0) + 1 >= MAX_IMAGE_ATTEMPTS;
    const mayPass = (why: string, outcome: AttemptOutcome): Promise<Attempt> | Attempt =>
      lastTry ? settle(outcome) : { kind: "failed", why };

    const page = await pages.fetch(c.url, signal);
    if (signal.aborted) return { kind: "stopped" };
    if (page.kind !== "ok") {
      const outcome: AttemptOutcome = { stage: "fetch", fetch: page };
      if (page.kind === "aborted") return { kind: "failed", why: "fetch:aborted" };
      if (page.kind === "network_error" || page.kind === "timeout") {
        const up = await o.canResolve(signal);
        if (signal.aborted) return { kind: "stopped" };
        if (!up) return { kind: "offline" };
      }
      if (kind !== "icons" && transientFetch(page)) return mayPass(`fetch:${page.kind}`, outcome);
      return kind === "favicon" ? settle(outcome) : record(job, [], null);
    }
    const out = await extractor.extract(page.html, page.finalUrl, signal);
    if (signal.aborted) return { kind: "stopped" };
    const outcome: AttemptOutcome = { stage: "extract", extract: out };
    if (out.kind === "aborted") return { kind: "failed", why: "extract:aborted" };
    if (out.kind === "spawn_failed") {
      return { kind: "failed", why: `extract:spawn_failed:${out.detail}` };
    }
    if (kind === "favicon") return settle(outcome);
    if (kind === "wordPicture" && out.kind !== "ok" && out.metadata === null) {
      return { kind: "failed", why: `extract:${out.kind}` };
    }
    const favicons = out.metadata ? boundedFaviconUrls(out.metadata.faviconUrls) : null;
    return record(job, iconsToRecord(c.url, out.metadata), favicons);
  }

  /** Attempts one candidate and books the result: done, a backoff, or the end of its budget. */
  async function take(job: Job): Promise<void> {
    const { key } = job;
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
    kind: Kind,
    read: (afterId: string | null, limit: number) => Promise<C[]>,
    wanted: (c: C) => boolean,
    write: (c: C) => Job["write"],
  ): Promise<boolean> {
    let after: string | null = null;
    for (;;) {
      const rows = await read(after, pageSize);
      for (const c of rows) {
        if (quiet) return true;
        if (!wanted(c)) continue;
        const key = keyOf(kind, c);
        const failed = failures.get(key);
        if (failed && now().getTime() < failed.retryAt) continue;
        await take({ c, kind, key, write: write(c) });
        return true;
      }
      if (rows.length < pageSize) return false;
      after = (rows.at(-1) as C).linkId;
      await nextTurn();
      if (quiet) return true;
    }
  }

  /** One sweep: at most one page fetch, word-picture links first, favicons last. */
  async function scan(): Promise<void> {
    const tookOne = await scanFor(
      "wordPicture",
      (afterId, limit) => store.wordPictureCandidates(afterId, limit),
      (c) => isWordPictureHost(c.url),
      (c) => (icons, favicons) =>
        store.recordWordPictureCheck(c.owner, c.linkId, c.imageUrl, icons, favicons),
    );
    if (tookOne) return;
    const tookIcons = await scanFor(
      "icons",
      (afterId, limit) => store.iconCandidates(afterId, limit),
      () => true,
      (c) => (icons, favicons) => store.recordIconCheck(c.owner, c.linkId, icons, favicons),
    );
    if (tookIcons) return;
    await scanFor<FaviconCandidate>(
      "favicon",
      (afterId, limit) => store.faviconCandidates(afterId, limit),
      () => true,
      (c) => (_icons, favicons) =>
        store.recordFaviconCheck(c.owner, c.linkId, c.generation, favicons ?? []),
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
