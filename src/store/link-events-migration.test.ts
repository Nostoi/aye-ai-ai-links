import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

type Db = Database.Database;

/** The index of the link_events entry: the entries before it are the schema it starts from. */
const LINK_EVENTS = 20;

let db: Db;
let before: number;
let after: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, LINK_EVENTS));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0);
    INSERT INTO links (id, owner_id, url, url_key, saved_at, saved_by, state, last_opened_at, put_away_at, snoozed_until, deleted_at)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 5, 'x', 'active', 1000, NULL, NULL, NULL),
             (2, 'a', 'https://ex.com/2', 'ex.com/2', 5, 'x', 'archived', NULL, 2000, NULL, NULL),
             (3, 'a', 'https://ex.com/3', 'ex.com/3', 5, 'x', 'archived', NULL, NULL, NULL, NULL),
             (4, 'a', 'https://ex.com/4', 'ex.com/4', 5, 'x', 'active', NULL, NULL, 9000, NULL),
             (5, 'a', 'https://ex.com/5', 'ex.com/5', 5, 'x', 'active', 3000, NULL, NULL, 4000);
    INSERT INTO link_tools (owner_id, link_id, status, source, since, wait_days)
      VALUES ('a', 4, 'declined', 'stated', 7000, 30);`);
  before = Date.now();
  migrate(db);
  after = Date.now();
});

afterEach(() => db.close());

describe("link_events migration", () => {
  it("seeds opened, put_away and not_handy rows from what links already store, marked backfilled", () => {
    expect(
      db
        .prepare("SELECT link_id, kind, at, backfilled FROM link_events ORDER BY link_id, kind")
        .all(),
    ).toEqual([
      { link_id: 1, kind: "opened", at: 1000, backfilled: 1 },
      { link_id: 2, kind: "put_away", at: 2000, backfilled: 1 },
      { link_id: 4, kind: "not_handy", at: 7000, backfilled: 1 },
      { link_id: 5, kind: "opened", at: 3000, backfilled: 1 },
    ]);
  });

  it("seeds no Not now row and nothing for a stale set-aside", () => {
    expect(db.prepare("SELECT 1 FROM link_events WHERE kind = 'not_now'").all()).toEqual([]);
    expect(db.prepare("SELECT 1 FROM link_events WHERE link_id = 3").all()).toEqual([]);
  });

  it("records when tracking began, in milliseconds", () => {
    const row = db.prepare("SELECT only, tracking_since FROM stats_meta").get() as {
      only: number;
      tracking_since: number;
    };
    expect(row.only).toBe(1);
    expect(row.tracking_since).toBeGreaterThanOrEqual(before - 1);
    expect(row.tracking_since).toBeLessThanOrEqual(after + 1);
  });

  it("removes a link's events when the link is purged", () => {
    db.prepare("DELETE FROM links WHERE id = 5").run();
    expect(db.prepare("SELECT 1 FROM link_events WHERE link_id = 5").all()).toEqual([]);
  });
});
