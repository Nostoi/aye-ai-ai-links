import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_VERSION, MIGRATIONS, migrate } from "./migrations.js";

type Db = Database.Database;

/** The index of the summary-source entry: the entries before it are the schema it starts from. */
const SUMMARY_SOURCE = 19;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, SUMMARY_SOURCE));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0);
    INSERT INTO links (id, owner_id, url, url_key, title, summary, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 't', 'S', 5, 'x', 'active'),
             (2, 'a', 'https://ex.com/2', 'ex.com/2', 't', NULL, 5, 'x', 'active');`);
  migrate(db);
});

afterEach(() => db.close());

describe("summary source migration", () => {
  it("is the last entry", () => {
    expect(LATEST_VERSION).toBe(SUMMARY_SOURCE + 1);
  });

  it("leaves an old summary unlabelled", () => {
    expect(db.prepare("SELECT summary, summary_source FROM links WHERE id = 1").get()).toEqual({
      summary: "S",
      summary_source: null,
    });
  });

  it("refuses a source with no summary, and an unknown source", () => {
    expect(() => db.exec("UPDATE links SET summary_source = 'server' WHERE id = 2")).toThrow(
      /CHECK/,
    );
    expect(() => db.exec("UPDATE links SET summary_source = 'robot' WHERE id = 1")).toThrow(
      /CHECK/,
    );
    db.exec("UPDATE links SET summary_source = 'server' WHERE id = 1");
  });

  it("gives link_edits columns for the summary's source", () => {
    const cols = (db.pragma("table_info(link_edits)") as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["prior_summary_source", "written_summary_source"]),
    );
  });
});
