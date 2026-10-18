import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

type Db = Database.Database;

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

/** The migration that adds the saved-copy tables; everything before it is the schema it starts from. */
const COPIES_MIGRATION = 14;

/** A database at the version before the saved-copy tables, holding two owners' links, migrated to the latest. */
function migrated(): Db {
  const db = new Database(":memory:");
  open.push(db);
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, COPIES_MIGRATION));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO links (id, owner_id, url, url_key, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 5, 'x', 'active'),
             (2, 'a', 'https://ex.com/2', 'ex.com/2', 5, 'x', 'active'),
             (3, 'b', 'https://ex.com/3', 'ex.com/3', 5, 'x', 'active');`);
  migrate(db);
  return db;
}

type Copy = { status?: string; madeAt?: number | null; removedAt?: number | null };
const insertCopy = (
  db: Db,
  owner: string,
  linkId: number,
  { status = "none", madeAt = null, removedAt = null }: Copy = {},
) =>
  db
    .prepare(
      "INSERT INTO saved_copies (owner_id, link_id, status, made_at, removed_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(owner, linkId, status, madeAt, removedAt);

type Image = { n?: number; status?: string; contentType?: string | null };
const insertImage = (
  db: Db,
  linkId: number,
  { n = 1, status = "pending", contentType = null }: Image = {},
) => {
  const stored = status === "ok" || status === "saving";
  return db
    .prepare(
      `INSERT INTO saved_copy_images (owner_id, link_id, n, url, status, content_type, size, sha256)
       VALUES ('a', ?, ?, 'https://ex.com/i', ?, ?, ?, ?)`,
    )
    .run(linkId, n, status, contentType, stored ? 1 : null, stored ? "ab" : null);
};

describe("migration: saved copies", () => {
  it("adds empty tables and leaves the links alone", () => {
    const db = migrated();
    for (const table of ["saved_copies", "saved_copy_images", "saved_copy_library"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM links").get()).toEqual({ n: 3 });
  });

  it("refuses a copy row for another owner's link", () => {
    const db = migrated();
    expect(() => insertCopy(db, "b", 1)).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM saved_copies").get()).toEqual({ n: 0 });
  });

  it("deletes a link's copy row and its image rows with the link", () => {
    const db = migrated();
    insertCopy(db, "a", 1);
    insertCopy(db, "a", 2);
    insertImage(db, 1);
    insertImage(db, 2);
    db.prepare("DELETE FROM links WHERE id = 1").run();
    expect(db.prepare("SELECT link_id FROM saved_copies").all()).toEqual([{ link_id: 2 }]);
    expect(db.prepare("SELECT link_id FROM saved_copy_images").all()).toEqual([{ link_id: 2 }]);
  });

  describe("CHECKs", () => {
    it("reject an unknown copy status", () => {
      expect(() => insertCopy(migrated(), "a", 1, { status: "archived" })).toThrow(/CHECK/);
    });
    it("reject an ok copy with no made_at", () => {
      expect(() => insertCopy(migrated(), "a", 1, { status: "ok" })).toThrow(/CHECK/);
    });
    it("reject a none copy with a made_at", () => {
      expect(() => insertCopy(migrated(), "a", 1, { status: "none", madeAt: 1 })).toThrow(/CHECK/);
    });
    it("reject removed_at on an ok copy", () => {
      expect(() =>
        insertCopy(migrated(), "a", 1, { status: "ok", madeAt: 1, removedAt: 2 }),
      ).toThrow(/CHECK/);
    });
    it("accept a removed copy with both times", () => {
      insertCopy(migrated(), "a", 1, { status: "removed", madeAt: 1, removedAt: 2 });
    });
    it("reject an image number of 0 or 31, and accept 1 and 30", () => {
      const db = migrated();
      insertCopy(db, "a", 1);
      expect(() => insertImage(db, 1, { n: 0 })).toThrow(/CHECK/);
      expect(() => insertImage(db, 1, { n: 31 })).toThrow(/CHECK/);
      insertImage(db, 1, { n: 1 });
      insertImage(db, 1, { n: 30 });
    });
    it("reject an ok image with no content type", () => {
      const db = migrated();
      insertCopy(db, "a", 1);
      expect(() => insertImage(db, 1, { status: "ok" })).toThrow(/CHECK/);
    });
    it("reject an svg content type", () => {
      const db = migrated();
      insertCopy(db, "a", 1);
      expect(() => insertImage(db, 1, { status: "ok", contentType: "image/svg+xml" })).toThrow(
        /CHECK/,
      );
    });
    it("accept an ok png image", () => {
      const db = migrated();
      insertCopy(db, "a", 1);
      insertImage(db, 1, { status: "ok", contentType: "image/png" });
    });
    it("reject a second library row", () => {
      const db = migrated();
      db.prepare("INSERT INTO saved_copy_library (only, id) VALUES (1, 'x')").run();
      expect(() =>
        db.prepare("INSERT INTO saved_copy_library (only, id) VALUES (2, 'y')").run(),
      ).toThrow(/CHECK/);
      expect(() =>
        db.prepare("INSERT INTO saved_copy_library (only, id) VALUES (1, 'y')").run(),
      ).toThrow(/UNIQUE|PRIMARY/);
    });
  });
});
