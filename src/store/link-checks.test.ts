import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { describeLinkCheckStoreContract } from "../core/link-check-store-contract.js";
import { openDatabase } from "./database.js";
import { MIGRATIONS, migrate } from "./migrations.js";
import { SqliteLinkCheckStore } from "./sqlite-link-checks.js";
import { SqliteStore } from "./sqlite-store.js";

type Db = Database.Database;

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

describeLinkCheckStoreContract("SqliteLinkCheckStore", () => {
  const db = openDatabase(":memory:");
  open.push(db);
  const links = new SqliteStore(db);
  return {
    links,
    checks: new SqliteLinkCheckStore(db),
    addOwner: (o) => links.ensureUser(o, o),
  };
});

/** The migration that adds `link_checks`; everything before it is the schema it starts from. */
const CHECKS_MIGRATION = 13;

/** A database at the version before `link_checks`, holding two owners' links, migrated to the latest. */
function migrated(): Db {
  const db = new Database(":memory:");
  open.push(db);
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, CHECKS_MIGRATION));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO links (id, owner_id, url, url_key, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 5, 'x', 'active'),
             (2, 'a', 'https://ex.com/2', 'ex.com/2', 5, 'x', 'active'),
             (3, 'b', 'https://ex.com/3', 'ex.com/3', 5, 'x', 'active');`);
  migrate(db);
  return db;
}

type Columns = { result?: string; firstDeadAt?: number | null; flaggedAt?: number | null };
const insert = (
  db: Db,
  owner: string,
  linkId: number,
  { result = "dead", firstDeadAt = null, flaggedAt = null }: Columns = {},
) =>
  db
    .prepare(
      `INSERT INTO link_checks (owner_id, link_id, checked_at, result, detail, first_dead_at,
         flagged_at, still_works_at)
       VALUES (?, ?, 0, ?, NULL, ?, ?, NULL)`,
    )
    .run(owner, linkId, result, firstDeadAt, flaggedAt);

describe("the link_checks migration, from the version before it, with links", () => {
  it("is migration 14: it creates an empty link_checks and keeps the existing links", () => {
    expect(MIGRATIONS[CHECKS_MIGRATION]).toContain("CREATE TABLE link_checks");
    const db = migrated();
    expect(db.prepare("SELECT count(*) AS n FROM link_checks").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id FROM links ORDER BY id").all()).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
  });

  it("removes a link's row when the link is deleted, and only that link's", () => {
    const db = migrated();
    insert(db, "a", 1);
    insert(db, "a", 2);
    insert(db, "b", 3);
    db.prepare("DELETE FROM links WHERE id = 1").run();
    expect(db.prepare("SELECT link_id FROM link_checks ORDER BY link_id").all()).toEqual([
      { link_id: 2 },
      { link_id: 3 },
    ]);
  });

  it("refuses a row whose owner is not the link's owner, or whose link does not exist", () => {
    const db = migrated();
    expect(() => insert(db, "b", 1)).toThrow(/FOREIGN KEY/);
    expect(() => insert(db, "a", 99)).toThrow(/FOREIGN KEY/);
  });

  it("refuses a second row for a link, a result other than alive, dead or unknown, and a flag with no first dead check", () => {
    const db = migrated();
    insert(db, "a", 1);
    expect(() => insert(db, "a", 1)).toThrow(/UNIQUE/);
    expect(() => insert(db, "a", 2, { result: "gone" })).toThrow(/CHECK/);
    expect(() => insert(db, "a", 2, { flaggedAt: 9 })).toThrow(/CHECK/);
    insert(db, "a", 2, { firstDeadAt: 1, flaggedAt: 9 });
    expect(db.prepare("SELECT link_id FROM link_checks ORDER BY link_id").all()).toEqual([
      { link_id: 1 },
      { link_id: 2 },
    ]);
  });
});
