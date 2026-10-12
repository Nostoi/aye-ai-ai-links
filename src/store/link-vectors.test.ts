import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.js";

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

/** A version-6 database holding two owners' links, migrated to the latest version. */
function migrated(): Database.Database {
  const db = new Database(":memory:");
  open.push(db);
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, 6));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO links (id, owner_id, url, url_key, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 5, 'x', 'active'),
             (2, 'b', 'https://ex.com/2', 'ex.com/2', 6, 'x', 'active');`);
  migrate(db);
  return db;
}

const insert = (
  db: Database.Database,
  owner: string,
  linkId: number,
  dims: number,
  blob: Buffer | string,
) =>
  db
    .prepare("INSERT INTO link_vectors VALUES (?, ?, 'm', ?, 'h', ?, 0)")
    .run(owner, linkId, dims, blob);
const floats = (n: number) => Buffer.from(new Float32Array(n).buffer);

describe("the link_vectors migration, from version 6 with links", () => {
  it("creates link_vectors, keeping the existing links", () => {
    const db = migrated();
    expect(db.prepare("SELECT count(*) AS n FROM link_vectors").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM links").get()).toEqual({ n: 2 });
  });

  it("removes a link's vectors when the link is deleted, and only that link's", () => {
    const db = migrated();
    insert(db, "a", 1, 4, floats(4));
    insert(db, "b", 2, 4, floats(4));
    db.prepare("DELETE FROM links WHERE id = 1").run();
    expect(db.prepare("SELECT link_id FROM link_vectors").all()).toEqual([{ link_id: 2 }]);
  });

  it("refuses a vector whose owner is not the link's owner", () => {
    const db = migrated();
    expect(() => insert(db, "b", 1, 4, floats(4))).toThrow(/FOREIGN KEY/);
  });

  it("refuses a blob whose length is not dims * 4", () => {
    const db = migrated();
    expect(() => insert(db, "a", 1, 4, floats(3))).toThrow(/CHECK/);
  });

  it("refuses a TEXT embedding even when its length is dims * 4", () => {
    const db = migrated();
    expect(() => insert(db, "a", 1, 4, "x".repeat(16))).toThrow(/CHECK/);
  });
});
