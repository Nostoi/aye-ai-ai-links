import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addProfile, editProfile } from "../core/profile.js";
import {
  A,
  changes,
  describeProfileStoreContract,
  type ProfileHarness,
} from "../core/profile-store-contract.js";
import { openDatabase } from "./database.js";
import { LATEST_VERSION, MIGRATIONS, migrate } from "./migrations.js";
import { SqliteProfileStore } from "./profile-store.js";
import { SqliteStore } from "./sqlite-store.js";

type Db = ReturnType<typeof openDatabase>;

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

function fresh(): { db: Db; harness: ProfileHarness; store: SqliteProfileStore } {
  const db = openDatabase(":memory:");
  open.push(db);
  const store = new SqliteProfileStore(db);
  const users = new SqliteStore(db);
  return { db, store, harness: { store, addOwner: (o) => users.ensureUser(o, o) } };
}

describeProfileStoreContract("SqliteProfileStore", () => fresh().harness);

const AT = new Date("2026-01-01T00:00:00Z");
const ctx = { writtenBy: "x", at: AT, focusLimit: 10, purgeBefore: new Date(0) };
const count = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("SqliteProfileStore only", () => {
  it("refuses an unknown owner on add and writes nothing", async () => {
    const { db, store } = fresh();
    await expect(
      store.apply(
        "ghost",
        changes({
          addNotes: [{ text: "n", source: "stated" }],
          addFocus: [{ text: "f", source: "stated" }],
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "unknown_owner" });
    expect(count(db, "profile_notes")).toBe(0);
    expect(count(db, "focus_log")).toBe(0);
  });

  it("rolls back earlier adds when a later add fails on an unknown owner", async () => {
    const { db, store } = fresh();
    await expect(
      store.apply("ghost", changes({ addFocus: [{ text: "f", source: "stated" }] }), ctx),
    ).rejects.toMatchObject({ code: "unknown_owner" });
    expect(count(db, "focus_log")).toBe(0);
  });

  it("has CHECKs for a source outside the set and for empty text", () => {
    const { db } = fresh();
    new SqliteStore(db).ensureUser(A, A);
    const note = (text: string, source: string) =>
      db
        .prepare(
          "INSERT INTO profile_notes (owner_id, text, source, written_by, updated_at) VALUES (?, ?, ?, 'x', 0)",
        )
        .run(A, text, source);
    const focus = (text: string, source: string) =>
      db
        .prepare(
          "INSERT INTO focus_log (owner_id, text, source, written_by, created_at) VALUES (?, ?, ?, 'x', 0)",
        )
        .run(A, text, source);
    expect(() => note("ok", "guessed")).toThrow(/CHECK/);
    expect(() => note("", "stated")).toThrow(/CHECK/);
    expect(() => focus("ok", "guessed")).toThrow(/CHECK/);
    expect(() => focus("", "stated")).toThrow(/CHECK/);
    expect(() => note("ok", "stated")).not.toThrow();
    expect(() => focus("ok", "inferred")).not.toThrow();
  });

  it("keeps a note the owner made stated on another connection after an inferred edit read it as inferred, answering conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-wal-"));
    try {
      const path = join(dir, "db.sqlite");
      const c1 = openDatabase(path);
      const c2 = openDatabase(path);
      open.push(c1, c2);
      new SqliteStore(c1).ensureUser(A, A);
      const s1 = new SqliteProfileStore(c1);
      const s2 = new SqliteProfileStore(c2);
      const now = () => AT;
      const { addedNoteIds } = await addProfile({ profile: s1, now }, A, "codex", {
        addNotes: [{ text: "probably lives in York", source: "inferred" }],
      });
      const id = addedNoteIds[0] as string;
      const read = s1.listNotes.bind(s1);
      let fired = false;
      s1.listNotes = async (o) => {
        const seen = await read(o);
        if (!fired) {
          fired = true;
          await editProfile({ profile: s2, now }, A, "claude", {
            editNotes: [{ id, text: "lives in Leeds", source: "stated" }],
          });
        }
        return seen;
      };
      await expect(
        editProfile({ profile: s1, now }, A, "codex", {
          editNotes: [{ id, text: "lives in York, guessed", source: "inferred" }],
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await s2.listNotes(A)).toEqual([
        { id, text: "lives in Leeds", source: "stated", writtenBy: "claude", updatedAt: AT },
      ]);
    } finally {
      for (const db of open.splice(0)) if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps both notes when a mixed edit and removal both changed source on another connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-wal-"));
    try {
      const path = join(dir, "db.sqlite");
      const c1 = openDatabase(path);
      const c2 = openDatabase(path);
      open.push(c1, c2);
      new SqliteStore(c1).ensureUser(A, A);
      const s1 = new SqliteProfileStore(c1);
      const s2 = new SqliteProfileStore(c2);
      const now = () => AT;
      const { addedNoteIds } = await addProfile({ profile: s1, now }, A, "codex", {
        addNotes: [
          { text: "edit me", source: "inferred" },
          { text: "remove me", source: "inferred" },
        ],
      });
      const [editId, removeId] = addedNoteIds as [string, string];
      const read = s1.listNotes.bind(s1);
      let fired = false;
      s1.listNotes = async (o) => {
        const seen = await read(o);
        if (!fired) {
          fired = true;
          await editProfile({ profile: s2, now }, A, "claude", {
            editNotes: [{ id: editId, text: "edit me", source: "asked" }],
          });
          await editProfile({ profile: s2, now }, A, "claude", {
            editNotes: [{ id: removeId, text: "OWNER", source: "stated" }],
          });
        }
        return seen;
      };
      await expect(
        editProfile({ profile: s1, now }, A, "codex", {
          editNotes: [{ id: editId, text: "guessed", source: "inferred" }],
          removeNotes: [removeId],
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await s2.listNotes(A)).toEqual([
        { id: editId, text: "edit me", source: "asked", writtenBy: "claude", updatedAt: AT },
        { id: removeId, text: "OWNER", source: "stated", writtenBy: "claude", updatedAt: AT },
      ]);
    } finally {
      for (const db of open.splice(0)) if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a note the owner made stated on another connection after a removal read it as inferred", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-wal-"));
    try {
      const path = join(dir, "db.sqlite");
      const c1 = openDatabase(path);
      const c2 = openDatabase(path);
      open.push(c1, c2);
      new SqliteStore(c1).ensureUser(A, A);
      const s1 = new SqliteProfileStore(c1);
      const s2 = new SqliteProfileStore(c2);
      const now = () => AT;
      const { addedNoteIds } = await addProfile({ profile: s1, now }, A, "codex", {
        addNotes: [{ text: "probably lives in York", source: "inferred" }],
      });
      const id = addedNoteIds[0] as string;
      const read = s1.listNotes.bind(s1);
      let fired = false;
      s1.listNotes = async (o) => {
        const seen = await read(o);
        if (!fired) {
          fired = true;
          await editProfile({ profile: s2, now }, A, "claude", {
            editNotes: [{ id, text: "lives in Leeds", source: "stated" }],
          });
        }
        return seen;
      };
      await expect(
        editProfile({ profile: s1, now }, A, "codex", { removeNotes: [id] }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await s2.listNotes(A)).toEqual([
        { id, text: "lives in Leeds", source: "stated", writtenBy: "claude", updatedAt: AT },
      ]);
    } finally {
      for (const db of open.splice(0)) if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a removed note's row until it is purged, then deletes only that owner's expired rows", async () => {
    const { db, store, harness } = fresh();
    await harness.addOwner(A);
    await harness.addOwner("owner-b");
    const T2 = new Date(AT.getTime() + 1000);
    const added = await store.apply(
      A,
      changes({ addNotes: [{ text: "gone soon", source: "inferred" }] }),
      ctx,
    );
    const theirs = await store.apply(
      "owner-b",
      changes({ addNotes: [{ text: "b's", source: "stated" }] }),
      ctx,
    );
    if (!added.ok || !theirs.ok) throw new Error("expected ok");
    for (const [owner, r] of [
      [A, added],
      ["owner-b", theirs],
    ] as const) {
      await store.apply(
        owner,
        changes({
          removeNotes: [
            { id: r.addedNoteIds[0] as string, expectedSource: r.notes[0]?.source ?? "stated" },
          ],
        }),
        ctx,
      );
    }
    const removedAt = db
      .prepare("SELECT owner_id, removed_at FROM profile_notes ORDER BY id")
      .all();
    expect(removedAt).toEqual([
      { owner_id: A, removed_at: AT.getTime() },
      { owner_id: "owner-b", removed_at: AT.getTime() },
    ]);
    await store.apply(A, changes(), { ...ctx, at: T2, purgeBefore: T2 });
    expect(db.prepare("SELECT owner_id FROM profile_notes").all()).toEqual([
      { owner_id: "owner-b" },
    ]);
  });

  it("adds both tables with a migration that leaves older data and the version consistent", () => {
    const { db } = fresh();
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBe(MIGRATIONS.length);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('profile_notes','focus_log')",
      )
      .all();
    expect(tables).toHaveLength(2);
  });
});
