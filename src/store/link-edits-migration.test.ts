import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

type Db = Database.Database;

/** The index of the link_edits rebuild: the 17 entries before it are the schema it starts from. */
const LINK_EDITS_REBUILD = 17;

const insert = (db: Db, cols: Record<string, unknown>) => {
  const row = { owner_id: "a", link_id: 1, edit_id: "e1", at: 9, ...cols };
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO link_edits (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
};

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, LINK_EDITS_REBUILD));
  expect(db.pragma("user_version", { simple: true })).toBe(LINK_EDITS_REBUILD);
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0);
    INSERT INTO links (id, owner_id, url, url_key, title, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 'quokka', 5, 'x', 'active');`);
});

describe("migration 18: link_edits widens for AI edit receipts", () => {
  it("keeps a pending dialog receipt, with the new flags at 0", () => {
    const bytes = Buffer.from([1, 2, 3]);
    insert(db, {
      title_changed: 1,
      picture_changed: 1,
      prior_title: "old",
      written_title: "new",
      prior_content_type: "image/png",
      prior_bytes: bytes,
      prior_sha256: "p",
      prior_set_at: 7,
      written_sha256: "w",
    });
    migrate(db);
    const row = db.prepare("SELECT * FROM link_edits").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      owner_id: "a",
      link_id: 1,
      edit_id: "e1",
      title_changed: 1,
      picture_changed: 1,
      prior_title: "old",
      written_title: "new",
      prior_content_type: "image/png",
      prior_sha256: "p",
      prior_set_at: 7,
      written_sha256: "w",
      at: 9,
      summary_changed: 0,
      why_changed: 0,
      tags_changed: 0,
    });
    expect(Buffer.from(row.prior_bytes as Buffer)).toEqual(bytes);
  });

  it("accepts a summary-only receipt only after the upgrade", () => {
    const summaryOnly = {
      title_changed: 0,
      picture_changed: 0,
      summary_changed: 1,
      prior_summary: "a",
      written_summary: "b",
    };
    migrate(db);
    insert(db, summaryOnly);
    expect(db.prepare("SELECT summary_changed FROM link_edits").get()).toEqual({
      summary_changed: 1,
    });
  });

  it("still refuses a row that changes nothing, and a half-set picture", () => {
    migrate(db);
    expect(() => insert(db, { title_changed: 0, picture_changed: 0 })).toThrow(/CHECK/);
    expect(() => insert(db, { title_changed: 1, picture_changed: 0, prior_sha256: "p" })).toThrow(
      /CHECK/,
    );
  });

  it("still deletes the row with its link", () => {
    insert(db, { title_changed: 1, picture_changed: 0 });
    migrate(db);
    db.prepare("DELETE FROM links WHERE id = 1").run();
    expect(db.prepare("SELECT count(*) AS n FROM link_edits").get()).toEqual({ n: 0 });
  });
});
