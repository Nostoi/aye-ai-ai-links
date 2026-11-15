import type { Database } from "better-sqlite3";
import type { ReceiptRow, SearchLog, SearchLogEntry } from "../core/search-log.js";
import type { OwnerId } from "../core/types.js";
import { parseId } from "./sql-values.js";

/** Dates become epoch milliseconds, like every other date in the database. */
const filtersJson = ({ savedFrom, savedTo, ...rest }: SearchLogEntry["filters"]): string =>
  JSON.stringify({
    ...rest,
    ...(savedFrom && { savedFrom: savedFrom.getTime() }),
    ...(savedTo && { savedTo: savedTo.getTime() }),
  });

export class SqliteSearchLog implements SearchLog {
  constructor(private readonly db: Database) {}

  /** A receipt already written is left as it is: the unique receipt makes a second write a no-op. */
  async record(
    owner: OwnerId,
    by: string,
    entry: SearchLogEntry,
    at: Date,
    receipt?: string,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO search_log
           (owner_id, searched_by, query, filters, mode, embedded, model_key, meaning_candidates,
            result_limit, results, created_at, receipt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (receipt) DO NOTHING`,
      )
      .run(
        owner,
        by,
        entry.query,
        filtersJson(entry.filters),
        entry.mode,
        entry.embedded,
        entry.modelKey,
        entry.meaningCandidates,
        entry.limit,
        JSON.stringify(entry.results),
        at.getTime(),
        receipt ?? null,
      );
  }

  async receiptRow(owner: OwnerId, receipt: string): Promise<ReceiptRow | null> {
    const row = this.db
      .prepare(
        `SELECT searched_by AS by, created_at AS at, opened_link_id AS opened, results
         FROM search_log WHERE owner_id = ? AND receipt = ?`,
      )
      .get(owner, receipt) as
      | { by: string; at: number; opened: number | null; results: string }
      | undefined;
    if (!row) return null;
    return {
      by: row.by,
      createdAt: new Date(row.at),
      openedLinkId: row.opened === null ? null : String(row.opened),
      resultIds: (JSON.parse(row.results) as { id: string }[]).map((r) => r.id),
    };
  }

  /** The row's own `opened_link_id IS NULL` is the guard, so two opens at once pair one. */
  async pairReceipt(
    owner: OwnerId,
    receipt: string,
    link: { id: string; urlKey: string },
    at: Date,
  ): Promise<void> {
    const linkId = parseId(link.id);
    if (linkId === null) return;
    this.db
      .prepare(
        `UPDATE search_log SET opened_link_id = ?, opened_url_key = ?, opened_at = ?
         WHERE owner_id = ? AND receipt = ? AND opened_link_id IS NULL`,
      )
      .run(linkId, link.urlKey, at.getTime(), owner, receipt);
  }

  /** For an agent's get_link: pairs only its newest search (highest id), only while it has no open and is newer than `since`. */
  async pairOpen(
    owner: OwnerId,
    by: string,
    link: { id: string; urlKey: string },
    since: Date,
    at: Date,
  ): Promise<void> {
    const linkId = parseId(link.id);
    if (linkId === null) return;
    this.db
      .prepare(
        `UPDATE search_log SET opened_link_id = ?, opened_url_key = ?, opened_at = ?
         WHERE id = (SELECT max(id) FROM search_log WHERE owner_id = ? AND searched_by = ?)
           AND opened_link_id IS NULL AND created_at >= ?`,
      )
      .run(linkId, link.urlKey, at.getTime(), owner, by, since.getTime());
  }
}
