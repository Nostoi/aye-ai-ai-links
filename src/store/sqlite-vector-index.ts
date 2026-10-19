import type { Database } from "better-sqlite3";
import { PAGE_CHARS } from "../core/link-document.js";
import type { OwnerId } from "../core/types.js";
import type { IndexRow, VectorIndexStore } from "../core/vector-index-store.js";
import { parseId } from "./sqlite-store.js";

/** Largest allowed distance of a stored vector's length from 1, as the model canary allows. */
const NORM_TOLERANCE = 1e-3;

type PageRow = Omit<IndexRow, "linkId" | "tags"> & { linkId: number; tags: string };

/** The meaning-search index over `link_vectors`, for vectors of `dims` values. */
export class SqliteVectorIndex implements VectorIndexStore {
  constructor(
    private readonly db: Database,
    private readonly dims: number,
  ) {}

  async indexPage(modelKey: string, afterId: string | null, limit: number): Promise<IndexRow[]> {
    const after = afterId === null ? 0 : (parseId(afterId) ?? 0);
    const rows = this.db
      .prepare(
        `SELECT l.owner_id AS owner, l.id AS linkId, l.url AS url, l.title AS title,
           l.summary AS summary, l.why_text AS why,
           (SELECT json_group_array(name) FROM
             (SELECT t.name AS name FROM link_tags lt
              JOIN tags t ON t.id = lt.tag_id AND t.owner_id = lt.owner_id
              WHERE lt.link_id = l.id AND lt.owner_id = l.owner_id ORDER BY lt.position)) AS tags,
           s.title AS pageTitle, s.description AS pageDescription,
           substr(s.text, 1, ?) AS pageText, v.text_hash AS textHash
         FROM links l
         LEFT JOIN snapshots s ON s.link_id = l.id AND s.owner_id = l.owner_id
         LEFT JOIN link_vectors v ON v.link_id = l.id AND v.model_key = ?
         WHERE l.id > ? AND l.deleted_at IS NULL ORDER BY l.id LIMIT ?`,
      )
      .all(PAGE_CHARS, modelKey, after, limit) as PageRow[];
    return rows.map((r) => ({
      ...r,
      linkId: String(r.linkId),
      tags: JSON.parse(r.tags) as string[],
    }));
  }

  async writeVector(
    owner: OwnerId,
    linkId: string,
    modelKey: string,
    textHash: string,
    vector: Float32Array,
    at: Date,
  ): Promise<boolean> {
    this.check(vector);
    const n = parseId(linkId);
    if (n === null) return false;
    const { changes } = this.db
      .prepare(
        `INSERT INTO link_vectors (owner_id, link_id, model_key, dims, text_hash, embedding, embedded_at)
         SELECT owner_id, id, ?, ?, ?, ?, ? FROM links WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
         ON CONFLICT (link_id, model_key) DO UPDATE SET dims = excluded.dims,
           text_hash = excluded.text_hash, embedding = excluded.embedding,
           embedded_at = excluded.embedded_at`,
      )
      .run(
        modelKey,
        vector.length,
        textHash,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        at.getTime(),
        n,
        owner,
      );
    return changes === 1;
  }

  async retireModels(currentKey: string): Promise<number> {
    return this.db.prepare("DELETE FROM link_vectors WHERE model_key <> ?").run(currentKey).changes;
  }

  async changeCount(): Promise<number> {
    return this.db.prepare("SELECT total_changes()").pluck().get() as number;
  }

  private check(vector: Float32Array): void {
    if (vector.length !== this.dims) {
      throw new RangeError(`A vector has ${vector.length} values, expected ${this.dims}.`);
    }
    let sumSquares = 0;
    for (const x of vector) {
      if (!Number.isFinite(x)) throw new RangeError("A vector value is not finite.");
      sumSquares += x * x;
    }
    const length = Math.sqrt(sumSquares);
    if (Math.abs(length - 1) > NORM_TOLERANCE) {
      throw new RangeError(`A vector's length is ${length}, expected 1.`);
    }
  }
}
