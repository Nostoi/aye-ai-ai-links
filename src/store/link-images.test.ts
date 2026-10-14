import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { describeImageStoreContract } from "../core/image-store-contract.js";
import { openDatabase } from "./database.js";
import { MIGRATIONS, migrate } from "./migrations.js";
import { SqliteImageStore } from "./sqlite-image-store.js";
import { SqliteStore } from "./sqlite-store.js";

type Db = Database.Database;

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

describeImageStoreContract("SqliteImageStore", () => {
  const db = openDatabase(":memory:");
  open.push(db);
  const links = new SqliteStore(db);
  return { links, images: new SqliteImageStore(db), addOwner: (o) => links.ensureUser(o, o) };
});

/** The migration that adds `link_images`; everything before it is the schema it starts from. */
const IMAGE_MIGRATION = 9;

/** A database at the version before the image migration, with snapshots in several states. */
function legacy(): Db {
  const db = new Database(":memory:");
  open.push(db);
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, IMAGE_MIGRATION));
  db.exec(`
    INSERT INTO users VALUES ('a', 'a', 0), ('b', 'b', 0);
    INSERT INTO links (id, owner_id, url, url_key, saved_at, saved_by, state)
      VALUES (1, 'a', 'https://ex.com/1', 'ex.com/1', 5, 'x', 'active'),
             (2, 'a', 'https://ex.com/2', 'ex.com/2', 5, 'x', 'active'),
             (3, 'b', 'https://ex.com/3', 'ex.com/3', 5, 'x', 'active'),
             (4, 'b', 'https://ex.com/4', 'ex.com/4', 5, 'x', 'active');
    INSERT INTO snapshots (link_id, owner_id, fetch_status, next_fetch_at, image_url) VALUES
      (1, 'a', 'ok', NULL, 'https://ex.com/1.png'),
      (2, 'a', 'ok', NULL, NULL),
      (3, 'b', 'extract_timeout', NULL, 'https://ex.com/3.png'),
      (4, 'b', 'pending', 0, NULL);`);
  return db;
}

describe("the link_images migration, from the version before it, with data", () => {
  it("makes every snapshot with an image URL pending, whatever its fetch status, and no other", async () => {
    const db = legacy();
    migrate(db);
    expect(
      db.prepare("SELECT link_id, image_status FROM snapshots ORDER BY link_id").all(),
    ).toEqual([
      { link_id: 1, image_status: "pending" },
      { link_id: 2, image_status: null },
      { link_id: 3, image_status: "pending" },
      { link_id: 4, image_status: null },
    ]);
    expect(await new SqliteImageStore(db).pendingImages(null, 10)).toEqual([
      { owner: "a", linkId: "1", imageUrl: "https://ex.com/1.png" },
      { owner: "b", linkId: "3", imageUrl: "https://ex.com/3.png" },
    ]);
  });

  it("removes a link's image when the link is deleted, and only that link's", async () => {
    const db = legacy();
    migrate(db);
    const images = new SqliteImageStore(db);
    const png = { contentType: "image/png" as const, bytes: new Uint8Array([1, 2, 3]) };
    await images.writeImage("a", "1", "https://ex.com/1.png", png, new Date(0));
    await images.writeImage("b", "3", "https://ex.com/3.png", png, new Date(0));
    db.prepare("DELETE FROM links WHERE id = 1").run();
    expect(db.prepare("SELECT link_id FROM link_images").all()).toEqual([{ link_id: 3 }]);
  });

  const insert = (
    db: Db,
    owner: string,
    linkId: number,
    bytes: Buffer | string,
    type = "image/png",
  ) =>
    db
      .prepare("INSERT INTO link_images VALUES (?, ?, ?, ?, 'h', 0)")
      .run(owner, linkId, type, bytes);

  it("refuses an image whose owner is not the link's owner", () => {
    const db = legacy();
    migrate(db);
    expect(() => insert(db, "b", 1, Buffer.from([1]))).toThrow(/FOREIGN KEY/);
  });

  it("refuses bytes over 2 MiB, a TEXT body and a type outside the four kept", () => {
    const db = legacy();
    migrate(db);
    expect(() => insert(db, "a", 1, Buffer.alloc(2 * 1024 * 1024 + 1))).toThrow(/CHECK/);
    expect(() => insert(db, "a", 1, "text")).toThrow(/CHECK/);
    expect(() => insert(db, "a", 1, Buffer.from([1]), "image/svg+xml")).toThrow(/CHECK/);
    insert(db, "a", 1, Buffer.alloc(2 * 1024 * 1024));
  });
});
