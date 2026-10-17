import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

type Db = Database.Database;

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

/** The migration that adds `link_tools`; everything before it is the schema it starts from. */
const TOOLS_MIGRATION = 11;

/** A database at the version before `link_tools`, holding two owners' links, migrated to the latest. */
function migrated(): Db {
  const db = new Database(":memory:");
  open.push(db);
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, TOOLS_MIGRATION));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO links (id, owner_id, url, url_key, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 5, 'x', 'active'),
             (2, 'a', 'https://ex.com/2', 'ex.com/2', 5, 'x', 'active'),
             (3, 'b', 'https://ex.com/3', 'ex.com/3', 5, 'x', 'active');`);
  migrate(db);
  return db;
}

const insert = (
  db: Db,
  owner: string,
  linkId: number,
  status = "kept",
  waitDays = 30,
  source = "stated",
) =>
  db
    .prepare(
      `INSERT INTO link_tools (owner_id, link_id, status, source, since, answered_at, wait_days)
       VALUES (?, ?, ?, ?, 0, NULL, ?)`,
    )
    .run(owner, linkId, status, source, waitDays);

describe("the link_tools migration, from the version before it, with links", () => {
  it("creates an empty link_tools, keeping the existing links", () => {
    const db = migrated();
    expect(db.prepare("SELECT count(*) AS n FROM link_tools").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id FROM links ORDER BY id").all()).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
  });

  it("removes a link's row when the link is deleted, and only that link's", () => {
    const db = migrated();
    insert(db, "a", 1);
    insert(db, "a", 2);
    insert(db, "b", 3);
    db.prepare("DELETE FROM links WHERE id = 1").run();
    expect(db.prepare("SELECT link_id FROM link_tools ORDER BY link_id").all()).toEqual([
      { link_id: 2 },
      { link_id: 3 },
    ]);
  });

  it("refuses a row whose owner is not the link's owner, or whose link does not exist", () => {
    const db = migrated();
    expect(() => insert(db, "b", 1)).toThrow(/FOREIGN KEY/);
    expect(() => insert(db, "a", 99)).toThrow(/FOREIGN KEY/);
  });

  it("refuses a second row for a link, and a status, source or wait outside the allowed values", () => {
    const db = migrated();
    insert(db, "a", 1);
    expect(() => insert(db, "a", 1)).toThrow(/UNIQUE/);
    expect(() => insert(db, "a", 2, "maybe")).toThrow(/CHECK/);
    expect(() => insert(db, "a", 2, "kept", 45)).toThrow(/CHECK/);
    expect(() => insert(db, "a", 2, "kept", 30, "guessed")).toThrow(/CHECK/);
    expect(db.prepare("SELECT link_id FROM link_tools").all()).toEqual([{ link_id: 1 }]);
  });
});
