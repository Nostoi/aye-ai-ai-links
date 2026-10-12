import type { OwnerId } from "./types.js";

/** Bounds are inclusive instants; tag and project keys are already normalized. */
export type SearchFilters = {
  tagKey?: string;
  projectKey?: string;
  savedFrom?: Date;
  savedTo?: Date;
};

/**
 * Finds link ids. The implementation turns the raw `query` into engine syntax.
 *
 * - Owner-scoped: only the owner's links are returned.
 * - Ids come back best first.
 * - A blank query lists the owner's links that pass the filters, newest first.
 * - A non-blank query with no searchable word returns [].
 * - Links whose own title, summary, why or tags match come first, in keyword order; links found
 *   only through their page text or by meaning follow.
 */
export interface LinkSearch {
  search(
    owner: OwnerId,
    query: string,
    filters: SearchFilters,
    limit: number,
    trace?: (t: SearchTrace) => void,
  ): Promise<string[]>;
}

/** A returned link's 1-based place in each list that found it. */
export type ListRanks = { field?: number; page?: number; meaning?: number };

/**
 * What a word query did, reported to `trace` once per call. `embedded` is the text sent to the
 * embedder (the query capped at 500 code points), or null if nothing was sent; on a fallback it
 * is kept so the failed search can be replayed. `similarity` holds the cosine similarity at
 * search time of each meaning candidate returned, by link id. `meaningCandidates` is the number
 * of rows the vector lookup returned, before owner-field hits are removed. It is 0 in `keyword`
 * and `fallback` modes, and in `hybrid` mode it is 0 when no stored vector passed the filters.
 * `ranks` holds the 1-based rank of each returned link in the owner-field, page-only and meaning
 * lists it came from; the meaning rank is counted after owner-field hits are removed.
 */
export type SearchTrace = {
  mode: "keyword" | "hybrid" | "fallback";
  embedded: string | null;
  modelKey: string | null;
  similarity: Record<string, number>;
  meaningCandidates: number;
  ranks: Record<string, ListRanks>;
};
