import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_CHARS } from "../core/link-document.js";
import { A, at, B, newLink, record } from "../core/snapshot-store-contract.js";
import type { LinkTag, NewLink } from "../core/types.js";
import { openDatabase } from "./database.js";
import { SqliteStore } from "./sqlite-store.js";
import { SqliteVectorIndex } from "./sqlite-vector-index.js";

const DIMS = 4;
const KEY = "model-1";

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  const store = new SqliteStore(db);
  store.ensureUser(A, A);
  store.ensureUser(B, B);
  const index = new SqliteVectorIndex(db, DIMS);
  let n = 0;
  const save = async (owner: string, over: Partial<NewLink> = {}) =>
    (await store.insertIfAbsent(owner, { ...newLink(++n, at(0)), ...over })).link;
  const vectors = () =>
    db
      .prepare(
        "SELECT owner_id AS owner, link_id AS linkId, model_key AS modelKey, dims, text_hash AS hash, embedded_at AS at FROM link_vectors ORDER BY link_id, model_key",
      )
      .all();
  const embedding = (linkId: string, modelKey = KEY) => {
    const row = db
      .prepare("SELECT embedding FROM link_vectors WHERE link_id = ? AND model_key = ?")
      .get(Number(linkId), modelKey) as { embedding: Buffer } | undefined;
    return row && Array.from(new Float32Array(new Uint8Array(row.embedding).buffer));
  };
  return { db, store, index, save, vectors, embedding };
}

const unit = (i = 0) => Float32Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
const tag = (name: string): LinkTag => ({
  key: name.toLowerCase(),
  name,
  source: "stated",
  kind: "topic",
});

describe("SqliteVectorIndex.writeVector (D-T3)", () => {
  it("writes a unit vector with its owner, model, dims, hash and time", async () => {
    const h = setup();
    const link = await h.save(A);
    expect(await h.index.writeVector(A, link.id, KEY, "h1", unit(), at(5))).toBe(true);
    expect(h.vectors()).toEqual([
      {
        owner: A,
        linkId: Number(link.id),
        modelKey: KEY,
        dims: DIMS,
        hash: "h1",
        at: at(5).getTime(),
      },
    ]);
    expect(h.embedding(link.id)).toEqual([1, 0, 0, 0]);
  });

  it("accepts a length within 1e-3 of 1", async () => {
    const h = setup();
    const link = await h.save(A);
    const v = Float32Array.of(1.0009, 0, 0, 0);
    expect(await h.index.writeVector(A, link.id, KEY, "h", v, at(5))).toBe(true);
  });

  const bad: [string, Float32Array][] = [
    ["too short", Float32Array.of(1, 0, 0)],
    ["too long", Float32Array.of(1, 0, 0, 0, 0)],
    ["NaN", Float32Array.of(Number.NaN, 1, 0, 0)],
    ["Infinity", Float32Array.of(Number.POSITIVE_INFINITY, 0, 0, 0)],
    ["zero", new Float32Array(DIMS)],
    ["not unit length", Float32Array.of(1.002, 0, 0, 0)],
  ];
  for (const [name, v] of bad) {
    it(`rejects a ${name} vector with a RangeError and writes nothing`, async () => {
      const h = setup();
      const link = await h.save(A);
      await expect(h.index.writeVector(A, link.id, KEY, "h", v, at(5))).rejects.toThrow(RangeError);
      expect(h.vectors()).toEqual([]);
    });
  }

  it("rejects a bad vector without replacing the stored one", async () => {
    const h = setup();
    const link = await h.save(A);
    await h.index.writeVector(A, link.id, KEY, "h1", unit(), at(5));
    await expect(
      h.index.writeVector(A, link.id, KEY, "h2", new Float32Array(DIMS), at(6)),
    ).rejects.toThrow(RangeError);
    expect(h.vectors()).toMatchObject([{ hash: "h1", at: at(5).getTime() }]);
  });

  it("returns false and writes nothing for a link that does not exist, or a malformed id", async () => {
    const h = setup();
    for (const id of ["999", "0", "abc", "1.5"]) {
      expect(await h.index.writeVector(A, id, KEY, "h", unit(), at(5)), id).toBe(false);
    }
    expect(h.vectors()).toEqual([]);
  });

  it("replaces the vector for the same link and model, keeping other models' vectors", async () => {
    const h = setup();
    const link = await h.save(A);
    await h.index.writeVector(A, link.id, KEY, "h1", unit(0), at(5));
    await h.index.writeVector(A, link.id, "other", "o1", unit(2), at(5));
    await h.index.writeVector(A, link.id, KEY, "h2", unit(1), at(6));
    expect(h.vectors()).toMatchObject([
      { modelKey: KEY, hash: "h2", at: at(6).getTime() },
      { modelKey: "other", hash: "o1" },
    ]);
    expect(h.embedding(link.id)).toEqual([0, 1, 0, 0]);
  });
});

describe("SqliteVectorIndex owner safety (D-T10)", () => {
  it("writes nothing for another owner's link, and leaves its vector alone", async () => {
    const h = setup();
    const link = await h.save(A);
    await h.index.writeVector(A, link.id, KEY, "mine", unit(0), at(5));
    expect(await h.index.writeVector(B, link.id, KEY, "theirs", unit(1), at(6))).toBe(false);
    expect(h.vectors()).toMatchObject([{ owner: A, hash: "mine" }]);
    expect(h.embedding(link.id)).toEqual([1, 0, 0, 0]);
  });
});

describe("SqliteVectorIndex.indexPage", () => {
  it("pages through every owner's links in id order, archived ones included", async () => {
    const h = setup();
    const a1 = await h.save(A);
    const b1 = await h.save(B, { state: "archived" });
    const a2 = await h.save(A);
    const first = await h.index.indexPage(KEY, null, 2);
    expect(first.map((r) => [r.owner, r.linkId])).toEqual([
      [A, a1.id],
      [B, b1.id],
    ]);
    const second = await h.index.indexPage(KEY, b1.id, 2);
    expect(second.map((r) => [r.owner, r.linkId])).toEqual([[A, a2.id]]);
    expect(await h.index.indexPage(KEY, a2.id, 2)).toEqual([]);
  });

  it("returns the link's fields, tags in order, and its page snapshot", async () => {
    const h = setup();
    const link = await h.save(A, {
      url: "https://ex.com/x",
      urlKey: "ex.com/x",
      title: "Title",
      summary: "Summary",
      why: { text: "Why", source: "stated" },
      tags: [tag("Zeta"), tag("Alpha")],
    });
    const lease = await h.store.leaseSnapshot(A, link.id, at(1), at(100));
    if (!lease) throw new Error("expected a lease");
    await h.store.recordSnapshot(
      A,
      link.id,
      lease.claim,
      record({ title: "PT", description: "PD", text: "body" }),
    );
    expect(await h.index.indexPage(KEY, null, 10)).toEqual([
      {
        owner: A,
        linkId: link.id,
        url: "https://ex.com/x",
        title: "Title",
        summary: "Summary",
        why: "Why",
        tags: ["Zeta", "Alpha"],
        pageTitle: "PT",
        pageDescription: "PD",
        pageText: "body",
        textHash: null,
      },
    ]);
  });

  it("returns tags in position order, not tag-id order", async () => {
    const h = setup();
    await h.save(A, { url: "https://ex.com/a", urlKey: "ex.com/a", tags: [tag("Alpha")] });
    await h.save(A, {
      url: "https://ex.com/b",
      urlKey: "ex.com/b",
      tags: [tag("Beta"), tag("Alpha")],
    });
    const rows = await h.index.indexPage(KEY, null, 10);
    expect(rows.map((r) => r.tags)).toEqual([["Alpha"], ["Beta", "Alpha"]]);
  });

  it("returns nulls and no tags for a bare link with a pending snapshot", async () => {
    const h = setup();
    await h.save(A);
    expect(await h.index.indexPage(KEY, null, 10)).toMatchObject([
      { title: null, summary: null, why: null, tags: [], pageTitle: null, pageText: null },
    ]);
  });

  it("reads at most PAGE_CHARS code points of page text", async () => {
    const h = setup();
    const link = await h.save(A);
    const lease = await h.store.leaseSnapshot(A, link.id, at(1), at(100));
    if (!lease) throw new Error("expected a lease");
    await h.store.recordSnapshot(A, link.id, lease.claim, record({ text: "😀".repeat(5000) }));
    const [row] = await h.index.indexPage(KEY, null, 10);
    expect(row?.pageText).toBe("😀".repeat(PAGE_CHARS));
  });

  it("returns the stored hash for the model asked about only", async () => {
    const h = setup();
    const link = await h.save(A);
    await h.index.writeVector(A, link.id, "other", "o1", unit(), at(5));
    expect((await h.index.indexPage(KEY, null, 10))[0]?.textHash).toBeNull();
    await h.index.writeVector(A, link.id, KEY, "h1", unit(), at(5));
    expect((await h.index.indexPage(KEY, null, 10))[0]?.textHash).toBe("h1");
  });
});

describe("SqliteVectorIndex.retireModels (D-T8)", () => {
  it("deletes every owner's vectors for other models, and returns how many", async () => {
    const h = setup();
    const a = await h.save(A);
    const b = await h.save(B);
    await h.index.writeVector(A, a.id, KEY, "h", unit(), at(5));
    await h.index.writeVector(A, a.id, "old", "h", unit(), at(5));
    await h.index.writeVector(B, b.id, "old", "h", unit(), at(5));
    expect(await h.index.retireModels(KEY)).toBe(2);
    expect(h.vectors()).toMatchObject([{ owner: A, modelKey: KEY }]);
  });
});

describe("SqliteVectorIndex.changeCount", () => {
  it("moves with any write on the connection, and not with a read", async () => {
    const h = setup();
    const c0 = await h.index.changeCount();
    await h.index.indexPage(KEY, null, 10);
    expect(await h.index.changeCount()).toBe(c0);
    const link = await h.save(A);
    const c1 = await h.index.changeCount();
    expect(c1).toBeGreaterThan(c0);
    await h.store.update(A, link.id, { title: "x" });
    expect(await h.index.changeCount()).toBeGreaterThan(c1);
  });
});
