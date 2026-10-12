import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { saveLink } from "../core/links.js";
import type { SearchTrace } from "../core/search.js";
import { searchLinks } from "../core/search-links.js";
import type { SearchLogEntry } from "../core/search-log.js";
import { openDatabase } from "./database.js";
import { LATEST_VERSION, MIGRATIONS, migrate } from "./migrations.js";
import { SqliteSearchLog } from "./search-log.js";
import { SqliteStore } from "./sqlite-store.js";

type TraceFn = (t: SearchTrace) => void;
const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

function fresh() {
  const db = openDatabase(":memory:");
  open.push(db);
  const users = new SqliteStore(db);
  for (const o of ["a", "b"]) users.ensureUser(o, o);
  return { db, log: new SqliteSearchLog(db) };
}

const entry = (query = "solar"): SearchLogEntry => ({
  query,
  filters: {},
  mode: "hybrid",
  embedded: query,
  modelKey: "m",
  meaningCandidates: 2,
  results: [{ id: "1", urlKey: "ex.com/1", similarity: 0.5, ranks: { page: 2, meaning: 1 } }],
});

const T = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 12, minutes));
const SINCE = T(-30);
const link = { id: "9", urlKey: "ex.com/9" };

type Row = {
  id: number;
  searched_by: string;
  opened_link_id: number | null;
  opened_url_key: string | null;
  opened_at: number | null;
};
const rows = (db: Database.Database) =>
  db
    .prepare(
      "SELECT id, searched_by, opened_link_id, opened_url_key, opened_at FROM search_log ORDER BY id",
    )
    .all() as Row[];
const opened = (db: Database.Database) => rows(db).map((r) => r.opened_link_id);

describe("migration 8, search_log", () => {
  it("C2-T1: creates the table, rejects an empty query, and keeps older data", () => {
    const db = new Database(":memory:");
    open.push(db);
    db.pragma("foreign_keys = ON");
    migrate(db, MIGRATIONS.slice(0, 7));
    db.prepare("INSERT INTO users (id, display_name, created_at) VALUES ('a', 'a', 0)").run();
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(8);
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
    const insert = (query: string, mode = "hybrid") =>
      db
        .prepare(
          "INSERT INTO search_log (owner_id, searched_by, query, filters, mode, meaning_candidates, results, created_at) VALUES ('a', 'x', ?, '{}', ?, 0, '[]', 0)",
        )
        .run(query, mode);
    expect(() => insert("")).toThrow(/CHECK/);
    expect(() => insert("q", "other")).toThrow(/CHECK/);
    expect(insert("q").changes).toBe(1);
  });
});

describe("SqliteSearchLog.record", () => {
  it("stores the entry as given, with filter dates as epoch milliseconds", async () => {
    const { db, log } = fresh();
    const savedFrom = new Date(1000);
    await log.record("a", "claude", { ...entry(), filters: { tagKey: "t", savedFrom } }, T(0));
    expect(db.prepare("SELECT * FROM search_log").get()).toMatchObject({
      owner_id: "a",
      searched_by: "claude",
      query: "solar",
      filters: JSON.stringify({ tagKey: "t", savedFrom: 1000 }),
      mode: "hybrid",
      embedded: "solar",
      model_key: "m",
      meaning_candidates: 2,
      results: JSON.stringify([
        { id: "1", urlKey: "ex.com/1", similarity: 0.5, ranks: { page: 2, meaning: 1 } },
      ]),
      created_at: T(0).getTime(),
      opened_link_id: null,
      opened_url_key: null,
      opened_at: null,
    });
  });

  it("refuses an unknown owner", async () => {
    const { log } = fresh();
    await expect(log.record("ghost", "claude", entry(), T(0))).rejects.toThrow();
  });
});

describe("SqliteSearchLog.pairOpen", () => {
  it("C2-T2: pairs the same agent's latest search and records the link and its urlKey", async () => {
    const { db, log } = fresh();
    await log.record("a", "claude", entry(), T(0));
    await log.pairOpen("a", "claude", link, SINCE, T(5));
    expect(rows(db)).toEqual([
      {
        id: 1,
        searched_by: "claude",
        opened_link_id: 9,
        opened_url_key: "ex.com/9",
        opened_at: T(5).getTime(),
      },
    ]);
  });

  it("C2-T2: another agent's get_link does not pair, and leaves the row unpaired", async () => {
    const { db, log } = fresh();
    await log.record("a", "claude", entry(), T(0));
    await log.pairOpen("a", "codex", link, SINCE, T(5));
    expect(opened(db)).toEqual([null]);
    expect(rows(db)[0]?.opened_at).toBeNull();
  });

  it("C2-T2: a search from before the window is not paired", async () => {
    const { db, log } = fresh();
    await log.record("a", "claude", entry(), T(0));
    await log.pairOpen("a", "claude", link, T(1), T(31));
    expect(opened(db)).toEqual([null]);
  });

  it("C2-T2: a search exactly at the window edge is paired", async () => {
    const { db, log } = fresh();
    await log.record("a", "claude", entry(), T(0));
    await log.pairOpen("a", "claude", link, T(0), T(30));
    expect(opened(db)).toEqual([9]);
  });

  it("C2-T2: a second get_link does not overwrite the first", async () => {
    const { db, log } = fresh();
    await log.record("a", "claude", entry(), T(0));
    await log.pairOpen("a", "claude", link, SINCE, T(1));
    await log.pairOpen("a", "claude", { id: "10", urlKey: "ex.com/10" }, SINCE, T(2));
    expect(rows(db)[0]).toMatchObject({ opened_link_id: 9, opened_at: T(1).getTime() });
  });

  it("C2-T2: with searches A then B, only B is paired, and a second open pairs neither", async () => {
    const { db, log } = fresh();
    await log.record("a", "claude", entry("A"), T(0));
    await log.record("a", "claude", entry("B"), T(1));
    await log.pairOpen("a", "claude", link, SINCE, T(2));
    expect(opened(db)).toEqual([null, 9]);
    await log.pairOpen("a", "claude", { id: "10", urlKey: "ex.com/10" }, SINCE, T(3));
    expect(opened(db)).toEqual([null, 9]);
  });

  it("C2-T7: with searches at the same instant, the higher id is paired", async () => {
    const { db, log } = fresh();
    await log.record("a", "claude", entry("A"), T(0));
    await log.record("a", "claude", entry("B"), T(0));
    await log.pairOpen("a", "claude", link, SINCE, T(1));
    expect(opened(db)).toEqual([null, 9]);
  });

  it("C2-T2: one agent's later search is not paired by another agent's open", async () => {
    const { db, log } = fresh();
    await log.record("a", "claude", entry("A"), T(0));
    await log.record("a", "codex", entry("B"), T(1));
    await log.pairOpen("a", "claude", link, SINCE, T(2));
    expect(opened(db)).toEqual([9, null]);
  });

  it("C2-T2: owners are isolated both ways", async () => {
    const { db, log } = fresh();
    await log.record("a", "claude", entry(), T(0));
    await log.pairOpen("b", "claude", link, SINCE, T(1));
    expect(opened(db)).toEqual([null]);
    await log.record("b", "claude", entry(), T(2));
    await log.pairOpen("a", "claude", link, SINCE, T(3));
    expect(opened(db)).toEqual([9, null]);
  });
});

describe("a deleted link's reused id", () => {
  it("C2-T6: the logged url key tells the old link from the one that took its id", async () => {
    const { db, log } = fresh();
    const store = new SqliteStore(db);
    const deps = { store, now: () => T(0) };
    const first = (await saveLink(deps, "a", { url: "https://ex.com/old", savedBy: "t" })).link;
    const search = {
      search: async (_o: string, _q: string, _f: object, _l: number, trace?: TraceFn) => {
        trace?.({
          mode: "keyword",
          embedded: null,
          modelKey: null,
          similarity: {},
          meaningCandidates: 0,
          ranks: { [first.id]: { field: 1 } },
        });
        return [first.id];
      },
    };
    await searchLinks(
      { store, search, searchLog: log, now: () => T(0) },
      "a",
      { query: "old" },
      "x",
    );

    db.prepare("DELETE FROM snapshots WHERE link_id = ?").run(Number(first.id));
    db.prepare("DELETE FROM links WHERE id = ?").run(Number(first.id));
    const second = (await saveLink(deps, "a", { url: "https://ex.com/new", savedBy: "t" })).link;

    expect(second.id).toBe(first.id);
    const row = db.prepare("SELECT results FROM search_log").get() as { results: string };
    const [logged] = JSON.parse(row.results) as { id: string; urlKey: string }[];
    expect(logged?.id).toBe(second.id);
    expect(logged?.urlKey).toBe(first.urlKey);
    expect(logged?.urlKey).not.toBe(second.urlKey);
  });
});
