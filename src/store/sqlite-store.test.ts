import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveLink, updateLink } from "../core/links.js";
import { describeStoreContract, type StoreHarness } from "../core/store-contract.js";
import type { NewLink, Tag } from "../core/types.js";
import { openDatabase } from "./database.js";
import { LATEST_VERSION, migrate } from "./migrations.js";
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
          "SELECT key, name, kind, color, pinned, description, project_status AS projectStatus FROM tags WHERE owner_id = ? ORDER BY id",
        )
        .all(owner)
        .map((r) => ({ ...(r as Tag), pinned: (r as { pinned: number }).pinned === 1 })),
    seedTag: (owner, t) => {
      db.prepare(
        "INSERT INTO tags (owner_id, key, name, kind, color, pinned, description, project_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        owner,
        t.key,
        t.name,
        t.kind,
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
  why: null,
  tags: [{ key: "t", name: "t", source: "stated" }],
  savedAt: NOW,
  savedBy: "x",
  lastOpenedAt: null,
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

  it("sets the version to the number of migrations applied", () => {
    const db = track(new Database(":memory:"));
    migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (x)"]);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
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
});
