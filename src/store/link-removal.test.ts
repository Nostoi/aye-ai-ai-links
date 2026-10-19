import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewDigest } from "../core/digest.js";
import type { ImageBytes } from "../core/image-store.js";
import type { LinkCheck } from "../core/link-check-store.js";
import { copyLimits, finishedMarkdown, imageRef } from "../core/saved-copy.js";
import { at, newLink, record } from "../core/snapshot-store-contract.js";
import type { ToolRecord } from "../core/tool-store.js";
import { listShelf } from "../core/tools.js";
import { worthALook } from "../core/worth-a-look.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS, MODEL_KEY } from "../search/model.js";
import { CopyFolder } from "./copy-folder.js";
import { openDatabase } from "./database.js";

const A = "owner-a";
const B = "owner-b";
const open: Database.Database[] = [];
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of open.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PNG: ImageBytes = {
  contentType: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
};
const ICON = "https://ex.com/icon.png";
const kept: ToolRecord = {
  status: "kept",
  source: "stated",
  since: at(0),
  answeredAt: null,
  waitDays: 30,
};
const flagged: LinkCheck = {
  checkedAt: at(100),
  result: "dead",
  detail: "http:404",
  firstDeadAt: at(90),
  flaggedAt: at(100),
  stillWorksAt: null,
};

function setup(copyRoot: string | null = null) {
  const db = openDatabase(":memory:");
  open.push(db);
  const embedder = new FakeEmbedder(DIMS);
  const deps = createDeps(db, embedder, copyRoot);
  deps.store.ensureUser(A, A);
  deps.store.ensureUser(B, B);
  let n = 0;
  const save = async (over: Partial<ReturnType<typeof newLink>> = {}) =>
    (await deps.store.insertIfAbsent(A, { ...newLink(++n, at(0)), ...over })).link.id;
  const snapshot = async (id: string, over: Parameters<typeof record>[0] = {}) => {
    const lease = await deps.store.leaseSnapshot(A, id, at(1), at(100));
    if (!lease) throw new Error("the new link's snapshot should be leasable");
    await deps.store.recordSnapshot(A, id, lease.claim, record(over));
  };
  const hide = async (...ids: string[]) => {
    for (const id of ids) expect(await deps.store.markDeleted(A, id, at(500))).toBe(true);
  };
  /** Hides the row alone, leaving an `ok` copy in place, which `markDeleted` never does. */
  const hideRowOnly = (...ids: string[]) => {
    for (const id of ids) {
      db.prepare("UPDATE links SET deleted_at = ? WHERE owner_id = ? AND id = ?").run(
        at(500).getTime(),
        A,
        Number(id),
      );
    }
  };
  return { db, deps, embedder, save, snapshot, hide, hideRowOnly };
}

describe("hidden links in search", () => {
  it("a hidden link drops out of keyword, page-text and meaning search, and the count", async () => {
    const { deps, embedder, save, snapshot, hide } = setup();
    const id = await save({ title: "quokka" });
    const other = await save({ title: "quokka notes" });
    await snapshot(id, { text: "zymurgy brewing" });
    const meaning = "burrowing marsupial";
    expect(
      await deps.vectorIndex.writeVector(
        A,
        id,
        MODEL_KEY,
        "h",
        await embedder.embedQuery(meaning),
        at(2),
      ),
    ).toBe(true);
    const found = (q: string) => deps.search.search(A, q, {}, 10);
    expect(await found("quokka")).toContain(id);
    expect(await found("zymurgy")).toContain(id);
    expect(await found(meaning)).toContain(id);
    expect(await deps.count.count(A, {})).toBe(2);

    await hide(id);

    expect(await found("quokka")).toEqual([other]);
    expect(await found("zymurgy")).not.toContain(id);
    expect(await found(meaning)).not.toContain(id);
    expect(await deps.count.count(A, {})).toBe(1);
  });
});

describe("hidden links in runner and byte reads", () => {
  it("runner and byte reads skip a hidden link", async () => {
    const { db, deps, save, snapshot, hide } = setup();
    // The one an icon is still wanted for, and the one that has a stored picture.
    const wanting = await save();
    await snapshot(wanting, { imageUrl: null, text: "page words" });
    db.prepare("UPDATE snapshots SET image_status = NULL WHERE link_id = ?").run(Number(wanting));
    const pictured = await save();
    await snapshot(pictured, { imageUrl: null, iconUrls: [ICON] });
    expect(await deps.images.writeImage(A, pictured, ICON, "icon", PNG, at(5))).toBe(true);

    const far = new Date(Date.UTC(2100, 0, 1));
    const seen = async () => ({
      index: (await deps.vectorIndex.indexPage(MODEL_KEY, null, 10)).map((r) => r.linkId).sort(),
      due: (await deps.checks.dueChecks({ active: far, archived: far }, 10))
        .map((d) => d.linkId)
        .sort(),
      icons: (await deps.images.iconCandidates(null, 10)).map((c) => c.linkId),
      copies: (await deps.savedCopies.backfillCandidates(null, 10, { retryNoRoom: false })).map(
        (c) => c.linkId,
      ),
      text: await deps.store.getSnapshotText(A, wanting),
      image: await deps.images.image(A, pictured),
      versions: [...(await deps.images.imageVersions(A, [wanting, pictured])).keys()],
      info: [...(await deps.images.pictureInfo(A, [wanting, pictured])).keys()],
    });
    const both = [wanting, pictured].sort();
    const before = await seen();
    expect(before).toMatchObject({
      index: both,
      due: both,
      icons: [wanting],
      text: "page words",
      versions: [pictured],
      info: [pictured],
    });
    expect(before.copies).toContain(wanting);
    expect(before.image).not.toBeNull();

    await hide(wanting, pictured);

    expect(await seen()).toEqual({
      index: [],
      due: [],
      icons: [],
      copies: [],
      text: null,
      image: null,
      versions: [],
      info: [],
    });
  });
});

describe("hidden links in the digest, Handy and the gone pick", () => {
  it("digest, Handy and the gone pick leave out a hidden link", async () => {
    const { deps, save, hide } = setup();
    const tool = await save();
    const gone = await save({ why: { text: "for later", source: "stated" } });
    const plain = await save();
    await deps.tools.updateToolIf(A, tool, null, kept);
    await deps.checks.updateCheckIf(A, gone, null, flagged);
    const now = () => new Date(Date.UTC(2026, 5, 1));
    const view = async () => ({
      shelf: (await listShelf({ ...deps, now }, A)).map((i) => i.link.id),
      gone: (await worthALook({ ...deps, now }, A, [])).gone?.id ?? null,
      digest: (await previewDigest({ ...deps, now }, A)).links.map((d) => d.link.id),
    });
    expect(await view()).toEqual({ shelf: [tool], gone, digest: [plain] });

    await hide(tool, gone, plain);

    expect(await view()).toEqual({ shelf: [], gone: null, digest: [] });
  });
});

const CHILD_TABLES = ["link_tools", "owner_images", "link_edits", "link_checks", "link_vectors"];

describe("writes on a hidden link", () => {
  it("tool, edit, check, vector and copy writes refuse a hidden link and change nothing", async () => {
    const { db, deps, embedder, save, hideRowOnly } = setup();
    const id = await save({ title: "before" });
    const bare = await save();
    const vector = await embedder.embedQuery("marsupial");
    await deps.tools.updateToolIf(A, id, null, kept);
    await deps.edits.applyEdit(A, id, { title: "edited", picture: { set: PNG } }, at(3));
    await deps.checks.updateCheckIf(A, id, null, flagged);
    await deps.vectorIndex.writeVector(A, id, MODEL_KEY, "h", vector, at(2));
    db.prepare(
      `INSERT INTO saved_copies (owner_id, link_id, status, made_at, finished_at, bytes, md_bytes)
       VALUES (?, ?, 'ok', 1, 2, 5, 5)`,
    ).run(A, Number(id));
    const rowsOf = (linkId: string) =>
      [...CHILD_TABLES, "saved_copies"].map((t) =>
        db.prepare(`SELECT * FROM ${t} WHERE link_id = ?`).all(Number(linkId)),
      );
    const titleOf = () => db.prepare("SELECT title FROM links WHERE id = ?").get(Number(id));
    const beforeRows = rowsOf(id);
    const beforeTitle = titleOf();
    expect(beforeRows.every((rows) => rows.length === 1)).toBe(true);
    const editId = (db.prepare("SELECT edit_id FROM link_edits").get() as { edit_id: string })
      .edit_id;
    hideRowOnly(id, bare);

    expect(await deps.tools.updateToolIf(A, id, kept, null)).toBeNull();
    expect(
      await deps.edits.applyEdit(A, id, { title: "again", picture: "page" }, at(4)),
    ).toBeNull();
    expect(await deps.edits.undoEdit(A, id, editId)).toBeNull();
    expect(
      await deps.checks.updateCheckIf(A, id, flagged, { ...flagged, stillWorksAt: at(200) }),
    ).toBeNull();
    expect(await deps.vectorIndex.writeVector(A, id, MODEL_KEY, "h2", vector, at(9))).toBe(false);
    expect(await deps.savedCopies.removeCopy(A, id, at(5))).toBe(false);
    db.prepare("UPDATE saved_copies SET status = 'removed', removed_at = ? WHERE link_id = ?").run(
      at(4).getTime(),
      Number(id),
    );
    const removed = rowsOf(id);
    expect(await deps.savedCopies.restoreCopy(A, id, at(0))).toBe(false);
    expect(await deps.savedCopies.recordNoCopy(A, bare, "none")).toBe(false);
    const draft = { markdown: "m", imageUrls: [], nonce: "" };
    expect(await deps.savedCopies.saveCopy(A, bare, draft, copyLimits(10_000), at(6))).toBeNull();

    expect(titleOf()).toEqual(beforeTitle);
    expect(rowsOf(id)).toEqual(removed);
    expect(removed.slice(0, -1)).toEqual(beforeRows.slice(0, -1));
    expect(rowsOf(bare)).toEqual([[], [], [], [], [], []]);
  });

  it("a new save over a hidden address cascades the old row's children", async () => {
    const { db, deps, embedder, save, snapshot, hide } = setup();
    const tag = { key: "t", name: "t", source: "stated", kind: "topic", kindSource: "stated" };
    const id = await save({ title: "quokka", tags: [tag as never] });
    await snapshot(id, { text: "page words" });
    await deps.vectorIndex.writeVector(
      A,
      id,
      MODEL_KEY,
      "h",
      await embedder.embedQuery("marsupial"),
      at(2),
    );
    const count = (table: string) =>
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE ${table === "link_search" ? "rowid" : "link_id"} = ?`,
        )
        .all(Number(id)).length;
    const tables = ["link_tags", "snapshots", "link_vectors", "link_search"];
    expect(tables.map(count)).toEqual([1, 1, 1, 1]);
    const urlKey = (await deps.store.get(A, id))?.urlKey as string;
    await hide(id);

    const again = await deps.store.insertIfAbsent(A, { ...newLink(1, at(0)), urlKey });

    expect(again.created).toBe(true);
    expect(again.link.id).not.toBe(id);
    expect(tables.map(count)).toEqual([0, 0, 0, 0]);
  });
});

const NONCE = "0123456789abcdef0123456789abcdef";
const LIMITS = copyLimits(10_000);
const imageUrl = (n: number) => `https://img.example/${n}.png`;
const copyDraft = (images = 0) => ({
  markdown: "# body",
  imageUrls: [...Array(images)].map((_, i) => imageUrl(i + 1)),
  nonce: NONCE,
});

async function withCopies() {
  const root = mkdtempSync(join(tmpdir(), "aye-removal-"));
  roots.push(root);
  const s = setup(root);
  expect(await s.deps.savedCopies.checkFolder()).toEqual({ state: "ready" });
  const copyRow = (id: string) =>
    s.db
      .prepare(
        `SELECT status, removed_at AS removedAt, bytes FROM saved_copies
         WHERE owner_id = ? AND link_id = ?`,
      )
      .get(A, Number(id)) as
      | { status: string; removedAt: number | null; bytes: number }
      | undefined;
  const folderOf = (id: string) => join(root, id);
  return { ...s, root, copyRow, folderOf };
}

const LINK_TABLES = [
  "link_tags",
  "snapshots",
  "link_vectors",
  "link_images",
  "owner_images",
  "link_edits",
  "link_tools",
  "link_checks",
  "saved_copies",
  "saved_copy_images",
];
const SEARCH_TABLES = ["link_search", "snapshot_search"];

/** One row in every table keyed by the link; its saved copy is a 0-byte tombstone. */
function seedChildren(db: Database.Database, owner: string, id: string): void {
  const n = Number(id);
  const tag = db
    .prepare("INSERT INTO tags (owner_id, key, name, kind) VALUES (?, ?, ?, 'topic') RETURNING id")
    .pluck()
    .get(owner, `k${n}`, `wombat${n}`) as number;
  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(owner, n, ...params);
  run("INSERT INTO link_tags VALUES (?, ?, ?, 'stated', 0)", tag);
  db.prepare("UPDATE snapshots SET fetch_status = 'ok', text = 'page words' WHERE link_id = ?").run(
    n,
  );
  run("INSERT INTO link_vectors VALUES (?, ?, 'm', 1, 'h', x'00000000', 5)");
  run("INSERT INTO link_images VALUES (?, ?, 'image/png', x'00', 'h', 5, 'preview')");
  run("INSERT INTO owner_images VALUES (?, ?, 'image/png', x'00', 'h', 5)");
  run(
    `INSERT INTO link_edits (owner_id, link_id, edit_id, title_changed, picture_changed,
       written_title, at) VALUES (?, ?, 'e', 1, 0, 't', 5)`,
  );
  run("INSERT INTO link_tools VALUES (?, ?, 'kept', 'stated', 5, NULL, 30)");
  run("INSERT INTO link_checks (owner_id, link_id, checked_at, result) VALUES (?, ?, 5, 'alive')");
  run(
    `INSERT INTO saved_copies (owner_id, link_id, status, made_at, removed_at, bytes)
     VALUES (?, ?, 'removed', 1, 1, 0)`,
  );
  run(
    "INSERT INTO saved_copy_images VALUES (?, ?, 1, 'https://ex.com/i.png', 'none', NULL, NULL, NULL)",
  );
}

function rowsFor(db: Database.Database, id: string): number[] {
  return [
    ...LINK_TABLES.map(
      (t) =>
        db.prepare(`SELECT count(*) FROM ${t} WHERE link_id = ?`).pluck().get(Number(id)) as number,
    ),
    ...SEARCH_TABLES.map(
      (t) =>
        db.prepare(`SELECT count(*) FROM ${t} WHERE rowid = ?`).pluck().get(Number(id)) as number,
    ),
  ];
}

describe("deleting, restoring and purging a link", () => {
  it("purge removes every child row and the search rows", async () => {
    const { db, deps, save } = setup();
    const gone = await save({ title: "quokka" });
    const kept = await save({ title: "bilby" });
    const theirs = (await deps.store.insertIfAbsent(B, { ...newLink(90, at(0)), title: "numbat" }))
      .link.id;
    for (const [owner, id] of [
      [A, gone],
      [A, kept],
      [B, theirs],
    ] as const) {
      seedChildren(db, owner, id);
    }
    const ones = Array(LINK_TABLES.length + SEARCH_TABLES.length).fill(1);
    expect([gone, kept, theirs].map((id) => rowsFor(db, id))).toEqual([ones, ones, ones]);

    expect(await deps.store.markDeleted(A, gone, at(10))).toBe(true);
    expect(await deps.store.purgeDeleted(at(11))).toBe(1);

    const zeros = ones.map(() => 0);
    expect([gone, kept, theirs].map((id) => rowsFor(db, id))).toEqual([zeros, ones, ones]);
    expect(db.prepare("SELECT count(*) FROM links WHERE id = ?").pluck().get(Number(gone))).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("never issues a purged link's id again, even the newest", async () => {
    const { deps, save } = setup();
    await save();
    const old = await save();
    await deps.store.markDeleted(A, old, at(10));
    expect(await deps.store.purgeDeleted(at(11))).toBe(1);
    const next = await save();
    expect(Number(next)).toBeGreaterThan(Number(old));
  });

  it("delete marks an ok copy removed at the same time, and Undo brings it back", async () => {
    const { deps, save, copyRow } = await withCopies();
    const id = await save();
    expect(await deps.savedCopies.saveCopy(A, id, copyDraft(), LIMITS, at(5))).toBe("saved");
    const bytes = copyRow(id)?.bytes;

    expect(await deps.store.markDeleted(A, id, at(10))).toBe(true);
    expect(copyRow(id)).toEqual({ status: "removed", removedAt: at(10).getTime(), bytes });
    expect(await deps.savedCopies.readCopy(A, id)).toBeNull();

    expect(await deps.store.unmarkDeleted(A, id, at(0))).toBe(true);
    expect(copyRow(id)).toEqual({ status: "ok", removedAt: null, bytes });
    expect(await deps.savedCopies.readCopy(A, id)).toMatchObject({ markdown: "# body" });
  });

  it("Undo leaves a copy the owner removed earlier still removed", async () => {
    const { deps, save, copyRow } = await withCopies();
    const id = await save();
    await deps.savedCopies.saveCopy(A, id, copyDraft(), LIMITS, at(5));
    expect(await deps.savedCopies.removeCopy(A, id, at(8))).toBe(true);

    expect(await deps.store.markDeleted(A, id, at(10))).toBe(true);
    expect(await deps.store.unmarkDeleted(A, id, at(0))).toBe(true);

    expect(await deps.store.get(A, id)).not.toBeNull();
    expect(copyRow(id)).toMatchObject({ status: "removed", removedAt: at(8).getTime() });
  });

  it("purge skips a link whose copy still has files, until purgeRemoved retires them", async () => {
    const { deps, save, copyRow, folderOf } = await withCopies();
    const id = await save();
    await deps.savedCopies.saveCopy(A, id, copyDraft(), LIMITS, at(5));
    const used = await deps.savedCopies.usedBytes();
    expect(used).toBeGreaterThan(0);
    await deps.store.markDeleted(A, id, at(10));

    expect(await deps.store.purgeDeleted(at(100))).toBe(0);
    expect(await deps.savedCopies.usedBytes()).toBe(used);
    expect(existsSync(folderOf(id))).toBe(true);
    expect(copyRow(id)?.status).toBe("removed");

    expect(await deps.savedCopies.purgeRemoved(at(100))).toBe(1);
    expect(existsSync(folderOf(id))).toBe(false);
    expect(await deps.savedCopies.usedBytes()).toBe(0);
    expect(await deps.store.purgeDeleted(at(100))).toBe(1);
    expect(copyRow(id)).toBeUndefined();
    expect(await deps.store.unmarkDeleted(A, id, at(0))).toBe(false);
  });

  it("copy page reads return nothing for a hidden link", async () => {
    const { deps, save } = await withCopies();
    const id = await save();
    await deps.savedCopies.saveCopy(A, id, copyDraft(1), LIMITS, at(5));
    expect(await deps.savedCopies.saveCopyImage(A, id, 1, imageUrl(1), PNG, LIMITS)).toBe("saved");
    expect([...(await deps.savedCopies.copyInfo(A, [id])).keys()]).toEqual([id]);
    expect(await deps.savedCopies.copyImage(A, id, 1)).not.toBeNull();
    expect(await deps.savedCopies.readCopy(A, id)).not.toBeNull();

    await deps.store.markDeleted(A, id, at(10));

    expect((await deps.savedCopies.copyInfo(A, [id])).size).toBe(0);
    expect(await deps.savedCopies.copyImage(A, id, 1)).toBeNull();
    expect(await deps.savedCopies.readCopy(A, id)).toBeNull();
  });

  it("a copy whose pictures are still pending at delete takes no more and is purged after the copy pass", async () => {
    const { deps, save, copyRow, folderOf } = await withCopies();
    const id = await save();
    await deps.savedCopies.saveCopy(A, id, copyDraft(3), LIMITS, at(5));
    expect(await deps.savedCopies.saveCopyImage(A, id, 1, imageUrl(1), PNG, LIMITS)).toBe("saved");
    const used = await deps.savedCopies.usedBytes();

    await deps.store.markDeleted(A, id, at(10));

    expect(await deps.savedCopies.pendingCopyImages(null, 10)).toEqual([]);
    expect(await deps.savedCopies.saveCopyImage(A, id, 2, imageUrl(2), PNG, LIMITS)).toBe(false);
    expect(await deps.savedCopies.endCopyImage(A, id, 3, imageUrl(3), "refused")).toBe(false);
    expect(await deps.savedCopies.finishCopy(A, id, finishedMarkdown, at(11))).toBe(false);
    expect(await deps.savedCopies.unfinishedCopies(null, 10)).toEqual([]);
    expect(await deps.savedCopies.usedBytes()).toBe(used);
    expect(copyRow(id)).toMatchObject({ status: "removed", removedAt: at(10).getTime() });

    expect(await deps.store.purgeDeleted(at(100))).toBe(0);
    expect(await deps.savedCopies.purgeRemoved(at(100))).toBe(1);
    expect(existsSync(folderOf(id))).toBe(false);
    expect(await deps.store.purgeDeleted(at(100))).toBe(1);
    expect(await deps.savedCopies.usedBytes()).toBe(0);
  });

  it("a finish in flight when the link is deleted writes nothing, and the link still purges", async () => {
    const { deps, save, copyRow, folderOf } = await withCopies();
    const id = await save();
    const markdown = `# body ![a quokka](${imageRef(1, NONCE)})`;
    await deps.savedCopies.saveCopy(A, id, { ...copyDraft(1), markdown }, LIMITS, at(5));
    await deps.savedCopies.endCopyImage(A, id, 1, imageUrl(1), "refused");
    expect(finishedMarkdown(markdown, NONCE, [{ n: 1, ext: null }])).not.toBe(markdown);
    const before = copyRow(id);
    const read = CopyFolder.prototype.readMarkdown;
    vi.spyOn(CopyFolder.prototype, "readMarkdown").mockImplementation(async function (
      this: CopyFolder,
      linkId: string,
    ) {
      const markdown = await read.call(this, linkId);
      await deps.store.markDeleted(A, id, at(10));
      return markdown;
    });

    expect(await deps.savedCopies.finishCopy(A, id, finishedMarkdown, at(11))).toBe(false);

    expect(copyRow(id)).toEqual({ ...before, status: "removed", removedAt: at(10).getTime() });
    expect(readFileSync(join(folderOf(id), "copy.md"), "utf8")).toBe(markdown);
    vi.restoreAllMocks();
    expect(await deps.savedCopies.purgeRemoved(at(100))).toBe(1);
    expect(await deps.store.purgeDeleted(at(100))).toBe(1);
  });

  it("a copy left saving at delete never becomes ok, and the link purges once the startup undo runs", async () => {
    const { db, deps, save, copyRow } = await withCopies();
    const id = await save();
    // What a failed confirm whose release also failed leaves until the next start.
    db.prepare(
      `INSERT INTO saved_copies (owner_id, link_id, status, made_at, md_bytes, bytes)
       VALUES (?, ?, 'saving', 5, 6, 6)`,
    ).run(A, Number(id));

    expect(await deps.store.markDeleted(A, id, at(10))).toBe(true);
    expect(copyRow(id)?.status).toBe("saving");
    expect(await deps.store.purgeDeleted(at(100))).toBe(0);
    expect(await deps.store.unmarkDeleted(A, id, at(0))).toBe(true);
    expect(copyRow(id)?.status).toBe("saving");
    await deps.store.markDeleted(A, id, at(20));

    expect(await deps.savedCopies.undoUnconfirmed()).toEqual({ copies: 1, images: 0 });
    expect(copyRow(id)).toBeUndefined();
    expect(await deps.store.purgeDeleted(at(100))).toBe(1);
  });

  it("a re-save over a hidden link with copy files leaves an orphan folder the sweep removes", async () => {
    const { deps, save, copyRow, folderOf } = await withCopies();
    const id = await save();
    await deps.savedCopies.saveCopy(A, id, copyDraft(), LIMITS, at(5));
    const copyBytes = copyRow(id)?.bytes as number;
    const used = await deps.savedCopies.usedBytes();
    expect(copyBytes).toBeGreaterThan(0);
    const urlKey = (await deps.store.get(A, id))?.urlKey as string;
    await deps.store.markDeleted(A, id, at(10));

    const again = await deps.store.insertIfAbsent(A, { ...newLink(1, at(0)), urlKey });

    expect(again.created).toBe(true);
    expect(again.link.id).not.toBe(id);
    expect(copyRow(id)).toBeUndefined();
    expect(existsSync(folderOf(id))).toBe(true);
    expect(await deps.savedCopies.usedBytes()).toBe(used - copyBytes);

    const report = await deps.savedCopies.sweep(0, new Date(Date.now() + 60_000));
    expect(report.folders).toBe(1);
    expect(existsSync(folderOf(id))).toBe(false);
  });
});
