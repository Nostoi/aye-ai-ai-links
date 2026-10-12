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

/**
 * What a word query did, reported to `trace` once per call. `embedded` is the text that was
 * embedded, or null if none was; `similarity` holds the cosine similarity at search time of
 * each meaning candidate returned, by link id.
 */
export type SearchTrace = {
  mode: "keyword" | "hybrid" | "fallback";
  embedded: string | null;
  modelKey: string | null;
  similarity: Record<string, number>;
};
