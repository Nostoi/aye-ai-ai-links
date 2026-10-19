import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

type Db = Database.Database;

/** The index of the links-rebuild entry: the 16 entries before it are the schema it starts from. */
const LINKS_REBUILD = 16;

const TABLES = [
  "links",
  "tags",
  "link_tags",
  "snapshots",
  "link_vectors",
  "link_images",
  "owner_images",
  "link_edits",
  "link_tools",
  "link_checks",
  "saved_copies",
  "saved_copy_images",
];

const triggers = (db: Db) =>
  db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as {
    name: string;
    sql: string;
  }[];

const counts = (db: Db) =>
  Object.fromEntries(
    TABLES.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
  );

const found = (db: Db, word: string) =>
  db
    .prepare("SELECT rowid FROM link_search WHERE link_search MATCH ?")
    .all(word)
    .map((r) => (r as { rowid: number }).rowid);

let db: Db;
let triggersBefore: ReturnType<typeof triggers>;
let countsBefore: ReturnType<typeof counts>;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, LINKS_REBUILD));
  expect(db.pragma("user_version", { simple: true })).toBe(LINKS_REBUILD);
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO links (id, owner_id, url, url_key, title, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 'quokka', 5, 'x', 'active'),
             (2, 'a', 'https://ex.com/2', 'ex.com/2', 'bilby', 5, 'x', 'active'),
             (7, 'b', 'https://ex.com/7', 'ex.com/7', 'numbat', 5, 'x', 'archived');
    INSERT INTO tags (id, owner_id, key, name, kind) VALUES (1, 'a', 'wombat', 'Wombat', 'topic');
    INSERT INTO link_tags VALUES ('a', 1, 1, 'stated', 0);
    INSERT INTO snapshots (link_id, owner_id, fetch_status, text) VALUES (1, 'a', 'ok', 'some text');
    INSERT INTO link_vectors VALUES ('a', 1, 'm', 1, 'h', x'00000000', 5);
    INSERT INTO link_images VALUES ('a', 1, 'image/png', x'00', 'h', 5, 'preview');
    INSERT INTO owner_images VALUES ('a', 1, 'image/png', x'00', 'h', 5);
    INSERT INTO link_edits (owner_id, link_id, edit_id, title_changed, picture_changed, written_title, at)
      VALUES ('a', 1, 'e', 1, 0, 't', 5);
    INSERT INTO link_tools VALUES ('a', 1, 'kept', 'stated', 5, NULL, 30);
    INSERT INTO link_checks (owner_id, link_id, checked_at, result) VALUES ('a', 1, 5, 'alive');
    INSERT INTO saved_copies (owner_id, link_id, status, made_at) VALUES ('a', 1, 'ok', 5);
    INSERT INTO saved_copy_images VALUES ('a', 1, 1, 'https://ex.com/i.png', 'ok', 'image/png', 1, 'h');`);
  triggersBefore = triggers(db);
  countsBefore = counts(db);
  migrate(db);
});

afterEach(() => db.close());

describe("links rebuild migration", () => {
  it("keeps every child row and the foreign keys clean", () => {
    expect(counts(db)).toEqual(countsBefore);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("keeps every trigger that named links, with identical SQL", () => {
    const after = triggers(db);
    expect(after).toEqual(triggersBefore);
    expect(after.filter((t) => /\blinks\b/.test(t.sql)).map((t) => t.name)).toEqual([
      "link_search_links_del",
      "link_search_links_ins",
      "link_search_links_upd",
      "link_search_lt_del",
      "link_search_lt_ins",
      "link_search_lt_upd",
      "link_search_tags_upd",
    ]);
  });

  it("still finds the links by keyword and tag name", () => {
    expect(found(db, "quokka")).toEqual([1]);
    expect(found(db, "wombat")).toEqual([1]);
    db.exec("UPDATE tags SET name = 'Platypus' WHERE id = 1");
    expect(found(db, "platypus")).toEqual([1]);
  });

  it("issues ids with AUTOINCREMENT and adds deleted_at", () => {
    const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'links'").get() as {
      sql: string;
    };
    expect(sql).toContain("AUTOINCREMENT");
    expect(sql).toContain("deleted_at INTEGER");
    const deleted = db.prepare("SELECT deleted_at FROM links").all() as { deleted_at: unknown }[];
    expect(deleted.map((r) => r.deleted_at)).toEqual([null, null, null]);
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'links'").get()).toEqual({
      seq: 7,
    });
    db.exec("DELETE FROM links WHERE id = 7");
    const info = db
      .prepare(
        "INSERT INTO links (owner_id, url, url_key, saved_at, saved_by, state) VALUES ('a', 'https://ex.com/9', 'ex.com/9', 5, 'x', 'active')",
      )
      .run();
    expect(info.lastInsertRowid).toBe(8);
  });

  it("indexes deleted_at only for deleted links", () => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'links_deleted'").get() as {
      sql: string;
    };
    expect(row.sql).toContain("WHERE deleted_at IS NOT NULL");
  });
});
