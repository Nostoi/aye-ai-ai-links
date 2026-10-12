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

/** The owner, tag, project and date conditions every query shares; `ownerCol` is its owner column. */
function scope(ownerCol: string, owner: OwnerId, filters: SearchFilters) {
  const where = [`${ownerCol} = ?`];
  const params: (string | number)[] = [owner];
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
  return { where: where.join(" AND "), params };
}

/** Keyword search over the `link_search` and `snapshot_search` tables that the store's triggers keep current. */
export class FtsSearch implements LinkSearch {
  constructor(private readonly db: Database) {}

  async search(owner: OwnerId, query: string, filters: SearchFilters, limit: number) {
    const blank = withoutControls(query).trim() === "";
    const match = blank ? "" : buildMatch(query);
    if (!blank && match === "") return [];

    const newest = "l.saved_at DESC, l.id DESC";
    const ids = (sql: string, ...params: (string | number)[]) =>
      (this.db.prepare(sql).all(...params) as { id: number }[]).map((r) => String(r.id));

    if (blank) {
      const q = scope("l.owner_id", owner, filters);
      return ids(
        `SELECT l.id FROM links l WHERE ${q.where} ORDER BY ${newest} LIMIT ?`,
        ...q.params,
        limit,
      );
    }

    const own = scope("link_search.owner_id", owner, filters);
    const fields = ids(
      `SELECT l.id FROM link_search JOIN links l ON l.id = link_search.rowid
       WHERE link_search MATCH ? AND ${own.where}
       ORDER BY bm25(link_search, 0, 3, 1, 2, 3), ${newest} LIMIT ?`,
      match,
      ...own.params,
      limit,
    );
    if (fields.length >= limit) return fields;

    const page = scope("snapshot_search.owner_id", owner, filters);
    const listed = new Set(fields);
    const pageOnly = ids(
      `SELECT l.id FROM snapshot_search JOIN links l ON l.id = snapshot_search.rowid
       WHERE snapshot_search MATCH ? AND ${page.where}
       ORDER BY bm25(snapshot_search, 0, 3, 2, 1), ${newest} LIMIT ?`,
      match,
      ...page.params,
      limit,
    ).filter((id) => !listed.has(id));
    return [...fields, ...pageOnly].slice(0, limit);
  }
}
