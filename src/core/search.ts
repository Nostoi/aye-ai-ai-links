import type { LinkState, OwnerId } from "./types.js";

/**
 * The orders a blank query lists in: by save time newest or oldest first, or by the last
 * recorded opening, most recent first, which lists only links with a recorded opening.
 */
export const LINK_ORDERS = ["newest", "oldest", "opened"] as const;
export type LinkOrder = (typeof LINK_ORDERS)[number];

/**
 * Bounds are inclusive instants of `savedAt`, whatever the order; tag and project keys are
 * already normalized. `order` and `before` are for a blank query only, and `order` is newest
 * when left out. `before` keeps the links listed after a position in that order: `at` is the
 * time the order sorts by (`savedAt`, or `lastOpenedAt` for opened) and `id` one this store issued.
 */
export type SearchFilters = {
  tagKey?: string;
  projectKey?: string;
  savedFrom?: Date;
  savedTo?: Date;
  state?: LinkState;
  order?: LinkOrder;
  before?: { at: Date; id: string };
};

/**
 * Finds link ids. The implementation turns the raw `query` into engine syntax.
 *
 * - Owner-scoped: only the owner's links are returned.
 * - Ids come back best first.
 * - A blank query lists the owner's links that pass the filters in `order`, ties broken by id in
 *   the order the store issued them (later first for newest and opened, earlier first for
 *   oldest), so `before` pages through it.
 * - A non-blank query with `order` or `before` is refused with an Error.
 * - A non-blank query with no searchable word returns [].
 * - Links whose own title, summary, why or tags match come first, in keyword order; links found
 *   only through their page text or by meaning follow.
 * - Common English words (Lucene's stop list: "the", "that", "is", ...) do not count as keyword
 *   matches, unless the query has nothing else.
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

/**
 * Counts the owner's links that pass the filters and are in the order's list (for opened, the
 * links with a recorded opening): the links a blank query pages through, all pages together.
 */
export interface LinkCount {
  count(owner: OwnerId, filters: Omit<SearchFilters, "before">): Promise<number>;
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
