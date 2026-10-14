import type { LinkSearch, ListRanks, SearchFilters, SearchTrace } from "../core/search.js";
import type { OwnerId } from "../core/types.js";
import type { Embedder } from "./embedder.js";
import { checkedKind, type FtsSearch } from "./fts-search.js";
import { listRanks } from "./list-ranks.js";
import type { VectorSearch } from "./vector-search.js";

type Keyword = Pick<FtsSearch, "search" | "parts">;
type Vectors = Pick<VectorSearch, "nearest">;

/** Code points of the query that are embedded. */
const QUERY_CHARS = 500;
/**
 * How long a search waits for its query embedding before using the keyword results. It bounds
 * waiting on async work (a queue stuck behind a hung inference) only: a timer cannot interrupt
 * an inference that holds the thread.
 */
export const QUERY_EMBED_MS = 2_000;
const RRF_K = 60;
const DEPTH_FACTOR = 3;
const MAX_DEPTH = 150;

const capQuery = (query: string): string => {
  let end = 0;
  for (let n = 0; n < QUERY_CHARS && end < query.length; n++) {
    end += (query.codePointAt(end) as number) > 0xffff ? 2 : 1;
  }
  return query.slice(0, end);
};

/**
 * `work`, or a rejection with the signal's reason once it aborts, whichever comes first. A
 * rejection `work` makes after losing is handled here, so it cannot crash the process.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Keyword search with meaning search behind it. Links whose own fields match keep their keyword
 * order at the top; the rest (page-text hits and nearest-by-meaning hits) are ranked by
 * reciprocal rank fusion. If the embedding fails or takes over `QUERY_EMBED_MS`, or the vector
 * lookup fails, the answer is the keyword search's.
 */
export class HybridSearch implements LinkSearch {
  constructor(
    private readonly fts: Keyword,
    private readonly vectors: Vectors,
    private readonly embedder: Embedder,
    private readonly modelKey: string,
    private readonly log: (...args: unknown[]) => void = console.error,
  ) {}

  async search(
    owner: OwnerId,
    query: string,
    filters: SearchFilters,
    limit: number,
    trace?: (t: SearchTrace) => void,
  ): Promise<string[]> {
    const kind = checkedKind(query, filters);
    if (kind === "blank") return this.fts.search(owner, query, filters, limit);
    if (kind === "no_words") return [];

    const depth = Math.min(DEPTH_FACTOR * limit, MAX_DEPTH);
    const { fields, pageOnly } = this.fts.parts(owner, query, filters, limit, depth);
    if (fields.length >= limit) {
      trace?.({
        mode: "keyword",
        embedded: null,
        modelKey: null,
        similarity: {},
        meaningCandidates: 0,
        ranks: listRanks(fields, { field: fields }),
      });
      return fields.slice(0, limit);
    }

    let embedded: string | null = null;
    let fused: Fused;
    let meaningCandidates: number;
    try {
      embedded = capQuery(query);
      const signal = AbortSignal.timeout(QUERY_EMBED_MS);
      const vector = await untilAborted(this.embedder.embedQuery(embedded, signal), signal);
      const nearest = this.vectors.nearest(owner, vector, filters, depth);
      meaningCandidates = nearest.length;
      fused = fuse(fields, pageOnly, nearest, limit);
    } catch (error) {
      this.log("[search] meaning search failed; using keyword results:", error);
      const ids = [...fields, ...pageOnly].slice(0, limit);
      trace?.({
        mode: "fallback",
        embedded,
        modelKey: this.modelKey,
        similarity: {},
        meaningCandidates: 0,
        ranks: listRanks(ids, { field: fields, page: pageOnly }),
      });
      return ids;
    }
    trace?.({
      mode: "hybrid",
      embedded,
      modelKey: this.modelKey,
      similarity: fused.similarity,
      meaningCandidates,
      ranks: fused.ranks,
    });
    return fused.ids;
  }
}

type Fused = {
  ids: string[];
  similarity: Record<string, number>;
  ranks: Record<string, ListRanks>;
};

type Candidate = { id: string; score: number; best: number };

/** `fields` first, then the page-only and meaning candidates ordered by reciprocal rank fusion. */
function fuse(
  fields: string[],
  pageOnly: string[],
  nearest: { id: string; similarity: number }[],
  limit: number,
): Fused {
  const owned = new Set(fields);
  const meaning = nearest.filter((n) => !owned.has(n.id));
  const byId = new Map<string, Candidate>();
  const add = (id: string, rank: number) => {
    const c = byId.get(id) ?? { id, score: 0, best: Number.POSITIVE_INFINITY };
    c.score += 1 / (RRF_K + rank);
    c.best = Math.min(c.best, rank);
    byId.set(id, c);
  };
  for (const [i, id] of pageOnly.entries()) add(id, i + 1);
  for (const [i, n] of meaning.entries()) add(n.id, i + 1);

  const rest = [...byId.values()].sort(
    (a, b) => b.score - a.score || a.best - b.best || Number(b.id) - Number(a.id),
  );
  const ids = [...fields, ...rest.map((c) => c.id)].slice(0, limit);
  const returned = new Set(ids);
  const similarity: Record<string, number> = {};
  for (const n of meaning) if (returned.has(n.id)) similarity[n.id] = n.similarity;
  return {
    ids,
    similarity,
    ranks: listRanks(ids, { field: fields, page: pageOnly, meaning: meaning.map((n) => n.id) }),
  };
}
