import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyLimits, finishedMarkdown, imageRef } from "../core/saved-copy.js";
import { describeSavedCopyStoreContract } from "../core/saved-copy-store-contract.js";
import { at, newLink } from "../core/snapshot-store-contract.js";
import { CopyFolder, MARKER } from "./copy-folder.js";
import { openDatabase } from "./database.js";
import { SqliteSavedCopyStore } from "./saved-copies.js";
import { SqliteLinkCheckStore } from "./sqlite-link-checks.js";
import { SqliteStore } from "./sqlite-store.js";

type Db = Database.Database;

const open: { db: Db; root: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { db, root } of open.splice(0)) {
    if (db.open) db.close();
    try {
      chmodSync(root, 0o700);
    } catch {
      // already gone
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const N = "0123456789abcdef0123456789abcdef";
const LIMITS = copyLimits(10_000);
const draft = (markdown: string, imageUrls: string[] = [], nonce = N) => ({
  markdown,
  imageUrls,
  nonce,
});

function setup() {
  const db = openDatabase(":memory:");
  const root = mkdtempSync(join(tmpdir(), "aye-copies-"));
  open.push({ db, root });
  const links = new SqliteStore(db);
  const copies = new SqliteSavedCopyStore(db, root);
  return { db, root, links, copies };
}

async function ready() {
  const s = setup();
  await s.links.ensureUser("o", "o");
  expect(await s.copies.checkFolder()).toEqual({ state: "ready" });
  const id = (await s.links.insertIfAbsent("o", newLink(1, at(0)))).link.id;
  return { ...s, id };
}

const libraryId = (db: Db) =>
  (db.prepare("SELECT id FROM saved_copy_library").get() as { id: string } | undefined)?.id;
const rows = (db: Db) => db.prepare("SELECT count(*) AS c FROM saved_copies").pluck().get();

describeSavedCopyStoreContract("SqliteSavedCopyStore", async () => {
  const db = openDatabase(":memory:");
  const root = mkdtempSync(join(tmpdir(), "aye-copies-"));
  open.push({ db, root });
  const links = new SqliteStore(db);
  const copies = new SqliteSavedCopyStore(db, root);
  expect(await copies.checkFolder()).toEqual({ state: "ready" });
  return {
    links,
    checks: new SqliteLinkCheckStore(db),
    copies,
    addOwner: (o) => links.ensureUser(o, o),
    breakFolder: () => {
      writeFileSync(join(root, "stray.txt"), "x");
      rmSync(join(root, MARKER));
      return copies.checkFolder().then(() => {});
    },
  };
});

describe("checkFolder", () => {
  it("makes an empty root ready and writes the library id into the marker", async () => {
    const { db, root, copies } = setup();
    expect(await copies.checkFolder()).toEqual({ state: "ready" });
    expect(readFileSync(join(root, MARKER), "utf8")).toBe(libraryId(db));
  });

  it("ignores names a sync client or Finder adds", async () => {
    const { root, copies } = setup();
    writeFileSync(join(root, ".DS_Store"), "");
    writeFileSync(join(root, "Icon\r"), "");
    expect(await copies.checkFolder()).toEqual({ state: "ready" });
  });

  it("refuses a root holding files but no marker, and leaves them", async () => {
    const { root, copies } = setup();
    mkdirSync(join(root, "12"));
    writeFileSync(join(root, ".DS_Store"), "");
    expect(await copies.checkFolder()).toMatchObject({ state: "mismatch" });
    expect(existsSync(join(root, "12"))).toBe(true);
    expect(existsSync(join(root, MARKER))).toBe(false);
  });

  it("refuses a marker holding another library's id", async () => {
    const { db, root, copies } = setup();
    db.prepare("INSERT INTO saved_copy_library (only, id) VALUES (1, 'mine')").run();
    writeFileSync(join(root, MARKER), "someone-else");
    expect(await copies.checkFolder()).toMatchObject({ state: "mismatch" });
  });

  it("refuses a marker when the database has no library row, and writes nothing", async () => {
    const { db, root, copies } = setup();
    writeFileSync(join(root, MARKER), "from-a-newer-database");
    expect(await copies.checkFolder()).toMatchObject({ state: "mismatch" });
    expect(readFileSync(join(root, MARKER), "utf8")).toBe("from-a-newer-database");
    expect(libraryId(db)).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)(
    "is unwritable for a read-only root, and ready again once it is fixed",
    async () => {
      const { root, copies } = setup();
      expect(await copies.checkFolder()).toEqual({ state: "ready" });
      chmodSync(root, 0o500);
      expect(await copies.checkFolder()).toMatchObject({ state: "unwritable" });
      chmodSync(root, 0o700);
      expect(await copies.checkFolder()).toEqual({ state: "ready" });
    },
  );

  it("records the library row before the marker, so a failed marker write is retried", async () => {
    const { db, root, copies } = setup();
    const spy = vi.spyOn(CopyFolder.prototype, "writeMarker").mockImplementationOnce(() => {
      throw new Error("disk");
    });
    expect(await copies.checkFolder()).toMatchObject({ state: "unwritable" });
    const id = libraryId(db);
    expect(id).toBeDefined();
    spy.mockRestore();
    expect(await copies.checkFolder()).toEqual({ state: "ready" });
    expect(readFileSync(join(root, MARKER), "utf8")).toBe(id);
  });
});

describe("reads", () => {
  it("answer missing when the marker cannot be read, though the row is ok", async () => {
    const { root, copies, id } = await ready();
    await copies.saveCopy("o", id, draft("body"), LIMITS, at(1));
    rmSync(join(root, MARKER));
    mkdirSync(join(root, MARKER));
    expect(await copies.checkFolder()).toMatchObject({ state: "mismatch" });
    expect(await copies.readCopy("o", id)).toBe("missing");
  });

  it("answer missing after a mismatch, though the row is ok", async () => {
    const { db, root, copies, id } = await ready();
    expect(await copies.saveCopy("o", id, draft("body"), LIMITS, at(1))).toBe("saved");
    rmSync(join(root, MARKER));
    writeFileSync(join(root, "stray.txt"), "x");
    expect(await copies.checkFolder()).toMatchObject({ state: "mismatch" });
    expect(await copies.readCopy("o", id)).toBe("missing");
    expect(db.prepare("SELECT status FROM saved_copies").pluck().get()).toBe("ok");
  });

  it("answer missing when the files were deleted by hand, leaving the row ok", async () => {
    const { db, root, copies, id } = await ready();
    await copies.saveCopy("o", id, draft("body"), LIMITS, at(1));
    rmSync(join(root, id), { recursive: true });
    expect(await copies.readCopy("o", id)).toBe("missing");
    expect(db.prepare("SELECT status FROM saved_copies").pluck().get()).toBe("ok");
  });
});

/** Makes the store's private confirm step throw. */
const failConfirm = (store: SqliteSavedCopyStore) =>
  vi.spyOn(store as unknown as { confirmCopy(): void }, "confirmCopy").mockImplementation(() => {
    throw new Error("confirm");
  });

describe("a failed copy write", () => {
  const disk = () => Object.assign(new Error("disk"), { code: "ENOSPC" });

  it("leaves no row and no files when the write fails", async () => {
    const { db, root, copies, id } = await ready();
    vi.spyOn(CopyFolder.prototype, "writeCopy").mockImplementation(() => {
      throw disk();
    });
    await expect(copies.saveCopy("o", id, draft("body"), LIMITS, at(1))).rejects.toThrow("disk");
    expect(rows(db)).toBe(0);
    expect(await copies.usedBytes()).toBe(0);
    expect(readdirSync(root).sort()).toEqual([MARKER, ".aye-tmp"]);
    expect(readdirSync(join(root, ".aye-tmp"))).toEqual([]);
  });

  it("rethrows the original error and still tries the folder when the row delete fails", async () => {
    const { copies, id } = await ready();
    vi.spyOn(CopyFolder.prototype, "writeCopy").mockImplementation(() => {
      throw disk();
    });
    vi.spyOn(copies as unknown as { releaseCopy(): void }, "releaseCopy").mockImplementation(() => {
      throw new Error("db full");
    });
    const remove = vi.spyOn(CopyFolder.prototype, "removeCopy");
    await expect(copies.saveCopy("o", id, draft("body"), LIMITS, at(1))).rejects.toThrow("disk");
    expect(remove).toHaveBeenCalledWith(id);
  });

  it("removes the row and the folder when confirming fails", async () => {
    const { db, root, copies, id } = await ready();
    failConfirm(copies);
    await expect(copies.saveCopy("o", id, draft("body"), LIMITS, at(1))).rejects.toThrow("confirm");
    expect(rows(db)).toBe(0);
    expect(await copies.usedBytes()).toBe(0);
    expect(existsSync(join(root, id))).toBe(false);
  });

  it("rethrows the confirm error and leaves the folder for the sweep when cleanup fails too", async () => {
    const { db, root, copies, id } = await ready();
    failConfirm(copies);
    vi.spyOn(CopyFolder.prototype, "removeCopy").mockImplementation(() => {
      throw new Error("cleanup");
    });
    await expect(copies.saveCopy("o", id, draft("body"), LIMITS, at(1))).rejects.toThrow("confirm");
    expect(rows(db)).toBe(0);
    expect(await copies.usedBytes()).toBe(0);
    expect(existsSync(join(root, id, "copy.md"))).toBe(true);
  });
});

describe("a bad draft", () => {
  it("throws before writing a row for a bad nonce", async () => {
    const { db, copies, id } = await ready();
    await expect(
      copies.saveCopy("o", id, draft("body", ["https://i.example/1.png"], "x"), LIMITS, at(1)),
    ).rejects.toThrow();
    expect(rows(db)).toBe(0);
  });

  it("throws before writing a row for more than 30 images", async () => {
    const { db, copies, id } = await ready();
    const urls = [...Array(31)].map((_, i) => `https://i.example/${i}.png`);
    await expect(copies.saveCopy("o", id, draft("body", urls), LIMITS, at(1))).rejects.toThrow();
    expect(rows(db)).toBe(0);
  });
});

describe("images", () => {
  const url = "https://i.example/1.png";
  const png = { contentType: "image/png" as const, bytes: new Uint8Array([1, 2, 3]) };
  const withImage = async (markdown = "body") => {
    const s = await ready();
    expect(await s.copies.saveCopy("o", s.id, draft(markdown, [url]), LIMITS, at(1))).toBe("saved");
    return s;
  };
  const imageRow = (db: Db) =>
    db.prepare("SELECT status, content_type, size, sha256 FROM saved_copy_images").get();
  const imagesDir = (root: string, id: string) => join(root, id, "images");
  const failing = (store: SqliteSavedCopyStore, method: "confirmImage" | "releaseImage") =>
    vi.spyOn(store as unknown as Record<string, () => void>, method).mockImplementation(() => {
      throw new Error(method);
    });

  const expectReleased = async (s: Awaited<ReturnType<typeof withImage>>) => {
    expect(imageRow(s.db)).toEqual({
      status: "pending",
      content_type: null,
      size: null,
      sha256: null,
    });
    expect(await s.copies.usedBytes()).toBe(Buffer.byteLength("body"));
    expect(readdirSync(imagesDir(s.root, s.id))).toEqual([]);
  };

  it("puts the image back to pending when the file write fails", async () => {
    const s = await withImage();
    vi.spyOn(CopyFolder.prototype, "writeImage").mockImplementation(() => {
      throw new Error("disk");
    });
    await expect(s.copies.saveCopyImage("o", s.id, 1, url, png, LIMITS)).rejects.toThrow("disk");
    await expectReleased(s);
  });

  it("puts the image back to pending and removes the file when confirming fails", async () => {
    const s = await withImage();
    failing(s.copies, "confirmImage");
    await expect(s.copies.saveCopyImage("o", s.id, 1, url, png, LIMITS)).rejects.toThrow(
      "confirmImage",
    );
    await expectReleased(s);
  });

  it("rethrows the original error when releasing and cleaning up both fail", async () => {
    const s = await withImage();
    failing(s.copies, "confirmImage");
    failing(s.copies, "releaseImage");
    const remove = vi.spyOn(CopyFolder.prototype, "removeImage").mockImplementation(() => {
      throw new Error("cleanup");
    });
    await expect(s.copies.saveCopyImage("o", s.id, 1, url, png, LIMITS)).rejects.toThrow(
      "confirmImage",
    );
    expect(remove).toHaveBeenCalledWith(s.id, "01.png");
  });

  it("refuses a symlinked images folder planted after the save, and writes nothing outside", async () => {
    const s = await withImage();
    const outside = mkdtempSync(join(tmpdir(), "aye-outside-"));
    try {
      rmSync(imagesDir(s.root, s.id), { recursive: true });
      symlinkSync(outside, imagesDir(s.root, s.id));
      await expect(s.copies.saveCopyImage("o", s.id, 1, url, png, LIMITS)).rejects.toThrow();
      expect(readdirSync(outside)).toEqual([]);
      expect(imageRow(s.db)).toMatchObject({ status: "pending", size: null });
      expect(await s.copies.usedBytes()).toBe(Buffer.byteLength("body"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves the files alone once the folder check mismatches", async () => {
    const s = await ready();
    const second = "https://i.example/2.png";
    const urls = [url, second];
    await s.copies.saveCopy("o", s.id, draft(`![a](${imageRef(1, N)})`, urls), LIMITS, at(1));
    expect(await s.copies.saveCopyImage("o", s.id, 1, url, png, LIMITS)).toBe("saved");
    const md = join(s.root, s.id, "copy.md");
    const image = join(imagesDir(s.root, s.id), "01.png");
    const before = [readFileSync(md), readFileSync(image)];
    rmSync(join(s.root, MARKER));
    writeFileSync(join(s.root, "stray.txt"), "x");
    expect(await s.copies.checkFolder()).toMatchObject({ state: "mismatch" });
    expect(await s.copies.copyImage("o", s.id, 1)).toBeNull();
    expect(await s.copies.saveCopyImage("o", s.id, 2, second, png, LIMITS)).toBe("unavailable");
    expect(await s.copies.endCopyImage("o", s.id, 2, second, "none")).toBe(true);
    expect(await s.copies.finishCopy("o", s.id, finishedMarkdown, at(2))).toBe(false);
    expect([readFileSync(md), readFileSync(image)]).toEqual(before);
    expect(readdirSync(imagesDir(s.root, s.id))).toEqual(["01.png"]);
  });

  it("throws, and keeps copy.md, when the finished copy would grow", async () => {
    const s = await withImage(`![a](${imageRef(1, N)})`);
    await s.copies.saveCopyImage("o", s.id, 1, url, png, LIMITS);
    const md = join(s.root, s.id, "copy.md");
    appendFileSync(md, " and a long hand-written tail that was never reserved");
    const before = readFileSync(md);
    await expect(s.copies.finishCopy("o", s.id, (m) => m, at(2))).rejects.toThrow();
    expect(readFileSync(md)).toEqual(before);
    expect(s.db.prepare("SELECT finished_at FROM saved_copies").pluck().get()).toBeNull();
  });
});
