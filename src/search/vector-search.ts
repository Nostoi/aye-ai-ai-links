import type { Database } from "better-sqlite3";
import { load } from "sqlite-vec";
import type { SearchFilters } from "../core/search.js";
import type { OwnerId } from "../core/types.js";
import { scope } from "./scope.js";

/** Add sqlite-vec's functions (`vec_distance_cosine`) to a connection. */
export function loadVectorFunctions(db: Database): void {
  load(db);
}

/**
 * The links nearest a query vector, by cosine similarity, among those embedded with one model.
 * Holds no ranking rules: the owner, tag, project and date filters apply before the top-k cut,
 * and ties go to the newest link. Needs `loadVectorFunctions` on the connection.
 */
export class VectorSearch {
  constructor(
    private readonly db: Database,
    private readonly modelKey: string,
  ) {}

  nearest(
    owner: OwnerId,
    vector: Float32Array,
    filters: SearchFilters,
    k: number,
  ): { id: string; similarity: number }[] {
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const q = scope("l.owner_id", owner, filters);
    const rows = this.db
      .prepare(
        `SELECT l.id AS id, vec_distance_cosine(v.embedding, ?) AS distance
         FROM links l
         JOIN link_vectors v ON v.owner_id = l.owner_id AND v.link_id = l.id AND v.model_key = ? AND v.dims = ?
         WHERE ${q.where}
         ORDER BY distance ASC, l.saved_at DESC, l.id DESC LIMIT ?`,
      )
      .all(blob, this.modelKey, vector.length, ...q.params, k) as {
      id: number;
      distance: number;
    }[];
    return rows.map((r) => ({ id: String(r.id), similarity: 1 - r.distance }));
  }
}
