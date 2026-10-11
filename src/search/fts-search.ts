import type { Database } from "better-sqlite3";
import type { LinkSearch, SearchFilters } from "../core/search.js";
import type { OwnerId } from "../core/types.js";

const withoutControls = (s: string): string => s.replace(/\p{Cc}/gu, " ");

/** Words with no letter or digit are dropped; the rest become OR-ed prefix phrases. */
function buildMatch(query: string): string {
  return withoutControls(query)
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .map((w) => `"${w.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

/** Keyword search over the `link_search` table that the store's triggers keep current. */
export class FtsSearch implements LinkSearch {
  constructor(private readonly db: Database) {}

  async search(owner: OwnerId, query: string, filters: SearchFilters, limit: number) {
    const blank = withoutControls(query).trim() === "";
    const match = blank ? "" : buildMatch(query);
    if (!blank && match === "") return [];

    const ownerCol = blank ? "l.owner_id" : "link_search.owner_id";
    const where = [`${ownerCol} = ?`];
    const params: (string | number)[] = [owner];
    if (!blank) {
      where.unshift("link_search MATCH ?");
      params.unshift(match);
    }
    const tagFilter = (key: string, project: boolean) => {
      where.push(
        `EXISTS (SELECT 1 FROM link_tags lt JOIN tags t ON t.id = lt.tag_id AND t.owner_id = lt.owner_id
           WHERE lt.link_id = l.id AND lt.owner_id = ${ownerCol} AND t.key = ?${project ? " AND t.kind = 'project'" : ""})`,
      );
      params.push(key);
    };
    if (filters.tagKey !== undefined) tagFilter(filters.tagKey, false);
    if (filters.projectKey !== undefined) tagFilter(filters.projectKey, true);
    if (filters.savedFrom) {
      where.push("l.saved_at >= ?");
      params.push(filters.savedFrom.getTime());
    }
    if (filters.savedTo) {
      where.push("l.saved_at <= ?");
      params.push(filters.savedTo.getTime());
    }

    const newest = "l.saved_at DESC, l.id DESC";
    const sql = blank
      ? `SELECT l.id FROM links l WHERE ${where.join(" AND ")} ORDER BY ${newest} LIMIT ?`
      : `SELECT l.id FROM link_search JOIN links l ON l.id = link_search.rowid
         WHERE ${where.join(" AND ")}
         ORDER BY bm25(link_search, 0, 3, 1, 2, 3), ${newest} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as { id: number }[];
    return rows.map((r) => String(r.id));
  }
}
