import type Database from "better-sqlite3";
import type { LoggedEvent } from "../core/store-contract.js";

/** The link's log rows, oldest write first, as the contract harnesses read them back. */
export function loggedEvents(db: Database.Database, owner: string, id: string): LoggedEvent[] {
  return db
    .prepare(
      "SELECT kind, at, backfilled FROM link_events WHERE owner_id = ? AND link_id = ? ORDER BY rowid",
    )
    .all(owner, Number(id))
    .map((r) => {
      const row = r as { kind: LoggedEvent["kind"]; at: number; backfilled: number };
      return { kind: row.kind, at: new Date(row.at), backfilled: row.backfilled === 1 };
    });
}
