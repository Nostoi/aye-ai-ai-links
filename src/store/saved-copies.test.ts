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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopyReader, createReadGate } from "../core/copy-reading.js";
import { CPU_BUDGET_TIMEOUT_MS, cpuTimedAsync } from "../core/cpu-time-test-kit.js";
import {
  copyLimits,
  finishedMarkdown,
  imageRef,
  MAX_COPY_MARKDOWN_BYTES,
} from "../core/saved-copy.js";
import { describeSavedCopyStoreContract } from "../core/saved-copy-store-contract.js";
import { at, newLink } from "../core/snapshot-store-contract.js";
import { CopyFileTooLarge, CopyFolder, CopyFolderMissing, MARKER } from "./copy-folder.js";
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

  it("refuse a copy.md replaced by hand with an oversized file, which the copy reader shows as unreadable", async () => {
    const { root, links, copies, id } = await ready();
    await copies.saveCopy("o", id, draft("body"), LIMITS, at(1));
    writeFileSync(join(root, id, "copy.md"), Buffer.alloc(MAX_COPY_MARKDOWN_BYTES + 1, 97));
    await expect(copies.readCopy("o", id)).rejects.toBeInstanceOf(CopyFileTooLarge);
    const logged: string[] = [];
    const reader = createCopyReader({
      store: links,
      copies,
      gate: createReadGate(),
      log: (message) => logged.push(message),
    });
    expect((await reader.view("o", id))?.copy).toBe("unreadable");
    expect(logged).toHaveLength(1);
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

const walk = (dir: string, prefix = ""): Record<string, string> =>
  Object.assign(
    {},
    ...readdirSync(dir, { withFileTypes: true }).map((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name), `${prefix}${e.name}/`)
        : { [`${prefix}${e.name}`]: readFileSync(join(dir, e.name), "utf8") },
    ),
  );
const ZERO = { folders: 0, temp: 0, images: 0, unknown: [] };
const HOUR = 3_600_000;

describe("undoUnconfirmed", () => {
  /** A crash left link `id` as a `saving` copy and link `b` (ok) with a `saving` 100-byte image. */
  async function crashed() {
    const s = await ready();
    const b = (await s.links.insertIfAbsent("o", newLink(2, at(0)))).link.id;
    const folder = new CopyFolder(s.root);
    folder.prepare();
    folder.writeCopy(s.id, "first");
    folder.writeCopy(b, "second");
    folder.writeImage(b, "01.png", new Uint8Array(100));
    const copy = s.db.prepare(
      "INSERT INTO saved_copies (owner_id, link_id, status, made_at, image_nonce, md_bytes, bytes) VALUES ('o', ?, ?, 1, ?, ?, ?)",
    );
    copy.run(s.id, "saving", null, 5, 5);
    copy.run(b, "ok", N, 6, 106);
    s.db
      .prepare(
        "INSERT INTO saved_copy_images (owner_id, link_id, n, url, status, content_type, size, sha256) VALUES ('o', ?, 1, 'https://i.example/1.png', 'saving', 'image/png', 100, 'x')",
      )
      .run(b);
    return { ...s, b };
  }
  const saving = (db: Db) =>
    db
      .prepare(
        "SELECT (SELECT count(*) FROM saved_copies WHERE status = 'saving') + (SELECT count(*) FROM saved_copy_images WHERE status = 'saving')",
      )
      .pluck()
      .get();

  it("drops a saving copy with its folder and puts a saving image back to pending", async () => {
    const s = await crashed();
    expect(await s.copies.undoUnconfirmed()).toEqual({ copies: 1, images: 1 });
    expect(rows(s.db)).toBe(1);
    expect(existsSync(join(s.root, s.id))).toBe(false);
    expect(
      s.db.prepare("SELECT status, content_type, size, sha256 FROM saved_copy_images").get(),
    ).toEqual({ status: "pending", content_type: null, size: null, sha256: null });
    expect(s.db.prepare("SELECT bytes FROM saved_copies").pluck().get()).toBe(6);
    expect(existsSync(join(s.root, s.b, "images", "01.png"))).toBe(false);
    expect(existsSync(join(s.root, s.b, "copy.md"))).toBe(true);
    expect(saving(s.db)).toBe(0);
  });

  it("undoes the rows but deletes no file after a mismatch", async () => {
    const s = await crashed();
    rmSync(join(s.root, MARKER));
    writeFileSync(join(s.root, "stray.txt"), "x");
    expect(await s.copies.checkFolder()).toMatchObject({ state: "mismatch" });
    const before = walk(s.root);
    expect(await s.copies.undoUnconfirmed()).toEqual({ copies: 1, images: 1 });
    expect(saving(s.db)).toBe(0);
    expect(walk(s.root)).toEqual(before);
  });

  it("undoes the rows but deletes no file once the marker differs", async () => {
    const s = await crashed();
    writeFileSync(join(s.root, MARKER), "another-library");
    const before = walk(s.root);
    expect(await s.copies.undoUnconfirmed()).toEqual({ copies: 1, images: 1 });
    expect(saving(s.db)).toBe(0);
    expect(walk(s.root)).toEqual(before);
  });
});

describe("sweep", () => {
  const old = (path: string, now: Date, ageMs = 2 * HOUR) => {
    const t = (now.getTime() - ageMs) / 1000;
    utimesSync(path, t, t);
  };
  const orphan = (root: string, name: string, now: Date, ageMs?: number) => {
    const folder = new CopyFolder(root);
    folder.prepare();
    folder.writeCopy(name, "orphan");
    old(join(root, name), now, ageMs);
  };

  it("deletes old orphans and staging, and reports and keeps what it does not know", async () => {
    const s = await ready();
    const now = new Date();
    const second = (await s.links.insertIfAbsent("o", newLink(2, at(0)))).link.id;
    const third = (await s.links.insertIfAbsent("o", newLink(3, at(0)))).link.id;
    const urls = ["https://i.example/1.png", "https://i.example/2.png"];
    await s.copies.saveCopy("o", s.id, draft("body", urls), LIMITS, at(1));
    const png = { contentType: "image/png" as const, bytes: new Uint8Array([1]) };
    await s.copies.saveCopyImage("o", s.id, 1, urls[0] as string, png, LIMITS);
    await s.copies.saveCopy("o", second, draft("two"), LIMITS, at(1));
    rmSync(join(s.root, second), { recursive: true });
    const folder = new CopyFolder(s.root);
    folder.prepare();
    folder.writeImage(s.id, "03.png", new Uint8Array([3]));
    writeFileSync(join(s.root, s.id, "copy.md (conflicted copy)"), "x");
    orphan(s.root, "50", now);
    orphan(s.root, "60", now, 10 * 60_000);
    failConfirm(s.copies);
    vi.spyOn(CopyFolder.prototype, "removeCopy").mockImplementationOnce(() => {
      throw new Error("cleanup");
    });
    await expect(s.copies.saveCopy("o", third, draft("three"), LIMITS, at(1))).rejects.toThrow();
    vi.restoreAllMocks();
    old(join(s.root, third), now);
    const tmp = join(s.root, ".aye-tmp");
    for (const name of [`tmp-${N}`, "other-name"]) {
      writeFileSync(join(tmp, name), "x");
      old(join(tmp, name), now);
    }
    mkdirSync(join(s.root, "notes"));
    writeFileSync(join(s.root, ".DS_Store"), "");

    const report = await s.copies.sweep(HOUR, now);

    expect({ ...report, unknown: report.unknown.sort() }).toEqual({
      folders: 2,
      temp: 1,
      images: 1,
      unknown: [".aye-tmp/other-name", `${s.id}/copy.md (conflicted copy)`, "notes"].sort(),
    });
    expect(existsSync(join(s.root, "50"))).toBe(false);
    expect(existsSync(join(s.root, third))).toBe(false);
    expect(existsSync(join(tmp, `tmp-${N}`))).toBe(false);
    for (const kept of ["60", "notes", ".DS_Store", `${s.id}/images/01.png`, `${s.id}/copy.md`]) {
      expect(existsSync(join(s.root, kept))).toBe(true);
    }
    expect(existsSync(join(s.root, s.id, "images", "03.png"))).toBe(false);
    expect(existsSync(join(tmp, "other-name"))).toBe(true);
    const row = s.db.prepare("SELECT status FROM saved_copies WHERE link_id = ?");
    expect(row.pluck().get(Number(second))).toBe("ok");
  });

  it("does nothing after a mismatch", async () => {
    const { root, copies } = setup();
    const now = new Date();
    mkdirSync(join(root, "12"));
    old(join(root, "12"), now);
    expect(await copies.checkFolder()).toMatchObject({ state: "mismatch" });
    expect(await copies.sweep(HOUR, now)).toEqual(ZERO);
    expect(existsSync(join(root, "12"))).toBe(true);
  });

  it("does nothing when the marker has gone or changed since the check", async () => {
    const { root, copies } = await ready();
    const now = new Date();
    orphan(root, "12", now);
    rmSync(join(root, MARKER));
    expect(await copies.sweep(HOUR, now)).toEqual(ZERO);
    writeFileSync(join(root, MARKER), "another-library");
    expect(await copies.sweep(HOUR, now)).toEqual(ZERO);
    expect(existsSync(join(root, "12"))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports an unreadable folder and still clears stale staging",
    async () => {
      const { root, copies } = await ready();
      const now = new Date();
      orphan(root, "12", now);
      const stale = join(root, ".aye-tmp", `tmp-${N}`);
      writeFileSync(stale, "x");
      old(stale, now);
      chmodSync(join(root, "12"), 0o000);
      try {
        const report = await copies.sweep(HOUR, now);
        expect(report).toMatchObject({ temp: 1, folders: 0, unknown: ["12"] });
        expect(existsSync(stale)).toBe(false);
      } finally {
        chmodSync(join(root, "12"), 0o700);
      }
    },
  );

  it("sweeps a leftover folder whose link later got a row that holds no copy", async () => {
    const { root, copies, id } = await ready();
    const now = new Date();
    orphan(root, id, now);
    expect(await copies.recordNoCopy("o", id, "failed")).toBe(true);
    expect(await copies.sweep(HOUR, now)).toEqual({ ...ZERO, folders: 1 });
    expect(existsSync(join(root, id))).toBe(false);
  });

  it("never deletes a folder named with leading zeros, and reports it", async () => {
    const { root, copies, id } = await ready();
    const now = new Date();
    await copies.saveCopy("o", id, draft("body"), LIMITS, at(1));
    const padded = `00${id}`;
    orphan(root, padded, now);
    expect(await copies.sweep(HOUR, now)).toEqual({ ...ZERO, unknown: [padded] });
    expect(existsSync(join(root, padded, "copy.md"))).toBe(true);
  });

  it("does nothing when the last check was only unwritable", async () => {
    const { root, copies } = await ready();
    const now = new Date();
    orphan(root, "12", now);
    vi.spyOn(CopyFolder.prototype, "probe").mockImplementationOnce(() => {
      throw new Error("read-only");
    });
    expect(await copies.checkFolder()).toMatchObject({ state: "unwritable" });
    expect(await copies.sweep(HOUR, now)).toEqual(ZERO);
    expect(existsSync(join(root, "12", "copy.md"))).toBe(true);
  });

  it(
    "stays fast with thousands of copies, since it looks rows up once",
    async () => {
      const { db, root, copies } = await ready();
      db.pragma("foreign_keys = OFF");
      const ids = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)";
      db.exec(
        `${ids} INSERT INTO saved_copies (owner_id, link_id, status, made_at, md_bytes, bytes)
         SELECT 'o', i + 1000, 'ok', 1, 1, 1 FROM n`,
      );
      db.exec(
        `${ids}, k(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM k WHERE j < 10)
         INSERT INTO saved_copy_images (owner_id, link_id, n, url, status, content_type, size, sha256)
         SELECT 'o', i + 1000, j, 'u', 'ok', 'image/png', 1, 'x' FROM n, k`,
      );
      for (let i = 1001; i <= 4000; i++) mkdirSync(join(root, String(i)));
      const { result, ms } = await cpuTimedAsync(() => copies.sweep(HOUR, new Date()));
      expect(ms).toBeLessThan(1000);
      expect(result.folders).toBe(0);
    },
    CPU_BUDGET_TIMEOUT_MS,
  );

  it("does nothing, and does not throw, when the root is gone", async () => {
    const { root, copies } = await ready();
    rmSync(root, { recursive: true });
    expect(await copies.sweep(HOUR, new Date())).toEqual(ZERO);
  });

  it("leaves a folder that a new copy was just written into, and reports what stays", async () => {
    const { root, copies, id } = await ready();
    const now = new Date();
    orphan(root, id, now);
    writeFileSync(join(root, id, "notes.txt"), "mine");
    expect(await copies.saveCopy("o", id, draft("new"), LIMITS, at(1))).toBe("saved");
    old(join(root, id), now);
    expect(await copies.sweep(HOUR, now)).toEqual({ ...ZERO, unknown: [`${id}/notes.txt`] });
    expect(readFileSync(join(root, id, "copy.md"), "utf8")).toBe("new");
    expect(readFileSync(join(root, id, "notes.txt"), "utf8")).toBe("mine");
  });

  it("deletes a folder that reappears beside a purged copy, once it is old", async () => {
    const { root, copies, id } = await ready();
    const now = new Date();
    await copies.saveCopy("o", id, draft("body"), LIMITS, at(1));
    await copies.removeCopy("o", id, at(10));
    expect(await copies.purgeRemoved(at(11))).toBe(1);
    orphan(root, id, now);
    expect(await copies.sweep(HOUR, now)).toEqual({ ...ZERO, folders: 1 });
    expect(existsSync(join(root, id))).toBe(false);
  });
});

/** Makes the next folder read wait, after reading, until released; `read` settles once it has read. */
function holdRead(method: "readMarkdown" | "readImage") {
  let release = () => {};
  let reached = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const read = new Promise<void>((r) => {
    reached = r;
  });
  const real = CopyFolder.prototype[method] as (...args: unknown[]) => Promise<unknown>;
  vi.spyOn(CopyFolder.prototype, method).mockImplementationOnce(async function (
    this: CopyFolder,
    ...args: unknown[]
  ) {
    const value = await real.apply(this, args);
    reached();
    await gate;
    return value;
  } as never);
  return { read, release };
}

describe("removing and purging", () => {
  const url = "https://i.example/1.png";
  const png = { contentType: "image/png" as const, bytes: new Uint8Array([1, 2, 3]) };
  const copyRow = (db: Db, id: string) =>
    db
      .prepare(
        "SELECT status, bytes, md_bytes, image_nonce, finished_at FROM saved_copies WHERE link_id = ?",
      )
      .get(Number(id));
  const imageRows = (db: Db, id: string) =>
    db.prepare("SELECT count(*) FROM saved_copy_images WHERE link_id = ?").pluck().get(Number(id));
  const TOMBSTONE = {
    status: "removed",
    bytes: 0,
    md_bytes: 0,
    image_nonce: null,
    finished_at: null,
  };
  /** A copy with one stored picture, removed at at(10). */
  const removed = async () => {
    const s = await ready();
    await s.copies.saveCopy("o", s.id, draft("body", [url]), LIMITS, at(1));
    expect(await s.copies.saveCopyImage("o", s.id, 1, url, png, LIMITS)).toBe("saved");
    expect(await s.copies.removeCopy("o", s.id, at(10))).toBe(true);
    return s;
  };
  const pause = async (root: string, copies: SqliteSavedCopyStore) => {
    rmSync(join(root, MARKER));
    expect(await copies.checkFolder()).toMatchObject({ state: "mismatch" });
  };

  it("deletes the files, leaves a 0-byte row with no pictures, and keeps foreign files", async () => {
    const s = await removed();
    writeFileSync(join(s.root, s.id, "notes.txt"), "mine");
    expect(await s.copies.purgeRemoved(at(11))).toBe(1);
    expect(copyRow(s.db, s.id)).toEqual(TOMBSTONE);
    expect(imageRows(s.db, s.id)).toBe(0);
    expect(readdirSync(join(s.root, s.id))).toEqual(["notes.txt"]);
    expect(await s.copies.usedBytes()).toBe(0);
  });

  it("deletes the whole folder when it holds only the copy", async () => {
    const s = await removed();
    expect(await s.copies.purgeRemoved(at(11))).toBe(1);
    expect(existsSync(join(s.root, s.id))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps the bytes counted while copy.md cannot be deleted, and purges on a later try",
    async () => {
      const s = await removed();
      const used = await s.copies.usedBytes();
      chmodSync(join(s.root, s.id), 0o500);
      try {
        expect(await s.copies.purgeRemoved(at(11))).toBe(0);
      } finally {
        chmodSync(join(s.root, s.id), 0o700);
      }
      expect(await s.copies.usedBytes()).toBe(used);
      expect(existsSync(join(s.root, s.id, "copy.md"))).toBe(true);
      expect(await s.copies.purgeRemoved(at(11))).toBe(1);
      expect(copyRow(s.db, s.id)).toEqual(TOMBSTONE);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "marks the row before deleting, so a copy whose pictures stay is never restored",
    async () => {
      const s = await removed();
      const used = await s.copies.usedBytes();
      const images = join(s.root, s.id, "images");
      chmodSync(images, 0o500);
      try {
        expect(await s.copies.purgeRemoved(at(11))).toBe(0);
      } finally {
        chmodSync(images, 0o700);
      }
      expect(existsSync(join(s.root, s.id, "copy.md"))).toBe(false);
      expect(copyRow(s.db, s.id)).toMatchObject({ image_nonce: null, finished_at: null });
      expect(await s.copies.usedBytes()).toBe(used);
      expect(imageRows(s.db, s.id)).toBe(1);
      expect(await s.copies.restoreCopy("o", s.id, new Date(0))).toBe(false);
      expect(await s.copies.purgeRemoved(at(11))).toBe(1);
      expect(copyRow(s.db, s.id)).toEqual(TOMBSTONE);
      expect(existsSync(join(s.root, s.id))).toBe(false);
    },
  );

  it("deletes nothing while paused", async () => {
    const s = await removed();
    await pause(s.root, s.copies);
    expect(await s.copies.purgeRemoved(at(11))).toBe(0);
    expect(existsSync(join(s.root, s.id, "copy.md"))).toBe(true);
    expect(copyRow(s.db, s.id)).toMatchObject({ status: "removed", image_nonce: N });
  });

  it("removes and restores while paused", async () => {
    const s = await ready();
    await s.copies.saveCopy("o", s.id, draft("body"), LIMITS, at(1));
    await pause(s.root, s.copies);
    expect(await s.copies.removeCopy("o", s.id, at(10))).toBe(true);
    expect(await s.copies.restoreCopy("o", s.id, at(10))).toBe(true);
  });

  it("answers null to a copy read that a removal or purge overtakes", async () => {
    const s = await removed();
    await s.copies.restoreCopy("o", s.id, at(10));
    let held = holdRead("readMarkdown");
    let reading = s.copies.readCopy("o", s.id);
    await held.read;
    await s.copies.removeCopy("o", s.id, at(10));
    held.release();
    expect(await reading).toBeNull();
    await s.copies.restoreCopy("o", s.id, at(10));
    held = holdRead("readMarkdown");
    reading = s.copies.readCopy("o", s.id);
    await held.read;
    await s.copies.removeCopy("o", s.id, at(10));
    expect(await s.copies.purgeRemoved(at(11))).toBe(1);
    held.release();
    expect(await reading).toBeNull();
  });

  it("answers null to a picture read that a removal or purge overtakes", async () => {
    const s = await removed();
    await s.copies.restoreCopy("o", s.id, at(10));
    let held = holdRead("readImage");
    let reading = s.copies.copyImage("o", s.id, 1);
    await held.read;
    await s.copies.removeCopy("o", s.id, at(10));
    held.release();
    expect(await reading).toBeNull();
    await s.copies.restoreCopy("o", s.id, at(10));
    held = holdRead("readImage");
    reading = s.copies.copyImage("o", s.id, 1);
    await held.read;
    await s.copies.removeCopy("o", s.id, at(10));
    expect(await s.copies.purgeRemoved(at(11))).toBe(1);
    held.release();
    expect(await reading).toBeNull();
  });
});

describe("lastCheck", () => {
  it("is not checked before the first check, then the check's result", async () => {
    const { root, copies } = setup();
    expect(copies.lastCheck()).toEqual({
      state: "mismatch",
      detail: "The saved-copy folder is not checked",
    });
    expect(await copies.checkFolder()).toEqual({ state: "ready" });
    expect(copies.lastCheck()).toEqual({ state: "ready" });
    writeFileSync(join(root, "stray.txt"), "x");
    rmSync(join(root, MARKER));
    const paused = await copies.checkFolder();
    expect(paused).toMatchObject({ state: "mismatch" });
    expect(copies.lastCheck()).toEqual(paused);
  });
});

describe("a copy whose files were deleted by hand", () => {
  const url = "https://i.example/1.png";
  const png = { contentType: "image/png" as const, bytes: new Uint8Array([1, 2, 3]) };
  const withImage = async () => {
    const s = await ready();
    await s.copies.saveCopy("o", s.id, draft(`![a](${imageRef(1, N)})`, [url]), LIMITS, at(1));
    return s;
  };

  it("is missing only for its owner, while the folder is the store's", async () => {
    const s = await withImage();
    await s.links.ensureUser("p", "p");
    expect(await s.copies.copyFileMissing("o", s.id)).toBe(false);
    rmSync(join(s.root, s.id), { recursive: true });
    expect(await s.copies.copyFileMissing("o", s.id)).toBe(true);
    expect(await s.copies.copyFileMissing("p", s.id)).toBe(false);
    expect(await s.copies.copyFileMissing("o", "999999")).toBe(false);
    writeFileSync(join(s.root, "stray.txt"), "x");
    rmSync(join(s.root, MARKER));
    expect(await s.copies.checkFolder()).toMatchObject({ state: "mismatch" });
    expect(await s.copies.copyFileMissing("o", s.id)).toBe(false);
  });

  it("is not missing once removed", async () => {
    const s = await withImage();
    rmSync(join(s.root, s.id), { recursive: true });
    await s.copies.removeCopy("o", s.id, at(10));
    expect(await s.copies.copyFileMissing("o", s.id)).toBe(false);
  });

  it("stores no picture and rebuilds no folder", async () => {
    const s = await withImage();
    const used = await s.copies.usedBytes();
    rmSync(join(s.root, s.id), { recursive: true });
    await expect(s.copies.saveCopyImage("o", s.id, 1, url, png, LIMITS)).rejects.toBeInstanceOf(
      CopyFolderMissing,
    );
    expect(existsSync(join(s.root, s.id))).toBe(false);
    expect(s.db.prepare("SELECT status FROM saved_copy_images").pluck().get()).toBe("pending");
    expect(await s.copies.usedBytes()).toBe(used);
  });

  it("is not finished into a rebuilt folder when it goes during the finish", async () => {
    const s = await withImage();
    await s.copies.endCopyImage("o", s.id, 1, url, "none");
    const held = holdRead("readMarkdown");
    const finishing = s.copies.finishCopy("o", s.id, finishedMarkdown, at(2));
    await held.read;
    rmSync(join(s.root, s.id), { recursive: true });
    held.release();
    expect(await finishing).toBe(false);
    expect(existsSync(join(s.root, s.id))).toBe(false);
    expect(s.db.prepare("SELECT finished_at FROM saved_copies").pluck().get()).toBeNull();
  });
});
