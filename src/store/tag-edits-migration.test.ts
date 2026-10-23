import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

/** The index of the tag edits entry: the entries before it are the schema it starts from. */
const TAG_EDITS = 22;

let db: Database.Database;

const primaryKey = (table: string) =>
  db
    .prepare(`SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`)
    .pluck()
    .all();

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, TAG_EDITS));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO tags (id, owner_id, key, name, kind) VALUES (1, 'a', 'x', 'x', 'topic'),
      (2, 'a', 'y', 'y', 'topic'), (3, 'b', 'x', 'x', 'topic');`);
  migrate(db);
});

afterEach(() => db.close());

describe("tag edits migration", () => {
  it("is the last entry and adds both tables, empty, with their keys", () => {
    expect(MIGRATIONS).toHaveLength(TAG_EDITS + 1);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(primaryKey("tag_aliases")).toEqual(["owner_id", "old_key"]);
    expect(primaryKey("tag_changes")).toEqual(["owner_id", "change_id"]);
    expect(db.prepare("SELECT count(*) FROM tag_aliases").pluck().get()).toBe(0);
    expect(db.prepare("SELECT count(*) FROM tag_changes").pluck().get()).toBe(0);
  });

  it("deleting a tag deletes its aliases, and only its own", () => {
    db.exec(
      `INSERT INTO tag_aliases VALUES ('a', 'old-x', 1), ('a', 'old-y', 2), ('b', 'old-x', 3);`,
    );
    db.prepare("DELETE FROM tags WHERE id = 1").run();
    expect(
      db.prepare("SELECT owner_id, old_key, tag_id FROM tag_aliases ORDER BY owner_id").all(),
    ).toEqual([
      { owner_id: "a", old_key: "old-y", tag_id: 2 },
      { owner_id: "b", old_key: "old-x", tag_id: 3 },
    ]);
  });

  it("refuses an alias to another owner's tag, a receipt of an unknown owner or action, and a repeated key", () => {
    expect(() => db.exec("INSERT INTO tag_aliases VALUES ('a', 'k', 3)")).toThrow(/FOREIGN KEY/);
    const receipt = (owner: string, action: string) =>
      db.prepare("INSERT INTO tag_changes VALUES (?, 'c1', ?, 0, '{}')").run(owner, action);
    expect(() => receipt("nobody", "merge")).toThrow(/FOREIGN KEY/);
    expect(() => receipt("a", "rename")).toThrow(/CHECK/);
    receipt("a", "delete");
    expect(() => receipt("a", "merge")).toThrow(/UNIQUE|PRIMARY/);
    db.exec("INSERT INTO tag_aliases VALUES ('a', 'k', 1)");
    expect(() => db.exec("INSERT INTO tag_aliases VALUES ('a', 'k', 2)")).toThrow(/UNIQUE|PRIMARY/);
  });
});
