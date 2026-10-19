import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { previewDigest } from "../core/digest.js";
import type { ImageBytes } from "../core/image-store.js";
import type { LinkCheck } from "../core/link-check-store.js";
import { copyLimits } from "../core/saved-copy.js";
import { at, newLink, record } from "../core/snapshot-store-contract.js";
import type { ToolRecord } from "../core/tool-store.js";
import { listShelf } from "../core/tools.js";
import { worthALook } from "../core/worth-a-look.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS, MODEL_KEY } from "../search/model.js";
import { openDatabase } from "./database.js";

const A = "owner-a";
const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
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

function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  const embedder = new FakeEmbedder(DIMS);
  const deps = createDeps(db, embedder);
  deps.store.ensureUser(A, A);
  let n = 0;
  const save = async (over: Partial<ReturnType<typeof newLink>> = {}) =>
    (await deps.store.insertIfAbsent(A, { ...newLink(++n, at(0)), ...over })).link.id;
  const snapshot = async (id: string, over: Parameters<typeof record>[0] = {}) => {
    const lease = await deps.store.leaseSnapshot(A, id, at(1), at(100));
    if (!lease) throw new Error("the new link's snapshot should be leasable");
    await deps.store.recordSnapshot(A, id, lease.claim, record(over));
  };
  const hide = (...ids: string[]) => {
    for (const id of ids) {
      db.prepare("UPDATE links SET deleted_at = ? WHERE owner_id = ? AND id = ?").run(
        at(500).getTime(),
        A,
        Number(id),
      );
    }
  };
  return { db, deps, embedder, save, snapshot, hide };
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

    hide(id);

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

    hide(wanting, pictured);

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

    hide(tool, gone, plain);

    expect(await view()).toEqual({ shelf: [], gone: null, digest: [] });
  });
});

const CHILD_TABLES = ["link_tools", "owner_images", "link_edits", "link_checks", "link_vectors"];

describe("writes on a hidden link", () => {
  it("tool, edit, check, vector and copy writes refuse a hidden link and change nothing", async () => {
    const { db, deps, embedder, save, hide } = setup();
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
    hide(id, bare);

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
    hide(id);

    const again = await deps.store.insertIfAbsent(A, { ...newLink(1, at(0)), urlKey });

    expect(again.created).toBe(true);
    expect(again.link.id).not.toBe(id);
    expect(tables.map(count)).toEqual([0, 0, 0, 0]);
  });
});
