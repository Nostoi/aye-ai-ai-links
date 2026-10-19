import type { ImageFetcher, ImageOutcome } from "./fetch.js";
import type { ImageEnd, ImageStore, PendingImage } from "./image-store.js";
import { iconBigEnough } from "./image-type.js";

/** The wait before a failed image is tried again, doubling per failure up to `RETRY_MAX_MS`. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 3_600_000;
/** A transient failure on this attempt ends the image as `none`. */
export const MAX_IMAGE_ATTEMPTS = 5;

export type ImageIndexerOptions = {
  store: ImageStore;
  fetcher: ImageFetcher;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Time between sweeps. Default 15 s. */
  pollMs?: number;
  /** Pending images read per page. Default 100. */
  pageSize?: number;
};

export type ImageIndexer = {
  /** Sweep now and every `pollMs`. */
  start(): void;
  /** Take no new work: stop sweeping. A fetch in flight carries on and is written. */
  quiesce(): void;
  /** Quiesce, abort the fetch in flight, and wait for the sweep to end. Writes nothing for it. */
  stop(): Promise<void>;
  /** Fetch every pending image whose backoff has passed, one at a time. Resolves when it ends. */
  sweep(): Promise<void>;
};

export type ImageVerdict =
  | { store: true }
  | { end: ImageEnd }
  | { retry: true }
  | { abandon: true };

/** What an outcome means for the image: stored, ended for good, tried again, or left as it is. */
export function judgeImage(outcome: ImageOutcome): ImageVerdict {
  switch (outcome.kind) {
    case "ok":
      return { store: true };
    case "refused":
      return { end: "refused" };
    case "not_image":
    case "too_large":
      return { end: "none" };
    case "http_error": {
      const s = outcome.status;
      return s === 408 || s === 429 || s >= 500 ? { retry: true } : { end: "none" };
    }
    case "network_error":
    case "timeout":
      return { retry: true };
    case "aborted":
      return { abandon: true };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

type Failure = { attempts: number; retryAt: number };

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Fetches and stores the preview image, or the site's icon, of every link whose snapshot named one, in the background
 * and apart from the snapshot jobs, so a save never waits for an image.
 *
 * An image is fetched at least once, until it is stored or ends: a refusal, a non-image, a body
 * too large or a 4xx ends it at once; a network error, timeout, 408, 429 or 5xx is tried again
 * after a backoff, and ends as `none` on its `MAX_IMAGE_ATTEMPTS`th failure. Backoffs are kept
 * in memory, so a restart tries every pending image again. A fetch aborted by `stop` leaves its
 * image pending. An icon smaller than `ICON_MIN_PX` on its shorter side ends as `none`. When an
 * icon ends, the store makes the snapshot's second icon pending, which a later sweep fetches with
 * a fresh backoff.
 */
export function createImageIndexer(o: ImageIndexerOptions): ImageIndexer {
  const { store, fetcher, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 15_000;
  const pageSize = o.pageSize ?? 100;

  /** Images waiting out a backoff, by owner, link and URL. */
  const failures = new Map<string, Failure>();
  const abort = new AbortController();
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sweep in flight. */
  let running: Promise<void> | undefined;

  const keyOf = (p: PendingImage) => JSON.stringify([p.owner, p.linkId, p.imageUrl, p.role]);

  /** Fetches one image and records what came of it. Throws only for a store error. */
  async function take(p: PendingImage, key: string): Promise<void> {
    const outcome = await fetcher.fetch(p.imageUrl, abort.signal);
    const verdict = judgeImage(outcome);
    if ("abandon" in verdict) return;
    if ("store" in verdict && outcome.kind === "ok") {
      const { contentType, bytes } = outcome;
      if (p.role === "icon" && !iconBigEnough(bytes)) {
        await store.endImage(p.owner, p.linkId, p.imageUrl, p.role, "none");
      } else {
        await store.writeImage(
          p.owner,
          p.linkId,
          p.imageUrl,
          p.role,
          { contentType, bytes },
          now(),
        );
      }
      failures.delete(key);
      return;
    }
    if ("retry" in verdict) {
      const attempts = (failures.get(key)?.attempts ?? 0) + 1;
      log(`image ${key}: ${outcome.kind} (attempt ${attempts})`);
      if (attempts < MAX_IMAGE_ATTEMPTS) {
        const wait = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
        failures.set(key, { attempts, retryAt: now().getTime() + wait });
        return;
      }
    }
    await store.endImage(
      p.owner,
      p.linkId,
      p.imageUrl,
      p.role,
      "end" in verdict ? verdict.end : "none",
    );
    failures.delete(key);
  }

  async function scan(): Promise<boolean> {
    const seen = new Set<string>();
    let afterId: string | null = null;
    for (;;) {
      const rows = await store.pendingImages(afterId, pageSize);
      for (const row of rows) {
        if (quiet) return false;
        const key = keyOf(row);
        seen.add(key);
        const failed = failures.get(key);
        if (failed && now().getTime() < failed.retryAt) continue;
        await take(row, key);
      }
      if (rows.length < pageSize) break;
      afterId = (rows.at(-1) as PendingImage).linkId;
      await nextTurn();
      if (quiet) return false;
    }
    for (const key of failures.keys()) if (!seen.has(key)) failures.delete(key);
    return true;
  }

  async function sweepOnce(): Promise<void> {
    if (quiet) return;
    try {
      await scan();
    } catch (error) {
      log("image pass sweep failed", error);
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
