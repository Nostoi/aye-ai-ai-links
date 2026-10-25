import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

/** The index of the stats_readings entry: the entries before it are the schema it starts from. */
const STATS_READINGS = 21;

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, STATS_READINGS));
  db.exec("INSERT INTO users VALUES ('a', 'a', 0);");
  migrate(db);
});

afterEach(() => db.close());

describe("stats_readings migration", () => {
  it("is followed by the tag edits and tag merge dismissals entries and adds an empty table", () => {
    expect(MIGRATIONS).toHaveLength(STATS_READINGS + 3);
    expect(db.prepare("SELECT 1 FROM stats_readings").all()).toEqual([]);
  });

  it("refuses an empty text, an unknown owner and a second row for one owner", () => {
    const put = (owner: string, text: string) =>
      db.prepare("INSERT INTO stats_readings VALUES (?, ?, 'm', 1, 'h')").run(owner, text);
    expect(() => put("a", "")).toThrow(/CHECK/);
    expect(() => put("nobody", "ok")).toThrow(/FOREIGN KEY/);
    put("a", "ok");
    expect(() => put("a", "again")).toThrow(/UNIQUE|PRIMARY/);
  });
});
