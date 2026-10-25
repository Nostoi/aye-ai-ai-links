import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

/** The index of the dismissals entry: the entries before it are the schema it starts from. */
const DISMISSALS = 23;

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, DISMISSALS));
  db.exec("INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);");
  migrate(db);
});

afterEach(() => db.close());

describe("tag merge dismissals migration", () => {
  it("is the last entry and adds an empty table keyed by owner and both keys", () => {
    expect(MIGRATIONS).toHaveLength(DISMISSALS + 1);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('tag_merge_dismissals') WHERE pk > 0 ORDER BY pk",
        )
        .pluck()
        .all(),
    ).toEqual(["owner_id", "key_a", "key_b"]);
    expect(db.prepare("SELECT count(*) FROM tag_merge_dismissals").pluck().get()).toBe(0);
  });

  it("refuses unsorted or equal keys, an unknown owner and a repeated pair, and lets owners share keys", () => {
    const put = (owner: string, a: string, b: string) =>
      db.prepare("INSERT INTO tag_merge_dismissals VALUES (?, ?, ?, 0)").run(owner, a, b);
    expect(() => put("a", "y", "x")).toThrow(/CHECK/);
    expect(() => put("a", "x", "x")).toThrow(/CHECK/);
    expect(() => put("nobody", "x", "y")).toThrow(/FOREIGN KEY/);
    put("a", "x", "y");
    expect(() => put("a", "x", "y")).toThrow(/UNIQUE|PRIMARY/);
    put("b", "x", "y");
  });
});
