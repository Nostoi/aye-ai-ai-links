import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_VERSION, MIGRATIONS, migrate } from "./migrations.js";

type Db = Database.Database;

/** The index of the intent entry: the entries before it are the schema it starts from. */
const INTENT = 27;
const DAY = 86_400_000;

let db: Db;
const now = Date.now();

const link = (id: number, extra: { tidy?: number; putAway?: number; state?: string } = {}) =>
  db
    .prepare(
      `INSERT INTO links (id, owner_id, url, url_key, title, saved_at, saved_by, state,
         tidy_kept_at, put_away_at, summary, summary_source)
       VALUES (?, 'a', ?, ?, 't', 5, 'x', ?, ?, ?, 'S', 'inferred')`,
    )
    .run(
      id,
      `https://ex.com/${id}`,
      `ex.com/${id}`,
      extra.state ?? "active",
      extra.tidy ?? null,
      extra.putAway ?? null,
    );

const tool = (id: number, status: string, source: string) =>
  db
    .prepare(
      "INSERT INTO link_tools (owner_id, link_id, status, source, since, wait_days) VALUES ('a', ?, ?, ?, 1, 30)",
    )
    .run(id, status, source);

const intents = () =>
  db.prepare("SELECT id, intent, intent_source AS source FROM links ORDER BY id").all();

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, INTENT));
  expect(db.pragma("user_version", { simple: true })).toBe(INTENT);
  db.exec("INSERT INTO users VALUES ('a', 'a', 0)");
  link(1);
  link(2);
  tool(2, "kept", "stated");
  link(3, { tidy: now - 10 * DAY });
  link(4, { tidy: now - 200 * DAY });
  link(5, { state: "archived", putAway: now - DAY });
  link(6, { tidy: now - DAY });
  tool(6, "kept", "asked");
  link(7);
  tool(7, "suggested", "inferred");
  link(8);
  tool(8, "kept", "stated");
  db.exec("UPDATE links SET deleted_at = 9 WHERE id = 8");
  db.exec(
    `INSERT INTO link_events (owner_id, link_id, kind, at) VALUES ('a', 5, 'put_away', 7), ('a', 1, 'stale', 8)`,
  );
  db.exec(`INSERT INTO link_edits (owner_id, link_id, edit_id, title_changed, picture_changed, at,
    summary_changed, prior_summary, written_summary, prior_summary_source, written_summary_source)
    VALUES ('a', 1, 'e1', 0, 0, 3, 1, 'old', 'new', 'inferred', 'stated')`);
  migrate(db);
});

afterEach(() => db.close());

describe("intent migration", () => {
  it("is the last entry", () => {
    expect(LATEST_VERSION).toBe(INTENT + 1);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
  });

  it("gives each seeded link the intent its kept tool or recent Tidy Keep earned, and no other", () => {
    expect(intents()).toEqual([
      { id: 1, intent: "explore", source: null },
      { id: 2, intent: "keep", source: "stated" },
      { id: 3, intent: "keep", source: "stated" },
      { id: 4, intent: "explore", source: null },
      { id: 5, intent: "explore", source: null },
      { id: 6, intent: "keep", source: "asked" },
      { id: 7, intent: "explore", source: null },
      { id: 8, intent: "keep", source: "stated" },
    ]);
  });

  it("drops put_away_at and tidy_kept_at, and keeps events, the search trigger and foreign keys", () => {
    const columns = (db.pragma("table_info(links)") as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("put_away_at");
    expect(columns).not.toContain("tidy_kept_at");
    expect(db.prepare("SELECT kind FROM link_events ORDER BY kind").all()).toEqual([
      { kind: "put_away" },
      { kind: "stale" },
    ]);
    db.prepare("UPDATE links SET title = 'wombat' WHERE id = 1").run();
    expect(
      db.prepare("SELECT rowid FROM link_search WHERE link_search MATCH 'wombat'").all(),
    ).toEqual([{ rowid: 1 }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("refuses a keep with no source and an unknown intent", () => {
    expect(() =>
      db.exec("UPDATE links SET intent = 'keep', intent_source = NULL WHERE id = 1"),
    ).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE links SET intent = 'maybe' WHERE id = 1")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE links SET intent_source = 'server' WHERE id = 1")).toThrow(
      /CHECK/,
    );
  });

  it("keeps the link_edits row with its summary sources, and takes an intent-only receipt", () => {
    expect(
      db
        .prepare(
          "SELECT prior_summary_source AS p, written_summary_source AS w, intent_changed AS i FROM link_edits",
        )
        .get(),
    ).toEqual({ p: "inferred", w: "stated", i: 0 });
    db.exec(`INSERT INTO link_edits (owner_id, link_id, edit_id, title_changed, picture_changed, at,
      intent_changed, prior_intent, prior_intent_source, written_intent, written_intent_source)
      VALUES ('a', 2, 'e2', 0, 0, 4, 1, 'explore', NULL, 'keep', 'stated')`);
    expect(() =>
      db.exec(
        "INSERT INTO link_edits (owner_id, link_id, edit_id, title_changed, picture_changed, at) VALUES ('a', 3, 'e3', 0, 0, 5)",
      ),
    ).toThrow(/CHECK/);
    db.prepare("DELETE FROM links WHERE id = 2").run();
    expect(db.prepare("SELECT count(*) AS n FROM link_edits WHERE link_id = 2").get()).toEqual({
      n: 0,
    });
  });
});
