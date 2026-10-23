import type { Database } from "better-sqlite3";
import type { StatsEvent, StatsStore } from "../core/stats-store.js";
import type { LinkEventKind, OwnerId } from "../core/types.js";

/** The event log and its start (`link_events`, `stats_meta`, #161). */
export class SqliteStatsStore implements StatsStore {
  constructor(private readonly db: Database) {}

  async statsEvents(owner: OwnerId): Promise<StatsEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT e.link_id, e.kind, e.at FROM link_events e
         JOIN links l ON l.owner_id = e.owner_id AND l.id = e.link_id
         WHERE e.owner_id = ? AND l.deleted_at IS NULL
         ORDER BY e.at, e.rowid`,
      )
      .all(owner) as { link_id: number; kind: LinkEventKind; at: number }[];
    return rows.map((r) => ({ linkId: String(r.link_id), kind: r.kind, at: new Date(r.at) }));
  }

  async trackingSince(): Promise<Date> {
    const row = this.db.prepare("SELECT tracking_since FROM stats_meta").get() as {
      tracking_since: number;
    };
    return new Date(row.tracking_since);
  }
}
