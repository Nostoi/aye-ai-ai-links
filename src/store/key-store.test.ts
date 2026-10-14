import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { KeyStoreError, SqliteKeyStore } from "./key-store.js";

type Db = Database.Database;
const open: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memory(): Db {
  const db = openDatabase(":memory:");
  open.push(db);
  return db;
}

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "aye-keys-"));
  dirs.push(dir);
  return join(dir, "test.db");
}

function openAt(path: string): Db {
  const db = openDatabase(path);
  open.push(db);
  return db;
}

const NOW = new Date("2026-10-11T00:00:00Z");
const LATER = new Date("2026-10-12T00:00:00Z");
const users = (db: Db) => db.prepare("SELECT id FROM users ORDER BY id").all();

describe("SqliteKeyStore", () => {
  it("creates the owner on a fresh database and finds the key by its hash", () => {
    const db = memory();
    const keys = new SqliteKeyStore(db);
    keys.create("mark", "Mark", "codex", "h1", NOW);
    expect(users(db)).toEqual([{ id: "mark" }]);
    expect(keys.findLiveByHash("h1")).toEqual({ owner: "mark", name: "codex" });
    expect(keys.findLiveByHash("other")).toBeNull();
  });

  it("lists an owner's keys by the ids create returned, without hashes", () => {
    const keys = new SqliteKeyStore(memory());
    const first = keys.create("mark", "Mark", "codex", "secret-hash", NOW);
    keys.revoke("mark", "codex", LATER);
    const second = keys.create("mark", "Mark", "codex", "h2", LATER);
    expect(second).not.toBe(first);
    const listed = keys.list("mark");
    expect(listed).toEqual([
      { id: first, name: "codex", createdAt: NOW, revokedAt: LATER },
      { id: second, name: "codex", createdAt: LATER, revokedAt: null },
    ]);
    expect(JSON.stringify(listed)).not.toContain("hash");
  });

  it("revokeById turns off only that owner's key, and only while it is on", () => {
    const keys = new SqliteKeyStore(memory());
    const mine = keys.create("mark", "Mark", "codex", "hm", NOW);
    const theirs = keys.create("alice", "Alice", "codex", "ha", NOW);
    expect(keys.revokeById("mark", theirs, LATER)).toBe(false);
    expect(keys.revokeById("mark", 9999, LATER)).toBe(false);
    expect(keys.findLiveByHash("ha")).toEqual({ owner: "alice", name: "codex" });
    expect(keys.revokeById("mark", mine, LATER)).toBe(true);
    expect(keys.findLiveByHash("hm")).toBeNull();
    expect(keys.revokeById("mark", mine, new Date("2026-10-13T00:00:00Z"))).toBe(false);
    expect(keys.list("mark")[0]?.revokedAt).toEqual(LATER);
  });

  it("revokeById of a turned-off key leaves the new key with its name on", () => {
    const keys = new SqliteKeyStore(memory());
    const old = keys.create("mark", "Mark", "codex", "old", NOW);
    keys.revokeById("mark", old, NOW);
    keys.create("mark", "Mark", "codex", "new", NOW);
    expect(keys.revokeById("mark", old, LATER)).toBe(false);
    expect(keys.findLiveByHash("new")).toEqual({ owner: "mark", name: "codex" });
  });

  describe("restore", () => {
    const OFF = new Date("2026-10-11T12:00:00.000Z");
    const offKey = () => {
      const keys = new SqliteKeyStore(memory());
      const id = keys.create("mark", "Mark", "codex", "h1", NOW);
      keys.revokeById("mark", id, OFF);
      return { keys, id };
    };

    it("turns a key back on when it went off at or after `since`", () => {
      const { keys, id } = offKey();
      expect(keys.restore("mark", id, OFF)).toBe(true);
      expect(keys.findLiveByHash("h1")).toEqual({ owner: "mark", name: "codex" });
      expect(keys.list("mark")[0]?.revokedAt).toBeNull();
    });

    it("leaves a key off that went off before `since`", () => {
      const { keys, id } = offKey();
      expect(keys.restore("mark", id, new Date(OFF.getTime() + 1))).toBe(false);
      expect(keys.findLiveByHash("h1")).toBeNull();
      expect(keys.list("mark")[0]?.revokedAt).toEqual(OFF);
    });

    it("leaves another owner's key off, and a key that is on as it is", () => {
      const { keys, id } = offKey();
      keys.create("alice", "Alice", "x", "ha", NOW);
      expect(keys.restore("alice", id, NOW)).toBe(false);
      expect(keys.findLiveByHash("h1")).toBeNull();
      const live = keys.create("mark", "Mark", "claude", "h2", NOW);
      expect(keys.restore("mark", live, NOW)).toBe(false);
      expect(keys.list("mark")[1]?.revokedAt).toBeNull();
    });

    it("refuses with name_taken when a key with the same name was made since, and both stay as they were", () => {
      const { keys, id } = offKey();
      keys.create("mark", "Mark", "codex", "h2", LATER);
      expect(() => keys.restore("mark", id, OFF)).toThrow(
        expect.objectContaining({ name: "KeyStoreError", code: "name_taken" }),
      );
      expect(keys.findLiveByHash("h1")).toBeNull();
      expect(keys.findLiveByHash("h2")).toEqual({ owner: "mark", name: "codex" });
    });

    it("refuses with name_taken when the key with the same name made since is off too, and the old stays off", () => {
      const { keys, id } = offKey();
      const newer = keys.create("mark", "Mark", "codex", "h2", LATER);
      keys.revokeById("mark", newer, LATER);
      expect(() => keys.restore("mark", id, OFF)).toThrow(
        expect.objectContaining({ name: "KeyStoreError", code: "name_taken" }),
      );
      expect(keys.findLiveByHash("h1")).toBeNull();
      expect(keys.list("mark")[0]?.revokedAt).toEqual(OFF);
    });

    it("still restores when only another owner or another name has a newer key", () => {
      const { keys, id } = offKey();
      keys.create("alice", "Alice", "codex", "ha", LATER);
      keys.create("mark", "Mark", "claude", "hc", LATER);
      expect(keys.restore("mark", id, OFF)).toBe(true);
      expect(keys.findLiveByHash("h1")).toEqual({ owner: "mark", name: "codex" });
    });

    it("restores the newest key with a name though an older one with it is off", () => {
      const { keys } = offKey();
      const newer = keys.create("mark", "Mark", "codex", "h2", LATER);
      keys.revokeById("mark", newer, LATER);
      expect(keys.restore("mark", newer, LATER)).toBe(true);
      expect(keys.findLiveByHash("h2")).toEqual({ owner: "mark", name: "codex" });
      expect(keys.findLiveByHash("h1")).toBeNull();
    });
  });

  it("refuses a second live key for the same owner and agent", () => {
    const keys = new SqliteKeyStore(memory());
    keys.create("mark", "Mark", "codex", "h1", NOW);
    expect(() => keys.create("mark", "Mark", "codex", "h2", NOW)).toThrow(KeyStoreError);
    expect(keys.findLiveByHash("h2")).toBeNull();
  });

  it("allows a new key after revoking, and the old hash stops resolving", () => {
    const keys = new SqliteKeyStore(memory());
    keys.create("mark", "Mark", "codex", "old", NOW);
    expect(keys.revoke("mark", "codex", LATER)).toBe(true);
    keys.create("mark", "Mark", "codex", "new", LATER);
    expect(keys.findLiveByHash("old")).toBeNull();
    expect(keys.findLiveByHash("new")).toEqual({ owner: "mark", name: "codex" });
  });

  it("revoke returns false when there is no live key, and changes nothing", () => {
    const keys = new SqliteKeyStore(memory());
    keys.create("mark", "Mark", "codex", "h1", NOW);
    expect(keys.revoke("mark", "claude", LATER)).toBe(false);
    expect(keys.revoke("mark", "codex", LATER)).toBe(true);
    expect(keys.revoke("mark", "codex", new Date("2026-10-13T00:00:00Z"))).toBe(false);
    expect(keys.list("mark")[0]?.revokedAt).toEqual(LATER);
  });

  it("keeps owners apart: list and revoke as one owner leave the other's keys alone", () => {
    const keys = new SqliteKeyStore(memory());
    keys.create("mark", "Mark", "codex", "hm", NOW);
    const alices = keys.create("alice", "Alice", "codex", "ha", NOW);
    expect(keys.list("mark")).toHaveLength(1);
    expect(keys.list("alice")).toHaveLength(1);
    expect(keys.revoke("mark", "codex", LATER)).toBe(true);
    expect(keys.findLiveByHash("hm")).toBeNull();
    expect(keys.findLiveByHash("ha")).toEqual({ owner: "alice", name: "codex" });
    expect(keys.list("alice")).toEqual([
      { id: alices, name: "codex", createdAt: NOW, revokedAt: null },
    ]);
    expect(keys.revoke("mark", "codex", LATER)).toBe(false);
  });

  it("rolls the new owner back when the key insert fails after the user is ensured", () => {
    const db = memory();
    const keys = new SqliteKeyStore(db);
    keys.create("mark", "Mark", "codex", "dup", NOW);
    expect(() => keys.create("alice", "Alice", "codex", "dup", NOW)).toThrow();
    expect(users(db)).toEqual([{ id: "mark" }]);
  });

  it("leaves exactly one live key when two handles create for the same owner and agent", () => {
    const path = tempPath();
    const a = openAt(path);
    const b = openAt(path);
    const outcomes = [
      () => new SqliteKeyStore(a).create("mark", "Mark", "codex", "ha", NOW),
      () => new SqliteKeyStore(b).create("mark", "Mark", "codex", "hb", NOW),
    ].map((create) => {
      try {
        create();
        return "ok";
      } catch (error) {
        return error instanceof KeyStoreError ? error.code : "other";
      }
    });
    expect(outcomes).toEqual(["ok", "key_exists"]);
    expect(
      a.prepare("SELECT count(*) AS n FROM agent_keys WHERE revoked_at IS NULL").get(),
    ).toEqual({ n: 1 });
  });

  it("is backed by an index that refuses a second live row even if the check is bypassed", () => {
    const db = memory();
    new SqliteKeyStore(db).create("mark", "Mark", "codex", "h1", NOW);
    const insert = db.prepare(
      "INSERT INTO agent_keys (owner_id, name, hash, created_at) VALUES ('mark', 'codex', ?, 1)",
    );
    expect(() => insert.run("h2")).toThrow(/UNIQUE/);
  });
});
