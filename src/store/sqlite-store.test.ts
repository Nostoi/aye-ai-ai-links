import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveLink, updateLink } from "../core/links.js";
import { describeStoreContract, type StoreHarness } from "../core/store-contract.js";
import type { NewLink, Tag } from "../core/types.js";
import { openDatabase } from "./database.js";
import { loggedEvents } from "./logged-events.js";
import { LATEST_VERSION, MIGRATIONS, migrate } from "./migrations.js";
import { SqliteStore } from "./sqlite-store.js";

type Db = Database.Database;

const open: Db[] = [];
const dirs: string[] = [];

function track(db: Db): Db {
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harnessFor(db: Db): StoreHarness {
  const store = new SqliteStore(db);
  return {
    store,
    addOwner: (owner) => store.ensureUser(owner, owner),
    all: async (owner) => {
      const ids = db.prepare("SELECT id FROM links WHERE owner_id = ? ORDER BY id").all(owner);
      const links = await Promise.all(
        ids.map((r) => store.get(owner, String((r as { id: number }).id))),
      );
      return links.flatMap((l) => (l ? [l] : []));
    },
    catalog: (owner) =>
      db
        .prepare(
          "SELECT key, name, kind, kind_source AS kindSource, color, pinned, description, project_status AS projectStatus FROM tags WHERE owner_id = ? ORDER BY id",
        )
        .all(owner)
        .map((r) => ({ ...(r as Tag), pinned: (r as { pinned: number }).pinned === 1 })),
    eventsOf: (owner, id) => loggedEvents(db, owner, id),
    seedTag: (owner, t) => {
      db.prepare(
        "INSERT INTO tags (owner_id, key, name, kind, kind_source, color, pinned, description, project_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        owner,
        t.key,
        t.name,
        t.kind,
        t.kindSource,
        t.color,
        t.pinned ? 1 : 0,
        t.description,
        t.projectStatus,
      );
    },
  };
}

describeStoreContract("SqliteStore", () => harnessFor(track(openDatabase(":memory:"))));

const NOW = new Date("2026-01-01T00:00:00Z");
const tag = (name: string) => [{ name, source: "stated" as const }];

function setup(path = ":memory:") {
  const db = track(openDatabase(path));
  const h = harnessFor(db);
  return { db, h, deps: { store: h.store, now: () => NOW } };
}

const baseLink = (): NewLink => ({
  url: "https://ex.com/a",
  urlKey: "ex.com/a",
  title: null,
  summary: null,
  summarySource: null,
  why: null,
  tags: [{ key: "t", name: "t", source: "stated", kind: "topic", kindSource: "inferred" }],
  savedAt: NOW,
  savedBy: "x",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "links-store-"));
  dirs.push(dir);
  return join(dir, "links.db");
}

async function rejection(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error("expected a rejection");
}

describe("SqliteStore on a file database", () => {
  it("keeps data across close and reopen, in tag order", async () => {
    const path = tempDb();
    const first = setup(path);
    await first.h.addOwner("a");
    await saveLink(first.deps, "a", { url: "https://ex.com/1", savedBy: "x", tags: tag("Beta") });
    await saveLink(first.deps, "a", { url: "https://ex.com/2", savedBy: "x", tags: tag("Alpha") });
    const both = [...tag("Alpha"), ...tag("Beta")];
    const { link } = await saveLink(first.deps, "a", {
      url: "https://ex.com/3",
      savedBy: "x",
      tags: both,
    });
    const flipped = await updateLink(first.deps, "a", link.id, { tags: [...both].reverse() });
    expect(flipped.tags.map((t) => t.key)).toEqual(["beta", "alpha"]);
    await updateLink(first.deps, "a", link.id, { tags: both });
    const before = await first.h.all("a");
    first.db.close();

    const second = setup(path);
    const after = await second.h.all("a");
    expect(after).toEqual(before);
    expect(after[2]?.tags.map((t) => t.key)).toEqual(["alpha", "beta"]);
  });

  it("migrating again leaves the version and data unchanged", async () => {
    const path = tempDb();
    const first = setup(path);
    await first.h.addOwner("a");
    await saveLink(first.deps, "a", { url: "https://ex.com/1", savedBy: "x" });
    const before = await first.h.all("a");
    migrate(first.db);
    expect(first.db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    first.db.close();
    const second = setup(path);
    expect(second.db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    expect(await second.h.all("a")).toEqual(before);
  });

  it("refuses a database newer than the code", () => {
    const path = tempDb();
    const first = track(openDatabase(path));
    first.pragma(`user_version = ${LATEST_VERSION + 1}`);
    first.close();
    expect(() => openDatabase(path)).toThrow(/newer/);
  });
});

describe("migrate", () => {
  it("rolls back both schema and version when a migration fails", () => {
    const db = track(new Database(":memory:"));
    const migrations = ["CREATE TABLE ok (x INTEGER)", "CREATE TABLE bad (x); SELECT * FROM nope"];
    expect(() => migrate(db, migrations)).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all()).toEqual([]);
  });

  it("rolls back earlier entries when a function migration throws", () => {
    const db = track(new Database(":memory:"));
    const migrations = [
      "CREATE TABLE ok (x)",
      () => {
        throw new Error("x");
      },
    ];
    expect(() => migrate(db, migrations)).toThrow("x");
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all()).toEqual([]);
  });

  it("sets the version to the number of migrations applied", () => {
    const db = track(new Database(":memory:"));
    migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (x)"]);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });

  describe("table rebuilds and foreign keys", () => {
    const version = (db: Db) => db.pragma("user_version", { simple: true });
    const foreignKeys = (db: Db) => db.pragma("foreign_keys", { simple: true });
    const count = (db: Db, table: string) =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const found = (db: Db, word: string) =>
      db
        .prepare("SELECT rowid FROM link_search WHERE link_search MATCH ?")
        .all(word)
        .map((r) => (r as { rowid: number }).rowid);

    async function seeded() {
      const s = setup();
      await s.h.addOwner("a");
      await saveLink(s.deps, "a", {
        url: "https://ex.com/1",
        savedBy: "x",
        title: "quokka",
        tags: [
          { name: "Wombat", source: "stated" },
          { name: "Numbat", source: "inferred" },
        ],
      });
      await saveLink(s.deps, "a", { url: "https://ex.com/2", savedBy: "x", tags: tag("Bilby") });
      return s;
    }

    /** Test-only migration: SQLite's 12-step rebuild of `table`, keeping the search triggers. */
    function rebuild(db: Db, table: string): string {
      const triggers = db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'link_search_%'",
        )
        .all() as { name: string; sql: string }[];
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as {
        sql: string;
      };
      return `
        ${triggers.map((t) => `DROP TRIGGER ${t.name};`).join("\n")}
        ${sql.replace(/^CREATE TABLE "?\w+"?/, `CREATE TABLE ${table}_new`)};
        INSERT INTO ${table}_new SELECT * FROM ${table};
        DROP TABLE ${table};
        ALTER TABLE ${table}_new RENAME TO ${table};
        ${triggers.map((t) => `${t.sql};`).join("\n")}`;
    }

    it("a rebuild of links keeps link_tags", async () => {
      const { db, h } = await seeded();
      const before = await h.all("a");
      migrate(db, [...MIGRATIONS, rebuild(db, "links")]);
      expect(version(db)).toBe(LATEST_VERSION + 1);
      expect(count(db, "link_tags")).toBe(3);
      expect(await h.all("a")).toEqual(before);
      expect(foreignKeys(db)).toBe(1);
    });

    it("a tag renamed after a rebuild is found by its new name", async () => {
      const { db } = await seeded();
      migrate(db, [...MIGRATIONS, rebuild(db, "links")]);
      db.prepare("UPDATE tags SET name = 'Platypus' WHERE key = 'wombat'").run();
      expect(found(db, "platypus")).toHaveLength(1);
      expect(found(db, "wombat")).toEqual([]);
    });

    it("a rebuild of tags succeeds and keeps the rows", async () => {
      const { db, h } = await seeded();
      const before = await h.all("a");
      migrate(db, [...MIGRATIONS, rebuild(db, "tags")]);
      expect(version(db)).toBe(LATEST_VERSION + 1);
      expect(count(db, "link_tags")).toBe(3);
      expect(await h.all("a")).toEqual(before);
    });

    it("is refused inside a transaction, with foreign keys on or off", async () => {
      const { db } = await seeded();
      const attempt = [...MIGRATIONS, rebuild(db, "links")];
      for (const start of ["ON", "OFF"]) {
        db.pragma(`foreign_keys = ${start}`);
        expect(() => db.transaction(() => migrate(db, attempt))()).toThrow(/inside a transaction/);
        expect(count(db, "link_tags")).toBe(3);
        expect(version(db)).toBe(LATEST_VERSION);
      }
    });

    it("is refused when foreign keys are off, and leaves them off", async () => {
      const { db } = await seeded();
      db.pragma("foreign_keys = OFF");
      expect(() => migrate(db, [...MIGRATIONS, rebuild(db, "links")])).toThrow(/foreign_keys = ON/);
      expect(count(db, "link_tags")).toBe(3);
      expect(version(db)).toBe(LATEST_VERSION);
      expect(foreignKeys(db)).toBe(0);
    });

    it("rolls back a migration that leaves an orphan, and turns foreign keys back on", async () => {
      const { db } = await seeded();
      const orphan = "DELETE FROM links WHERE id = 2;";
      expect(() => migrate(db, [...MIGRATIONS, orphan])).toThrow(/2 foreign key violation/);
      expect(count(db, "links")).toBe(2);
      expect(count(db, "snapshots")).toBe(2);
      expect(count(db, "link_tags")).toBe(3);
      expect(version(db)).toBe(LATEST_VERSION);
      expect(foreignKeys(db)).toBe(1);
    });

    it("refuses to report a rollback when a migration ends the transaction itself", async () => {
      const { db } = await seeded();
      const early = "CREATE TABLE z(x); COMMIT; DELETE FROM links WHERE id = 1;";
      expect(() => migrate(db, [...MIGRATIONS, early])).toThrow(/ended the transaction/);
      expect(version(db)).toBe(LATEST_VERSION);
      expect(foreignKeys(db)).toBe(1);
      expect(db.inTransaction).toBe(false);
    });

    it("turns foreign keys back on after a migration with an SQL error", async () => {
      const { db } = await seeded();
      expect(() => migrate(db, [...MIGRATIONS, "SELECT * FROM nope"])).toThrow();
      expect(version(db)).toBe(LATEST_VERSION);
      expect(foreignKeys(db)).toBe(1);
    });
  });
});

describe("the tags.kind_source migration, from version 8 with tags", () => {
  function migratedTags(): Db {
    const db = track(new Database(":memory:"));
    db.pragma("foreign_keys = ON");
    migrate(db, MIGRATIONS.slice(0, 8));
    db.exec(`
      INSERT INTO users VALUES ('a', 'a', 0);
      INSERT INTO tags (owner_id, key, name, kind, pinned) VALUES ('a', 'solar', 'Solar', 'project', 0);`);
    migrate(db);
    return db;
  }

  it("gives every existing tag the source 'inferred' and keeps its kind", () => {
    const db = migratedTags();
    expect(db.prepare("SELECT key, kind, kind_source FROM tags").all()).toEqual([
      { key: "solar", kind: "project", kind_source: "inferred" },
    ]);
  });

  it("refuses a kind source outside stated, asked and inferred, and accepts those three", () => {
    const db = migratedTags();
    const insertWith = (key: string, source: string) =>
      db
        .prepare(
          "INSERT INTO tags (owner_id, key, name, kind, kind_source, pinned) VALUES ('a', ?, ?, 'topic', ?, 0)",
        )
        .run(key, key, source);
    expect(() => insertWith("bad", "unknown")).toThrow(/CHECK/);
    for (const source of ["stated", "asked", "inferred"]) insertWith(source, source);
  });
});

describe("SqliteStore constraints", () => {
  it("has foreign keys on", () => {
    expect(setup().db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("turns foreign keys on itself, not by relying on the build default", () => {
    const proto = Database.prototype;
    const pragma = proto.pragma;
    const transaction = proto.transaction;
    const seen = new WeakSet<Db>();
    const defaultOff = (db: Db) => {
      if (seen.has(db)) return;
      seen.add(db);
      pragma.call(db, "foreign_keys = OFF");
    };
    const spies = [
      vi.spyOn(proto, "pragma").mockImplementation(function (this: Db, ...a: [string]) {
        defaultOff(this);
        return pragma.apply(this, a);
      }),
      vi.spyOn(proto, "transaction").mockImplementation(function (
        this: Db,
        fn: (...a: unknown[]) => unknown,
      ) {
        defaultOff(this);
        return transaction.call(this, fn);
      }),
    ];
    try {
      expect(setup().db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("returns the caller's own link when another owner saved the same URL, and changes nothing of the other's", async () => {
    const { db, h } = setup();
    await h.addOwner("a");
    await h.addOwner("b");
    const first = await h.store.insertIfAbsent("a", baseLink());
    const mine = await h.store.insertIfAbsent("b", baseLink());
    const owned = (owner: string) =>
      ["links", "tags", "link_tags", "snapshots"].map((t) =>
        db.prepare(`SELECT * FROM ${t} WHERE owner_id = ? ORDER BY rowid`).all(owner),
      );
    const before = owned("a");

    const again = await h.store.insertIfAbsent("b", { ...baseLink(), savedBy: "other" });

    expect(first.created).toBe(true);
    expect(mine.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.link.id).toBe(mine.link.id);
    expect(again.link.id).not.toBe(first.link.id);
    expect(again.link.savedBy).toBe("x");
    expect(owned("a")).toEqual(before);
  });

  it("refuses an unknown owner and writes nothing", async () => {
    const { db, h } = setup();
    const link = baseLink();
    const err = await rejection(h.store.insertIfAbsent("ghost", link));
    expect(err.code).toBe("unknown_owner");
    for (const table of ["links", "tags", "link_tags"]) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it("rethrows other database errors unchanged and writes nothing", async () => {
    const { db, h } = setup();
    await h.addOwner("a");
    const link = { ...baseLink(), savedBy: null as unknown as string };
    const err = await rejection(h.store.insertIfAbsent("a", link));
    expect(err.code).not.toBe("unknown_owner");
    expect(err.message).toMatch(/NOT NULL/);
    const bad = await rejection(
      h.store.insertIfAbsent("a", { ...baseLink(), savedAt: new Date(NaN) }),
    );
    expect(bad).toBeInstanceOf(RangeError);
    expect(db.prepare("SELECT count(*) AS n FROM links").get()).toEqual({ n: 0 });
  });

  describe("link_tags", () => {
    const insert =
      "INSERT INTO link_tags (owner_id, link_id, tag_id, source, position) VALUES (?, ?, ?, ?, ?)";

    async function twoOwners() {
      const s = setup();
      await s.h.addOwner("a");
      await s.h.addOwner("b");
      const a = await saveLink(s.deps, "a", { url: "https://ex.com/a", savedBy: "x" });
      const b = await saveLink(s.deps, "b", {
        url: "https://ex.com/b",
        savedBy: "x",
        tags: tag("tb"),
      });
      await saveLink(s.deps, "a", { url: "https://ex.com/a2", savedBy: "x", tags: tag("ta") });
      const tagId = (owner: string, key: string) =>
        (
          s.db.prepare("SELECT id FROM tags WHERE owner_id = ? AND key = ?").get(owner, key) as {
            id: number;
          }
        ).id;
      return { ...s, linkA: Number(a.link.id), linkB: Number(b.link.id), tagId };
    }

    it("refuses a join across owners, in both directions", async () => {
      const { db, linkA, linkB, tagId } = await twoOwners();
      const bad = [
        ["a", linkA, tagId("b", "tb")],
        ["b", linkB, tagId("a", "ta")],
      ] as const;
      for (const [owner, link, t] of bad) {
        expect(() => db.prepare(insert).run(owner, link, t, "stated", 0)).toThrow(/FOREIGN KEY/);
      }
    });

    it("refuses NULL owner, source or position", async () => {
      const { db, linkB, tagId } = await twoOwners();
      const t = tagId("b", "tb");
      const rows = [
        [null, linkB, t, "stated", 5],
        ["b", linkB, t, null, 5],
        ["b", linkB, t, "stated", null],
      ];
      for (const r of rows) expect(() => db.prepare(insert).run(...r)).toThrow(/NOT NULL/);
    });

    it("refuses an invalid source", async () => {
      const { db, linkB, tagId } = await twoOwners();
      expect(() => db.prepare(insert).run("b", linkB, tagId("b", "tb"), "bogus", 5)).toThrow(
        /CHECK/,
      );
    });
  });

  it("refuses a half-set why", async () => {
    const { db, h } = setup();
    await h.addOwner("a");
    const sql =
      "INSERT INTO links (owner_id, url, url_key, saved_at, saved_by, state, why_text) VALUES ('a', 'u', 'k', 0, 'x', 'active', 'only text')";
    expect(() => db.exec(sql)).toThrow(/CHECK/);
  });
});

describe("SqliteStore atomicity", () => {
  const boom =
    "CREATE TRIGGER boom BEFORE INSERT ON link_tags BEGIN SELECT RAISE(ABORT, 'boom'); END";
  const state = async (s: ReturnType<typeof setup>) => [await s.h.all("a"), await s.h.catalog("a")];

  it("insertIfAbsent changes nothing when attaching tags fails", async () => {
    const s = setup();
    await s.h.addOwner("a");
    await saveLink(s.deps, "a", { url: "https://ex.com/1", savedBy: "x", tags: tag("keep") });
    const before = await state(s);
    s.db.exec(boom);
    const p = saveLink(s.deps, "a", { url: "https://ex.com/2", savedBy: "x", tags: tag("new") });
    await expect(p).rejects.toThrow(/boom/);
    expect(await state(s)).toEqual(before);
  });

  it("update changes nothing when attaching tags fails", async () => {
    const s = setup();
    await s.h.addOwner("a");
    const { link } = await saveLink(s.deps, "a", {
      url: "https://ex.com/1",
      savedBy: "x",
      tags: tag("keep"),
    });
    const before = await state(s);
    s.db.exec(boom);
    const p = updateLink(s.deps, "a", link.id, { summary: "changed", tags: tag("new") });
    await expect(p).rejects.toThrow(/boom/);
    expect(await state(s)).toEqual(before);
  });

  it("updateWithReceipt rolls back the values, the catalog and the receipt together when attaching tags fails", async () => {
    const s = setup();
    await s.h.addOwner("a");
    const { link } = await saveLink(s.deps, "a", {
      url: "https://ex.com/1",
      savedBy: "x",
      tags: tag("keep"),
    });
    const edits = () => s.db.prepare("SELECT * FROM link_edits").all();
    const before = [await state(s), edits()];
    s.db.exec(boom);
    const p = s.h.store.updateWithReceipt(
      "a",
      link.id,
      {
        title: "changed",
        summary: "changed",
        why: { text: "w", source: "inferred" },
        tags: [
          { key: "new", name: "new", source: "inferred", kind: "topic", kindSource: "inferred" },
        ],
      },
      NOW,
    );
    await expect(p).rejects.toThrow(/boom/);
    expect([await state(s), edits()]).toEqual(before);
    expect(before[1]).toEqual([]);
  });

  it("claimSurfaced marks nothing when a later mark in the same call fails", async () => {
    const s = setup();
    await s.h.addOwner("a");
    const first = await saveLink(s.deps, "a", { url: "https://ex.com/1", savedBy: "x" });
    const second = await saveLink(s.deps, "a", { url: "https://ex.com/2", savedBy: "x" });
    const before = await state(s);
    s.db.exec(
      `CREATE TRIGGER boom BEFORE UPDATE OF last_surfaced_at ON links WHEN NEW.id = ${second.link.id}
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const p = s.h.store.claimSurfaced("a", [first.link.id, second.link.id], {
      at: NOW,
      notSurfacedAfter: NOW,
      now: NOW,
    });
    await expect(p).rejects.toThrow(/boom/);
    expect(await state(s)).toEqual(before);
  });
});
