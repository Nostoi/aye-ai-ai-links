import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

type Db = Database.Database;

/** The index of the intent_guesses entry: the entries before it are the schema it starts from. */
const INTENT_GUESSES = 28;

let db: Db;

const link = (id: number, extra: { state?: string; source?: string | null; gone?: boolean } = {}) =>
  db
    .prepare(
      `INSERT INTO links (id, owner_id, url, url_key, title, saved_at, saved_by, state,
         intent, intent_source, deleted_at)
       VALUES (?, 'a', ?, ?, 't', 5, 'x', ?, ?, ?, ?)`,
    )
    .run(
      id,
      `https://ex.com/${id}`,
      `ex.com/${id}`,
      extra.state ?? "active",
      extra.source ? "keep" : "explore",
      extra.source ?? null,
      extra.gone ? 9 : null,
    );

const queue = () =>
  db.prepare("SELECT link_id, outcome, tries FROM intent_guesses ORDER BY link_id").all();

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, INTENT_GUESSES));
  expect(db.pragma("user_version", { simple: true })).toBe(INTENT_GUESSES);
  db.exec("INSERT INTO users VALUES ('a', 'a', 0)");
  link(1);
  link(2, { source: "stated" });
  link(3, { state: "archived" });
  link(4, { gone: true });
  link(5, { source: "inferred" });
  link(6);
  migrate(db);
});

afterEach(() => db.close());

describe("intent_guesses migration", () => {
  it("is the last entry and queues exactly the live active links nobody has spoken for", () => {
    expect(MIGRATIONS).toHaveLength(INTENT_GUESSES + 1);
    expect(queue()).toEqual([
      { link_id: 1, outcome: null, tries: 0 },
      { link_id: 6, outcome: null, tries: 0 },
    ]);
  });

  it("refuses an unknown outcome and a link that does not exist, and a purged link takes its row", () => {
    const put = (id: number, outcome: string) =>
      db
        .prepare("INSERT INTO intent_guesses (owner_id, link_id, outcome) VALUES ('a', ?, ?)")
        .run(id, outcome);
    expect(() => put(2, "maybe")).toThrow(/CHECK/);
    expect(() => put(99, "keep")).toThrow(/FOREIGN KEY/);
    put(2, "failed");
    expect(() => put(2, "keep")).toThrow(/UNIQUE|PRIMARY/);
    db.prepare("DELETE FROM links WHERE id IN (1, 2)").run();
    expect(queue()).toEqual([{ link_id: 6, outcome: null, tries: 0 }]);
  });
});
