import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

/** The index of the link_favicons entry (#272): the entries before it are the schema it starts from. */
const FAVICONS = 24;

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, FAVICONS));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO links (id, owner_id, url, url_key, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 0, 't', 'active');
  `);
  migrate(db);
});

afterEach(() => db.close());

type Row = Partial<{
  owner: string;
  candidates: string;
  status: string;
  generation: number;
  bytes: Buffer | null;
}>;
const put = (r: Row = {}) => {
  const bytes = r.bytes === undefined ? null : r.bytes;
  db.prepare(
    `INSERT INTO link_favicons (owner_id, link_id, candidates, status, generation, discovery,
       content_type, bytes, sha256, fetched_at) VALUES (?, 1, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    r.owner ?? "a",
    r.candidates ?? '["https://ex.com/f.png"]',
    r.status ?? "pending",
    r.generation ?? 1,
    bytes && "image/png",
    bytes,
    bytes && "h",
    bytes && 5,
  );
};

describe("link_favicons migration", () => {
  it("is the last entry and adds an empty table keyed by owner and link", () => {
    expect(MIGRATIONS).toHaveLength(FAVICONS + 1);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(
      db
        .prepare("SELECT name FROM pragma_table_info('link_favicons') WHERE pk > 0 ORDER BY pk")
        .pluck()
        .all(),
    ).toEqual(["owner_id", "link_id"]);
    expect(db.prepare("SELECT count(*) FROM link_favicons").pluck().get()).toBe(0);
  });

  it("refuses another owner's link, and goes with its link", () => {
    expect(() => put({ owner: "b" })).toThrow(/FOREIGN KEY/);
    put();
    db.prepare("DELETE FROM links WHERE id = 1").run();
    expect(db.prepare("SELECT count(*) FROM link_favicons").pluck().get()).toBe(0);
  });

  it.each<[string, Row]>([
    ["an unknown status", { status: "x" }],
    ["a pending row with no candidates", { candidates: "[]" }],
    ["candidates that are not a JSON array", { candidates: '{"a":1}' }],
    ["an ok row without bytes", { status: "ok" }],
    ["a pending row with bytes", { bytes: Buffer.from([1]) }],
    ["bytes over 2 MiB", { status: "ok", bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }],
    ["generation 0", { generation: 0 }],
  ])("refuses %s", (_, row) => {
    expect(() => put(row)).toThrow(/CHECK/);
  });

  it("keeps an ok row with its bytes, and a none row with no candidates", () => {
    put({ status: "ok", bytes: Buffer.from([1]) });
    db.prepare("DELETE FROM link_favicons").run();
    put({ status: "none", candidates: "[]" });
  });
});
