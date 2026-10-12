import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { updateLink } from "../core/links.js";
import { at, describeSnapshotStoreContract, record } from "../core/snapshot-store-contract.js";
import { FtsSearch } from "../search/fts-search.js";
import { openDatabase } from "./database.js";
import { MIGRATIONS, migrate } from "./migrations.js";
import { SqliteStore } from "./sqlite-store.js";

type Db = Database.Database;

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

function fresh(): { db: Db; store: SqliteStore } {
  const db = openDatabase(":memory:");
  open.push(db);
  const store = new SqliteStore(db);
  return { db, store };
}

describeSnapshotStoreContract("SqliteStore snapshots", () => {
  const { store } = fresh();
  return { store, addOwner: (o) => store.ensureUser(o, o) };
});

/** The migration that adds `snapshots`; everything before it is the schema it starts from. */
const SNAPSHOT_MIGRATION = 3;
const count = (db: Db, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

/** A database at the version before the snapshot migration, holding two owners' links. */
function legacy(): Db {
  const db = new Database(":memory:");
  open.push(db);
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, SNAPSHOT_MIGRATION));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO links (id, owner_id, url, url_key, title, summary, why_text, why_source, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 'Quokka guide', 'alpine hut', 'bravo plan', 'stated', 5, 'x', 'active'),
             (2, 'b', 'https://ex.com/2', 'ex.com/2', 'Other', NULL, NULL, NULL, 6, 'x', 'active');
    INSERT INTO tags (id, owner_id, key, name, kind) VALUES (1, 'a', 'wombat', 'Wombat', 'topic');
    INSERT INTO link_tags VALUES ('a', 1, 1, 'stated', 0);`);
  return db;
}

describe("the snapshot migration, from the version before it, with data", () => {
  it("gives every existing link a pending snapshot that is due", async () => {
    const db = legacy();
    migrate(db);
    expect(
      db.prepare("SELECT link_id, owner_id, fetch_status FROM snapshots ORDER BY link_id").all(),
    ).toEqual([
      { link_id: 1, owner_id: "a", fetch_status: "pending" },
      { link_id: 2, owner_id: "b", fetch_status: "pending" },
    ]);
    expect(await new SqliteStore(db).dueSnapshots(at(0), 10)).toEqual([
      { owner: "a", linkId: "1" },
      { owner: "b", linkId: "2" },
    ]);
  });

  it("still finds links by title, summary, why and tag, for their owner only", async () => {
    const db = legacy();
    migrate(db);
    const search = new FtsSearch(db);
    for (const word of ["quokka", "alpine", "bravo", "wombat"]) {
      expect(await search.search("a", word, {}, 10), word).toEqual(["1"]);
      expect(await search.search("b", word, {}, 10), word).toEqual([]);
    }
  });

  it("finds a word that is only in the page's text, title or description, for its owner only", async () => {
    const db = legacy();
    migrate(db);
    const store = new SqliteStore(db);
    const l = await store.leaseSnapshot("a", "1", at(1), at(100));
    await store.recordSnapshot(
      "a",
      "1",
      l?.claim ?? -1,
      record({
        title: "Wallaby field notes",
        description: "marsupial census",
        text: "numbat sightings",
      }),
    );
    const search = new FtsSearch(db);
    for (const word of ["numbat", "wallaby", "marsupial"]) {
      expect(await search.search("a", word, {}, 10), word).toEqual(["1"]);
      expect(await search.search("b", word, {}, 10), word).toEqual([]);
    }
  });

  it("removes a link's snapshot and index row when the link is deleted", () => {
    const db = legacy();
    migrate(db);
    db.prepare("DELETE FROM links WHERE id = 1").run();
    expect(db.prepare("SELECT link_id FROM snapshots").all()).toEqual([{ link_id: 2 }]);
    expect(count(db, "link_search")).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("leaves the 7 earlier search triggers and adds the 2 on snapshots", () => {
    const db = legacy();
    migrate(db);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toEqual([
      "link_search_links_del",
      "link_search_links_ins",
      "link_search_links_upd",
      "link_search_lt_del",
      "link_search_lt_ins",
      "link_search_lt_upd",
      "link_search_snap_ins",
      "link_search_snap_upd",
      "link_search_tags_upd",
    ]);
  });
});

describe("search over snapshot text", () => {
  async function savedWithText() {
    const { db, store } = fresh();
    store.ensureUser("a", "a");
    const { link } = await store.insertIfAbsent("a", {
      url: "https://ex.com/1",
      urlKey: "ex.com/1",
      title: "Guide",
      summary: null,
      why: null,
      tags: [],
      savedAt: at(0),
      savedBy: "t",
      lastOpenedAt: null,
      lastSurfacedAt: null,
      snoozedUntil: null,
      state: "active",
    });
    const l = await store.leaseSnapshot("a", link.id, at(1), at(100));
    await store.recordSnapshot("a", link.id, l?.claim ?? -1, record({ text: "numbat sightings" }));
    return { db, store, id: link.id, search: new FtsSearch(db) };
  }

  it("keeps finding the page's text after the link is edited", async () => {
    const { store, id, search } = await savedWithText();
    expect(await search.search("a", "numbat", {}, 10)).toEqual([id]);
    await updateLink({ store, now: () => at(2) }, "a", id, {
      summary: "now has a summary",
      tags: [{ name: "Marsupials", source: "stated" }],
    });
    expect(await search.search("a", "numbat", {}, 10)).toEqual([id]);
    expect(await search.search("a", "summary", {}, 10)).toEqual([id]);
  });

  it("drops the old text from the index when the snapshot text changes", async () => {
    const { db, id, search } = await savedWithText();
    db.prepare("UPDATE snapshots SET text = 'bilby' WHERE link_id = ?").run(Number(id));
    expect(await search.search("a", "numbat", {}, 10)).toEqual([]);
    expect(await search.search("a", "bilby", {}, 10)).toEqual([id]);
  });
});
