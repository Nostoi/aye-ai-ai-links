import type { Database } from "better-sqlite3";
import type { LinkSearch, SearchFilters, SearchTrace } from "../core/search.js";
import type { OwnerId } from "../core/types.js";
import { scope } from "./scope.js";

const withoutControls = (s: string): string => s.replace(/\p{Cc}/gu, " ");
const NEWEST = "l.saved_at DESC, l.id DESC";

/** Words with no letter or digit are dropped; the rest become OR-ed prefix phrases. */
function buildMatch(query: string): string {
  return withoutControls(query)
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .map((w) => `"${w.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

export type QueryKind = "blank" | "no_words" | "words";

/** Whether a query is blank, has no searchable word, or has words. */
export function queryKind(query: string): QueryKind {
  if (withoutControls(query).trim() === "") return "blank";
  return buildMatch(query) === "" ? "no_words" : "words";
}

/** Keyword search over the `link_search` and `snapshot_search` tables that the store's triggers keep current. */
export class FtsSearch implements LinkSearch {
  constructor(private readonly db: Database) {}

  async search(
    owner: OwnerId,
    query: string,
    filters: SearchFilters,
    limit: number,
    trace?: (t: SearchTrace) => void,
  ) {
    const kind = queryKind(query);
    if (kind === "no_words") return [];
    if (kind === "blank") {
      const q = scope("l.owner_id", owner, filters);
      return this.ids(
        `SELECT l.id FROM links l WHERE ${q.where} ORDER BY ${NEWEST} LIMIT ?`,
        ...q.params,
        limit,
      );
    }
    const { fields, pageOnly } = this.parts(owner, query, filters, limit, limit);
    trace?.({
      mode: "keyword",
      embedded: null,
      modelKey: null,
      similarity: {},
      meaningCandidates: 0,
    });
    return [...fields, ...pageOnly].slice(0, limit);
  }

  /**
   * The two keyword lists of a word query. `fields` (own title, summary, why, tags) is capped at
   * `limit`; `pageOnly` (page text, ids not in `fields`) is capped at `depth` and is empty when
   * `fields` fills `limit`.
   */
  parts(
    owner: OwnerId,
    query: string,
    filters: SearchFilters,
    limit: number,
    depth: number,
  ): { fields: string[]; pageOnly: string[] } {
    const match = buildMatch(query);
    const own = scope("link_search.owner_id", owner, filters);
    const fields = this.ids(
      `SELECT l.id FROM link_search JOIN links l ON l.id = link_search.rowid
       WHERE link_search MATCH ? AND ${own.where}
       ORDER BY bm25(link_search, 0, 3, 1, 2, 3), ${NEWEST} LIMIT ?`,
      match,
      ...own.params,
      limit,
    );
    if (fields.length >= limit) return { fields, pageOnly: [] };

    const page = scope("snapshot_search.owner_id", owner, filters);
    const listed = new Set(fields);
    const pageOnly = this.ids(
      `SELECT l.id FROM snapshot_search JOIN links l ON l.id = snapshot_search.rowid
       WHERE snapshot_search MATCH ? AND ${page.where}
       ORDER BY bm25(snapshot_search, 0, 3, 2, 1), ${NEWEST} LIMIT ?`,
      match,
      ...page.params,
      depth,
    ).filter((id) => !listed.has(id));
    return { fields, pageOnly };
  }

  private ids(sql: string, ...params: (string | number)[]): string[] {
    return (this.db.prepare(sql).all(...params) as { id: number }[]).map((r) => String(r.id));
  }
}
