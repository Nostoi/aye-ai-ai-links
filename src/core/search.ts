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
 */
export interface LinkSearch {
  search(owner: OwnerId, query: string, filters: SearchFilters, limit: number): Promise<string[]>;
}
