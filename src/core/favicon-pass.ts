import type { FaviconStore, PendingFavicon } from "./favicon-store.js";
import type { ImageFetcher } from "./fetch.js";
import { judgeImage, MAX_IMAGE_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_MS } from "./image-indexer.js";
import { faviconBigEnough } from "./image-type.js";

export type FaviconPassOptions = {
  store: FaviconStore;
  /** The guarded image fetcher the image pass uses: the same address rules, redirects and caps. */
  fetcher: ImageFetcher;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Time between sweeps. Default 15 s. */
  pollMs?: number;
  /** Pending favicons read per page. Default 100. */
  pageSize?: number;
};

export type FaviconPass = {
  /** Sweep now and every `pollMs`. */
  start(): void;
  /** Take no new work: stop sweeping. A fetch in flight carries on and is written. */
  quiesce(): void;
  /** Quiesce, abort the fetch in flight, and wait for the sweep to end. Writes nothing for it. */
  stop(): Promise<void>;
  /** Fetch every pending favicon whose backoff has passed, one at a time. Resolves when it ends. */
  sweep(): Promise<void>;
};

type Failure = { attempts: number; retryAt: number };

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Fetches and stores each link's site favicon (#272) in the background, apart from the image pass
 * and the link's one picture.
 *
 * A pending favicon's candidates are tried in order, through the guarded image fetcher, until one
 * is an image at least `FAVICON_MIN_PX` on its shorter side; that one is stored. When none is:
 * if a candidate failed in a way that may pass (a network error, a timeout, 408, 429 or 5xx), the
 * favicon waits out a backoff and all are tried again, ending as `none` on the
 * `MAX_IMAGE_ATTEMPTS`th such sweep; otherwise it ends at once, as `refused` when every candidate
 * was refused by the address rules, else `none`. Every write carries the generation it read, so
 * a fetch begun before the candidates were rewritten writes nothing. Backoffs are kept in memory,
 * so a restart tries every pending favicon again. A fetch aborted by `stop` writes nothing.
 */
export function createFaviconPass(o: FaviconPassOptions): FaviconPass {
  const { store, fetcher, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 15_000;
  const pageSize = o.pageSize ?? 100;

  /** Favicons waiting out a backoff, by owner, link and generation. */
  const failures = new Map<string, Failure>();
  const abort = new AbortController();
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sweep in flight. */
  let running: Promise<void> | undefined;

  const keyOf = (p: PendingFavicon) => JSON.stringify([p.owner, p.linkId, p.generation]);

  /** Tries one favicon's candidates and records what came of them. Throws only for a store error. */
  async function take(p: PendingFavicon, key: string): Promise<void> {
    let mayPass = false;
    let allRefused = true;
    for (const url of p.urls) {
      const outcome = await fetcher.fetch(url, abort.signal);
      const verdict = judgeImage(outcome);
      if ("abandon" in verdict) return;
      if (outcome.kind === "ok" && faviconBigEnough(outcome.bytes)) {
        const { contentType, bytes } = outcome;
        await store.writeFavicon(p.owner, p.linkId, p.generation, { contentType, bytes }, now());
        failures.delete(key);
        return;
      }
      if ("retry" in verdict) mayPass = true;
      if (!("end" in verdict && verdict.end === "refused")) allRefused = false;
    }
    if (mayPass) {
      const attempts = (failures.get(key)?.attempts ?? 0) + 1;
      log(`favicon ${key}: a candidate may pass later (attempt ${attempts})`);
      if (attempts < MAX_IMAGE_ATTEMPTS) {
        const wait = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
        failures.set(key, { attempts, retryAt: now().getTime() + wait });
        return;
      }
    }
    await store.endFavicon(p.owner, p.linkId, p.generation, allRefused ? "refused" : "none");
    failures.delete(key);
  }

  async function scan(): Promise<void> {
    const seen = new Set<string>();
    let afterId: string | null = null;
    for (;;) {
      const rows = await store.pendingFavicons(afterId, pageSize);
      for (const row of rows) {
        if (quiet) return;
        const key = keyOf(row);
        seen.add(key);
        const failed = failures.get(key);
        if (failed && now().getTime() < failed.retryAt) continue;
        await take(row, key);
      }
      if (rows.length < pageSize) break;
      afterId = (rows.at(-1) as PendingFavicon).linkId;
      await nextTurn();
      if (quiet) return;
    }
    for (const key of failures.keys()) if (!seen.has(key)) failures.delete(key);
  }

  async function sweepOnce(): Promise<void> {
    if (quiet) return;
    try {
      await scan();
    } catch (error) {
      log("favicon pass sweep failed", error);
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
