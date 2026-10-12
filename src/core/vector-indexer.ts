import { documentHash, linkDocument } from "./link-document.js";
import type { IndexRow, VectorIndexStore } from "./vector-index-store.js";

/** What the indexer needs from the embedder: search's `Embedder` satisfies it. */
export interface DocumentEmbedder {
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
}

/** The wait before a failed link is tried again, doubling per failure up to `RETRY_MAX_MS`. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 3_600_000;

export type VectorIndexerOptions = {
  store: VectorIndexStore;
  embedder: DocumentEmbedder;
  modelKey: string;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Time between sweeps. Default 15 s. */
  pollMs?: number;
  /** Links read per page. Default 100. */
  pageSize?: number;
};

export type VectorIndexer = {
  /** Retire other models' vectors, then sweep now and every `pollMs`. */
  start(): void;
  /** Take no new work: stop sweeping. An embedding in flight carries on and is written. */
  quiesce(): void;
  /** Quiesce, then wait for the sweep in flight, including its embedding, to end. */
  stop(): Promise<void>;
  /**
   * Embed every link whose document changed since its vector was stored, one document per
   * embedder call so a query waits behind at most one. Resolves when the sweep ends.
   */
  sweep(): Promise<void>;
};

type Failure = { hash: string; attempts: number; retryAt: number };

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Keeps `link_vectors` current for one model, in the background. Freshness is eventual: an
 * edit or a newly fetched page is embedded on a later sweep, and search uses the old vector,
 * or none, until then.
 *
 * A sweep is skipped when the store's change count is the one taken at the start of the last
 * complete sweep and no failure is waiting for a retry. A failed link is retried after its
 * backoff with no edit needed, or at once when its document changes.
 */
export function createVectorIndexer(o: VectorIndexerOptions): VectorIndexer {
  const { store, embedder, modelKey, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 15_000;
  const pageSize = o.pageSize ?? 100;

  /** Failed links waiting for a retry, by owner and link. */
  const failures = new Map<string, Failure>();
  /** The change count at the start of the last complete sweep; null until there is one. */
  let checkpoint: number | null = null;
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The startup retirement or sweep in flight. */
  let running: Promise<void> | undefined;

  const keyOf = (row: IndexRow) => JSON.stringify([row.owner, row.linkId]);

  /** Records a failed attempt for the link, so it waits out its backoff before the next. */
  function fail(key: string, hash: string): number {
    const prior = failures.get(key);
    const attempts = prior?.hash === hash ? prior.attempts + 1 : 1;
    const wait = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
    failures.set(key, { hash, attempts, retryAt: now().getTime() + wait });
    return attempts;
  }

  /** Embeds and writes one link. Throws only for a store error that should end the sweep. */
  async function index(row: IndexRow, key: string, hash: string, doc: string): Promise<void> {
    let vector: Float32Array | undefined;
    try {
      [vector] = await embedder.embedDocuments([doc]);
      if (!vector) throw new Error("The embedder returned no vector.");
    } catch (error) {
      log(`vector index ${key}: embedding failed (attempt ${fail(key, hash)})`, error);
      return;
    }
    try {
      await store.writeVector(row.owner, row.linkId, modelKey, hash, vector, now());
      failures.delete(key);
    } catch (error) {
      const attempts = fail(key, hash);
      // A rejected vector belongs to this link; any other store error ends the sweep.
      if (!(error instanceof RangeError)) throw error;
      log(`vector index ${key}: vector refused (attempt ${attempts})`, error);
    }
  }

  async function scan(): Promise<boolean> {
    const seen = new Set<string>();
    let afterId: string | null = null;
    for (;;) {
      const rows = await store.indexPage(modelKey, afterId, pageSize);
      for (const row of rows) {
        if (quiet) return false;
        const key = keyOf(row);
        seen.add(key);
        const doc = linkDocument(row);
        const hash = documentHash(modelKey, doc);
        if (hash === row.textHash) {
          failures.delete(key);
          continue;
        }
        const failed = failures.get(key);
        if (failed?.hash === hash && now().getTime() < failed.retryAt) continue;
        await index(row, key, hash, doc);
      }
      if (rows.length < pageSize) break;
      afterId = (rows.at(-1) as IndexRow).linkId;
      await nextTurn();
      if (quiet) return false;
    }
    for (const key of failures.keys()) if (!seen.has(key)) failures.delete(key);
    return true;
  }

  async function sweepOnce(): Promise<void> {
    if (quiet) return;
    try {
      const count = await store.changeCount();
      if (failures.size === 0 && count === checkpoint) return;
      const complete = await scan();
      if (complete) checkpoint = count;
    } catch (error) {
      log("vector index sweep failed", error);
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
      void exclusive(async () => {
        if (quiet) return;
        try {
          await store.retireModels(modelKey);
        } catch (error) {
          log("vector index: could not retire other models' vectors", error);
        }
      }).then(tick);
    },

    quiesce,

    async stop() {
      quiesce();
      await running;
    },

    sweep: () => exclusive(sweepOnce),
  };
}
