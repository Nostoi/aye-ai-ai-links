import type { Database } from "better-sqlite3";
import type { TagSuggestStore } from "../core/tag-suggest-store.js";
import type { OwnerId } from "../core/types.js";

const sorted = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/** The pairs of tag keys that share a live link, and the pairs the owner turned down (`tag_merge_dismissals`). */
export class SqliteTagSuggestStore implements TagSuggestStore {
  constructor(private readonly db: Database) {}

  async sharedPairs(owner: OwnerId): Promise<[string, string][]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT ta.key AS a, tb.key AS b FROM link_tags la
         JOIN link_tags lb ON lb.link_id = la.link_id AND lb.owner_id = la.owner_id
         JOIN tags ta ON ta.id = la.tag_id AND ta.owner_id = la.owner_id
         JOIN tags tb ON tb.id = lb.tag_id AND tb.owner_id = lb.owner_id
         JOIN links l ON l.id = la.link_id AND l.owner_id = la.owner_id
         WHERE la.owner_id = ? AND l.deleted_at IS NULL AND ta.key < tb.key`,
      )
      .all(owner) as { a: string; b: string }[];
    return rows.map((r) => [r.a, r.b]);
  }

  async dismissedPairs(owner: OwnerId): Promise<[string, string][]> {
    const rows = this.db
      .prepare("SELECT key_a AS a, key_b AS b FROM tag_merge_dismissals WHERE owner_id = ?")
      .all(owner) as { a: string; b: string }[];
    return rows.map((r) => [r.a, r.b]);
  }

  async dismissPair(owner: OwnerId, a: string, b: string, at: Date): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO tag_merge_dismissals (owner_id, key_a, key_b, dismissed_at) VALUES (?, ?, ?, ?)",
      )
      .run(owner, ...sorted(a, b), at.getTime());
  }

  async undismissPair(owner: OwnerId, a: string, b: string): Promise<void> {
    this.db
      .prepare("DELETE FROM tag_merge_dismissals WHERE owner_id = ? AND key_a = ? AND key_b = ?")
      .run(owner, ...sorted(a, b));
  }
}
