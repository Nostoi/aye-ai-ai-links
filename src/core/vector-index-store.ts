import type { DocumentInput } from "./link-document.js";
import type { OwnerId } from "./types.js";

/** One link as the indexer reads it: what its document is built from, and its stored hash. */
export type IndexRow = DocumentInput & {
  owner: OwnerId;
  linkId: string;
  /** The `text_hash` stored for the model asked about, or null when it has no vector. */
  textHash: string | null;
};

/**
 * Persistence contract for the meaning-search index. Any implementation must meet all of it.
 *
 * - Owner scoping: `writeVector` takes the owner and never writes another owner's link.
 *   `indexPage` and `retireModels` are the exceptions: cross-owner maintenance for the
 *   indexer, never for a request.
 * - Ids: those of `LinkStore`. An id never issued, or one owned by someone else, yields false,
 *   never an error.
 */
export interface VectorIndexStore {
  /**
   * Cross-owner read. Up to `limit` links of every owner, archived ones included, with ids
   * greater than `afterId` (all when null), in id order. `pageText` is at most `PAGE_CHARS`
   * code points; tags are in the link's order.
   */
  indexPage(modelKey: string, afterId: string | null, limit: number): Promise<IndexRow[]>;

  /**
   * Store the link's vector for `modelKey`, replacing any earlier one. Rejects with a
   * `RangeError`, writing nothing, unless the vector has exactly the store's dimensions, every
   * value is finite and its length is within 1e-3 of 1. Returns false, writing nothing, when
   * the owner has no such link.
   */
  writeVector(
    owner: OwnerId,
    linkId: string,
    modelKey: string,
    textHash: string,
    vector: Float32Array,
    at: Date,
  ): Promise<boolean>;

  /** Cross-owner delete of every vector whose model is not `currentKey`. Returns how many. */
  retireModels(currentKey: string): Promise<number>;

  /**
   * A number that changes whenever anything is written through this store's connection
   * (SQLite `total_changes()`). Unrelated writes change it too; it is only a cheap "maybe".
   */
  changeCount(): Promise<number>;
}
