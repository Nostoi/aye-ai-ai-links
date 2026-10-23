import type { Database } from "better-sqlite3";
import type { StatsReading, StatsReadingStore } from "../core/stats-reading-store.js";
import type { OwnerId } from "../core/types.js";

/** The owner has a link that is not deleted. */
const LIVE = "EXISTS (SELECT 1 FROM links WHERE owner_id = ? AND deleted_at IS NULL)";

/** The owner has a live link saved at or before the stored reading's `written_at`: the reading is visible. */
const visible = (owner: string, writtenAt: string) =>
  `EXISTS (SELECT 1 FROM links WHERE owner_id = ${owner} AND deleted_at IS NULL AND saved_at <= ${writtenAt})`;

/** The AI's latest reading of each owner's stats (`stats_readings`, #161). */
export class SqliteStatsReadingStore implements StatsReadingStore {
  constructor(private readonly db: Database) {}

  async getReading(owner: OwnerId): Promise<StatsReading | null> {
    const row = this.db
      .prepare(
        `SELECT text, written_by, written_at, input_hash FROM stats_readings
         WHERE owner_id = ? AND ${visible("?", "written_at")}`,
      )
      .get(owner, owner) as
      | { text: string; written_by: string; written_at: number; input_hash: string }
      | undefined;
    return row
      ? {
          text: row.text,
          writtenBy: row.written_by,
          writtenAt: new Date(row.written_at),
          inputHash: row.input_hash,
        }
      : null;
  }

  async putReadingIf(
    owner: OwnerId,
    expectedWrittenAt: Date | null,
    r: StatsReading,
  ): Promise<boolean> {
    const values = [r.text, r.writtenBy, r.writtenAt.getTime(), r.inputHash];
    if (expectedWrittenAt === null) {
      return (
        this.db
          .prepare(
            `INSERT INTO stats_readings (owner_id, text, written_by, written_at, input_hash)
             SELECT ?, ?, ?, ?, ? WHERE ${LIVE}
             ON CONFLICT (owner_id) DO UPDATE SET
               text = excluded.text, written_by = excluded.written_by,
               written_at = excluded.written_at, input_hash = excluded.input_hash
             WHERE NOT ${visible("?", "stats_readings.written_at")}`,
          )
          .run(owner, ...values, owner, owner).changes === 1
      );
    }
    return (
      this.db
        .prepare(
          `UPDATE stats_readings SET text = ?, written_by = ?, written_at = ?, input_hash = ?
           WHERE owner_id = ? AND written_at = ? AND ${LIVE}`,
        )
        .run(...values, owner, expectedWrittenAt.getTime(), owner).changes === 1
    );
  }

  async readingCandidates(dueBefore: Date): Promise<OwnerId[]> {
    const rows = this.db
      .prepare(
        `SELECT u.id FROM users u
         LEFT JOIN stats_readings s ON s.owner_id = u.id
         WHERE (s.owner_id IS NULL OR s.written_at <= ? OR NOT ${visible("u.id", "s.written_at")})
           AND EXISTS (SELECT 1 FROM links l WHERE l.owner_id = u.id AND l.deleted_at IS NULL)
         ORDER BY u.id`,
      )
      .all(dueBefore.getTime()) as { id: string }[];
    return rows.map((r) => r.id);
  }
}
