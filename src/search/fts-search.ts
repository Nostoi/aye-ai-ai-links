import type { Database } from "better-sqlite3";
import type {
  LinkCount,
  LinkOrder,
  LinkSearch,
  SearchFilters,
  SearchTrace,
} from "../core/search.js";
import type { OwnerId } from "../core/types.js";
import { listRanks } from "./list-ranks.js";
import { scope } from "./scope.js";
import { STOP_WORDS } from "./stop-words.js";

const withoutControls = (s: string): string => s.replace(/\p{Cc}/gu, " ");

/**
 * Each order of a blank listing: its sort, the condition keeping rows after a `before` position
 * (bound to its time twice, then its id), and the condition for being in the list at all.
 */
const ORDERS: Record<LinkOrder, { sort: string; after: string; listed: string | null }> = {
  newest: {
    sort: "l.saved_at DESC, l.id DESC",
    after: "(l.saved_at < ? OR (l.saved_at = ? AND l.id < ?))",
    listed: null,
  },
  oldest: {
    sort: "l.saved_at ASC, l.id ASC",
    after: "(l.saved_at > ? OR (l.saved_at = ? AND l.id > ?))",
    listed: null,
  },
  opened: {
    sort: "l.last_opened_at DESC, l.id DESC",
    after: "(l.last_opened_at < ? OR (l.last_opened_at = ? AND l.id < ?))",
    listed: "l.last_opened_at IS NOT NULL",
  },
};
const NEWEST = ORDERS.newest.sort;

/** The words of a fragment as the index tokenizer (`unicode61 remove_diacritics 2`) sees them. */
const tokens = (fragment: string): string[] =>
  fragment
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Words with no letter or digit are dropped, then words made only of stop words; if that leaves
 * nothing, the stop words stay. The rest become OR-ed prefix phrases.
 */
function buildMatch(query: string): string {
  const words = withoutControls(query)
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  const content = words.filter((w) => !tokens(w).every((t) => STOP_WORDS.has(t)));
  return (content.length > 0 ? content : words)
    .map((w) => `"${w.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

export type QueryKind = "blank" | "no_words" | "words";

/** Whether a query is blank, has no searchable word, or has words. */
export function queryKind(query: string): QueryKind {
  if (withoutControls(query).trim() === "") return "blank";
  return buildMatch(query) === "" ? "no_words" : "words";
}

/** The query's kind; `order` or `before` with a non-blank query is refused, as `LinkSearch` says. */
export function checkedKind(query: string, filters: SearchFilters): QueryKind {
  const kind = queryKind(query);
  if ((filters.before || filters.order !== undefined) && kind !== "blank") {
    throw new Error("`order` and `before` list a blank query only; this query is not blank.");
  }
  return kind;
}

/** The owner's links in a blank listing's order, with its scope and its list condition. */
function listing(owner: OwnerId, filters: SearchFilters) {
  const order = ORDERS[filters.order ?? "newest"];
  const q = scope("l.owner_id", owner, filters);
  return {
    order,
    where: order.listed ? `${q.where} AND ${order.listed}` : q.where,
    params: q.params,
  };
}

/** Keyword search over the `link_search` and `snapshot_search` tables that the store's triggers keep current. */
export class FtsSearch implements LinkSearch, LinkCount {
  constructor(private readonly db: Database) {}

  async search(
    owner: OwnerId,
    query: string,
    filters: SearchFilters,
    limit: number,
    trace?: (t: SearchTrace) => void,
  ) {
    const kind = checkedKind(query, filters);
    if (kind === "no_words") return [];
    if (kind === "blank") {
      const { order, where, params } = listing(owner, filters);
      const { before } = filters;
      const after = before ? ` AND ${order.after}` : "";
      const at = before?.at.getTime() ?? 0;
      return this.ids(
        `SELECT l.id FROM links l WHERE ${where}${after} ORDER BY ${order.sort} LIMIT ?`,
        ...params,
        ...(before ? [at, at, Number(before.id)] : []),
        limit,
      );
    }
    const { fields, pageOnly } = this.parts(owner, query, filters, limit, limit);
    const ids = [...fields, ...pageOnly].slice(0, limit);
    trace?.({
      mode: "keyword",
      embedded: null,
      modelKey: null,
      similarity: {},
      meaningCandidates: 0,
      ranks: listRanks(ids, { field: fields, page: pageOnly }),
    });
    return ids;
  }

  /** `LinkCount`: the rows a blank listing in that order pages through. */
  async count(owner: OwnerId, filters: Omit<SearchFilters, "before">) {
    const { where, params } = listing(owner, filters);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM links l WHERE ${where}`).get(...params);
    return (row as { n: number }).n;
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
