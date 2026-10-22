import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_VERSION, MIGRATIONS, migrate } from "./migrations.js";

type Db = Database.Database;

/** The index of the put-away entry: the entries before it are the schema it starts from. */
const PUT_AWAY = 18;

const triggers = (db: Db) =>
  db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();

const found = (db: Db, word: string) =>
  db
    .prepare("SELECT rowid FROM link_search WHERE link_search MATCH ?")
    .all(word)
    .map((r) => (r as { rowid: number }).rowid);

let db: Db;
let triggersBefore: unknown[];

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, PUT_AWAY));
  expect(db.pragma("user_version", { simple: true })).toBe(PUT_AWAY);
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0);
    INSERT INTO links (id, owner_id, url, url_key, title, saved_at, saved_by, state, snoozed_until)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 'quokka', 5, 'x', 'active', NULL),
             (2, 'a', 'https://ex.com/2', 'ex.com/2', 'bilby', 5, 'x', 'archived', 99);`);
  triggersBefore = triggers(db);
  migrate(db);
});

afterEach(() => db.close());

describe("put-away migration", () => {
  it("is the entry after the links rebuilds", () => {
    expect(LATEST_VERSION).toBe(PUT_AWAY + 2);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
  });

  it("keeps an active and an archived link intact, with both new fields null", () => {
    expect(
      db
        .prepare(
          "SELECT id, title, state, snoozed_until, put_away_at, tidy_kept_at FROM links ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: 1,
        title: "quokka",
        state: "active",
        snoozed_until: null,
        put_away_at: null,
        tidy_kept_at: null,
      },
      {
        id: 2,
        title: "bilby",
        state: "archived",
        snoozed_until: 99,
        put_away_at: null,
        tidy_kept_at: null,
      },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps the search triggers and the links_deleted index", () => {
    expect(triggers(db)).toEqual(triggersBefore);
    expect(found(db, "quokka")).toEqual([1]);
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'links_deleted'").get() as {
      sql: string;
    };
    expect(row.sql).toContain("WHERE deleted_at IS NOT NULL");
  });
});
