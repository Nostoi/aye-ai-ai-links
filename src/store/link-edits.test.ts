import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { describeLinkEditStoreContract } from "../core/link-edit-store-contract.js";
import { newLink } from "../core/snapshot-store-contract.js";
import { FtsSearch } from "../search/fts-search.js";
import { openDatabase } from "./database.js";
import { MIGRATIONS, migrate } from "./migrations.js";
import { SqliteImageStore } from "./sqlite-image-store.js";
import { SqliteLinkEditStore } from "./sqlite-link-edits.js";
import { SqliteStore } from "./sqlite-store.js";

type Db = Database.Database;
const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

describeLinkEditStoreContract("SqliteLinkEditStore", () => {
  const db = openDatabase(":memory:");
  open.push(db);
  const links = new SqliteStore(db);
  return {
    links,
    images: new SqliteImageStore(db),
    edits: new SqliteLinkEditStore(db),
    addOwner: (o) => links.ensureUser(o, o),
  };
});

/** The migration that adds `owner_images` and `link_edits`; everything before it is the schema it starts from. */
const EDIT_MIGRATION = 12;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);

function legacy(): Db {
  const db = new Database(":memory:");
  open.push(db);
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, EDIT_MIGRATION));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO links (id, owner_id, url, url_key, title, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 'One', 5, 'x', 'active'),
             (2, 'a', 'https://ex.com/2', 'ex.com/2', 'Two', 5, 'x', 'active');
    INSERT INTO link_images VALUES ('a', 1, 'image/png', x'89504e4701', 'h1', 0);`);
  return db;
}

const LINK_IMAGE_COLUMNS =
  "SELECT owner_id, link_id, content_type, bytes, sha256, fetched_at FROM link_images";

describe("the owner_images and link_edits migration, from the version before it", () => {
  it("is migration 13, adds both tables empty and leaves link_images as it was", () => {
    expect(MIGRATIONS[EDIT_MIGRATION]).toContain("CREATE TABLE owner_images");
    const db = legacy();
    const fetched = db.prepare(LINK_IMAGE_COLUMNS).all();
    migrate(db);
    expect(db.prepare(LINK_IMAGE_COLUMNS).all()).toEqual(fetched);
    expect(db.prepare("SELECT count(*) AS n FROM owner_images").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM link_edits").get()).toEqual({ n: 0 });
  });

  it("removes a link's owner picture and edit record when the link is deleted, and only that link's", async () => {
    const db = legacy();
    migrate(db);
    const edits = new SqliteLinkEditStore(db);
    const set = { set: { contentType: "image/png" as const, bytes: PNG } };
    await edits.applyEdit("a", "1", { title: "One!", picture: set }, new Date(0));
    await edits.applyEdit("a", "2", { title: "Two!", picture: set }, new Date(0));
    db.prepare("DELETE FROM links WHERE id = 1").run();
    expect(db.prepare("SELECT link_id FROM owner_images").all()).toEqual([{ link_id: 2 }]);
    expect(db.prepare("SELECT link_id FROM link_edits").all()).toEqual([{ link_id: 2 }]);
  });

  it("refuses an owner picture over 2 MiB, a TEXT body, a type outside the four, and another owner's", () => {
    const db = legacy();
    migrate(db);
    const insert = (owner: string, bytes: Buffer | string, type = "image/png") =>
      db.prepare("INSERT INTO owner_images VALUES (?, 1, ?, ?, 'h', 0)").run(owner, type, bytes);
    expect(() => insert("a", Buffer.alloc(2 * 1024 * 1024 + 1))).toThrow(/CHECK/);
    expect(() => insert("a", "text")).toThrow(/CHECK/);
    expect(() => insert("a", PNG, "image/svg+xml")).toThrow(/CHECK/);
    expect(() => insert("b", PNG)).toThrow(/FOREIGN KEY/);
    insert("a", Buffer.alloc(2 * 1024 * 1024));
  });

  it("writes no link_edits row for an edit that changes nothing", async () => {
    const db = legacy();
    migrate(db);
    expect(
      await new SqliteLinkEditStore(db).applyEdit("a", "1", { title: "One" }, new Date(0)),
    ).toEqual({
      editId: null,
    });
    expect(db.prepare("SELECT count(*) AS n FROM link_edits").get()).toEqual({ n: 0 });
  });

  it("refuses Undo when the owner picture changed since the edit, and leaves that picture", async () => {
    const db = legacy();
    migrate(db);
    const edits = new SqliteLinkEditStore(db);
    const applied = await edits.applyEdit(
      "a",
      "1",
      { picture: { set: { contentType: "image/png" as const, bytes: PNG } } },
      new Date(0),
    );
    const later = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]);
    db.prepare("UPDATE owner_images SET sha256 = 'later', bytes = ? WHERE link_id = 1").run(later);
    expect(await edits.undoEdit("a", "1", applied?.editId as string)).toBe("conflict");
    expect(db.prepare("SELECT sha256, bytes FROM owner_images WHERE link_id = 1").get()).toEqual({
      sha256: "later",
      bytes: later,
    });
  });
});

describe("a tag added through an edit", () => {
  it("is found by the link's keyword search, and not found once Undone", async () => {
    const db = openDatabase(":memory:");
    open.push(db);
    const store = new SqliteStore(db);
    store.ensureUser("a", "a");
    const { link } = await store.insertIfAbsent("a", newLink(1, new Date(0)));
    const search = new FtsSearch(db);
    const edits = new SqliteLinkEditStore(db);
    const find = () => search.search("a", "quokkas", {}, 10);
    expect(await find()).toEqual([]);
    const tag = {
      key: "quokkas",
      name: "quokkas",
      source: "stated" as const,
      kind: "topic" as const,
      kindSource: "inferred" as const,
    };
    const applied = await edits.applyEdit(
      "a",
      link.id,
      { tags: { expected: [], set: [tag] } },
      new Date(1),
    );
    expect(await find()).toEqual([link.id]);
    expect(await edits.undoEdit("a", link.id, (applied as { editId: string }).editId)).toBe(
      "undone",
    );
    expect(await find()).toEqual([]);
  });
});
