import type { Database } from "better-sqlite3";
import type { SearchLog, SearchLogEntry } from "../core/search-log.js";
import type { OwnerId } from "../core/types.js";
import { parseId } from "./sqlite-store.js";

/** Dates become epoch milliseconds, like every other date in the database. */
const filtersJson = ({ savedFrom, savedTo, ...rest }: SearchLogEntry["filters"]): string =>
  JSON.stringify({
    ...rest,
    ...(savedFrom && { savedFrom: savedFrom.getTime() }),
    ...(savedTo && { savedTo: savedTo.getTime() }),
  });

export class SqliteSearchLog implements SearchLog {
  constructor(private readonly db: Database) {}

  async record(owner: OwnerId, by: string, entry: SearchLogEntry, at: Date): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO search_log
           (owner_id, searched_by, query, filters, mode, embedded, model_key, meaning_candidates,
            results, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(entry.results),
        at.getTime(),
      );
  }

  /** Pairs only the agent's newest search (highest id), only while it has no open and is newer than `since`. */
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
