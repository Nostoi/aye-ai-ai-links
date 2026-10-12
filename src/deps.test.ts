import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDigest } from "./core/digest.js";
import { documentHash } from "./core/link-document.js";
import { saveLink, updateLink } from "./core/links.js";
import { addProfile } from "./core/profile.js";
import type { SearchTrace } from "./core/search.js";
import { searchLinks } from "./core/search-links.js";
import { createVectorIndexer } from "./core/vector-indexer.js";
import { createDeps } from "./deps.js";
import { FakeEmbedder } from "./search/embedder.js";
import { DIMS, MODEL_KEY } from "./search/model.js";
import { VectorSearch } from "./search/vector-search.js";
import { openDatabase } from "./store/database.js";

const OWNER = "o";

describe("createDeps", () => {
  afterEach(() => vi.restoreAllMocks());

  it("wires meaning search: a link matching only by meaning is found without the keyword fallback", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = openDatabase(":memory:");
    const embedder = new FakeEmbedder(DIMS);
    const deps = createDeps(db, embedder);
    deps.store.ensureUser(OWNER, OWNER);
    const { link } = await saveLink(deps, OWNER, {
      url: "https://ex.com/a",
      title: "alpha",
      savedBy: "t",
    });
    const [vector] = await embedder.embedDocuments(["quokka"]);
    const v = vector as Float32Array;
    db.prepare("INSERT INTO link_vectors VALUES (?, ?, ?, ?, 'h', ?, 0)").run(
      OWNER,
      Number(link.id),
      MODEL_KEY,
      v.length,
      Buffer.from(v.buffer),
    );
    const traces: SearchTrace[] = [];

    const ids = await deps.search.search(OWNER, "quokka", {}, 5, (t) => traces.push(t));

    expect(logged).not.toHaveBeenCalled();
    expect(traces).toEqual([
      {
        mode: "hybrid",
        embedded: "quokka",
        modelKey: MODEL_KEY,
        similarity: { [link.id]: 1 },
        meaningCandidates: 1,
        ranks: { [link.id]: { meaning: 1 } },
      },
    ]);
    expect(ids).toEqual([link.id]);
    db.close();
  });
});

describe("the vector indexer on createDeps' index store", () => {
  const opened: Database[] = [];
  afterEach(() => {
    for (const db of opened.splice(0)) if (db.open) db.close();
  });

  function setup() {
    const db = openDatabase(":memory:");
    opened.push(db);
    const fake = new FakeEmbedder(DIMS);
    const docs: string[][] = [];
    const embedder = {
      embedQuery: (t: string, s?: AbortSignal) => fake.embedQuery(t, s),
      embedDocuments: (texts: string[]) => {
        docs.push(texts);
        return fake.embedDocuments(texts);
      },
    };
    const deps = createDeps(db, embedder);
    deps.store.ensureUser(OWNER, OWNER);
    let scanned = 0;
    const store = Object.create(deps.vectorIndex) as typeof deps.vectorIndex;
    store.indexPage = async (...args) => {
      const rows = await deps.vectorIndex.indexPage(...args);
      scanned += rows.length;
      return rows;
    };
    const indexer = createVectorIndexer({
      store,
      embedder,
      modelKey: MODEL_KEY,
      now: () => new Date(0),
      log: () => undefined,
    });
    const save = async (n: number, title: string) =>
      (await saveLink(deps, OWNER, { url: `https://ex.com/${n}`, title, savedBy: "t" })).link;
    /** Runs one sweep; returns the rows it scanned and the links it embedded, by URL number. */
    const sweep = async () => {
      const [s0, d0] = [scanned, docs.length];
      await indexer.sweep();
      const embedded = docs.slice(d0).map((t) => t.map((d) => d.match(/ex\.com\/(\d+)/)?.[1]));
      return { scanned: scanned - s0, embedded };
    };
    const vector = (id: string) =>
      db
        .prepare("SELECT text_hash AS hash, embedding FROM link_vectors WHERE link_id = ?")
        .get(Number(id)) as { hash: string; embedding: Buffer } | undefined;
    return { db, deps, fake, docs, indexer, save, sweep, vector };
  }

  it("D-T4: the first sweep embeds every link, one per call, into rows meaning search finds", async () => {
    const h = setup();
    const a = await h.save(1, "Car maintenance");
    const b = await h.save(2, "Sourdough starter");
    const traces: SearchTrace[] = [];
    expect(await h.deps.search.search(OWNER, "zebra", {}, 5)).toEqual([]);
    expect(await h.sweep()).toEqual({ scanned: 2, embedded: [["1"], ["2"]] });
    const ids = await h.deps.search.search(OWNER, "zebra", {}, 5, (t) => traces.push(t));
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
    expect(traces[0]).toMatchObject({ mode: "hybrid", meaningCandidates: 2 });
    const [doc] = h.docs[0] as string[];
    const [v] = await h.fake.embedDocuments([doc as string]);
    const vs = new VectorSearch(h.db, MODEL_KEY);
    const [best] = vs.nearest(OWNER, v as Float32Array, {}, 1);
    expect(best?.id).toBe(a.id);
    expect(best?.similarity).toBeCloseTo(1, 5);
  });

  it("D-T5: a title edit, a tag change or a fetched page re-embeds exactly that link", async () => {
    const h = setup();
    const a = await h.save(1, "One");
    const b = await h.save(2, "Two");
    const c = await h.save(3, "Three");
    await h.sweep();
    expect(await h.sweep()).toEqual({ scanned: 3, embedded: [] });

    await updateLink(h.deps, OWNER, a.id, { title: "Uno" });
    expect((await h.sweep()).embedded).toEqual([["1"]]);

    await updateLink(h.deps, OWNER, b.id, { tags: [{ name: "bread", source: "stated" }] });
    expect((await h.sweep()).embedded).toEqual([["2"]]);
    expect(h.docs.at(-1)?.[0]).toContain("bread");

    const later = Date.now() + 60_000;
    const lease = await h.deps.store.leaseSnapshot(
      OWNER,
      c.id,
      new Date(later),
      new Date(later + 60_000),
    );
    if (!lease) throw new Error("expected a lease");
    await h.deps.store.recordSnapshot(OWNER, c.id, lease.claim, {
      status: "ok",
      attempts: 1,
      nextFetchAt: null,
      fetchedAt: new Date(2),
      title: "Page",
      description: null,
      imageUrl: null,
      text: "the page body",
      lastError: null,
    });
    expect((await h.sweep()).embedded).toEqual([["3"]]);
    expect(h.docs.at(-1)?.[0]).toContain("the page body");
  });

  it("D-T6: idle sweeps scan nothing; a logged search makes the next one scan, embedding nothing", async () => {
    const h = setup();
    await h.save(1, "One");
    await h.save(2, "Two");
    expect(await h.sweep()).toMatchObject({ scanned: 2 });
    expect(await h.sweep()).toEqual({ scanned: 2, embedded: [] });
    expect(await h.sweep()).toEqual({ scanned: 0, embedded: [] });
    await searchLinks(h.deps, OWNER, { query: "one" }, "t");
    expect(h.db.prepare("SELECT count(*) AS n FROM search_log").get()).toEqual({ n: 1 });
    expect(await h.sweep()).toEqual({ scanned: 2, embedded: [] });
    expect(await h.sweep()).toEqual({ scanned: 0, embedded: [] });
  });

  it("replaces the vector when every owner field is cleared: the document becomes the URL", async () => {
    const h = setup();
    const a = await h.save(1, "Car maintenance");
    await updateLink(h.deps, OWNER, a.id, {
      why: { text: "fixing the car", source: "stated" },
      tags: [{ name: "cars", source: "stated" }],
    });
    await h.sweep();
    expect(h.docs.at(-1)?.[0]).toContain("Car maintenance");
    await updateLink(h.deps, OWNER, a.id, { title: null, summary: null, why: null, tags: [] });
    expect((await h.sweep()).embedded).toEqual([["1"]]);
    const row = h.vector(a.id);
    expect(row?.hash).toBe(documentHash(MODEL_KEY, "https://ex.com/1"));
    const [urlOnly] = await h.fake.embedDocuments(["https://ex.com/1"]);
    expect(row && new Float32Array(new Uint8Array(row.embedding).buffer)).toEqual(urlOnly);
    expect(h.db.prepare("SELECT count(*) AS n FROM link_vectors").get()).toEqual({ n: 1 });
  });
});

describe("the digest on createDeps", () => {
  it("matches focus words in page text through the keyword engine, logs nothing, and claims in SQLite", async () => {
    const db = openDatabase(":memory:");
    const now = new Date("2026-06-01T00:00:00Z");
    const deps = { ...createDeps(db, new FakeEmbedder(DIMS)), now: () => now };
    deps.store.ensureUser(OWNER, OWNER);
    const why = { text: "w", source: "stated" as const };
    const save = async (n: number) =>
      (await saveLink(deps, OWNER, { url: `https://ex.com/${n}`, savedBy: "t", why })).link;
    const links = [];
    for (let n = 1; n <= 7; n++) links.push(await save(n));
    const paged = links[6] as (typeof links)[number];
    const lease = await deps.store.leaseSnapshot(OWNER, paged.id, now, new Date(now.getTime() + 1));
    if (!lease) throw new Error("expected a lease");
    await deps.store.recordSnapshot(OWNER, paged.id, lease.claim, {
      status: "ok",
      attempts: 1,
      nextFetchAt: null,
      fetchedAt: now,
      title: null,
      description: null,
      imageUrl: null,
      text: "all about the quokka",
      lastError: null,
    });
    const { recentFocus } = await addProfile(deps, OWNER, "t", {
      addFocus: [{ text: "quokka", source: "inferred" }],
    });
    const traces: SearchTrace[] = [];
    expect(await deps.keywordSearch.search(OWNER, "quokka", {}, 5, (t) => traces.push(t))).toEqual([
      paged.id,
    ]);
    expect(traces.map((t) => t.mode)).toEqual(["keyword"]);

    const first = await getDigest(deps, OWNER);

    expect(first.links.map((l) => l.link.id)).toEqual([
      paged.id,
      ...links.slice(0, 4).map((l) => l.id),
    ]);
    expect(first.links[0]?.reasons).toEqual([
      { kind: "focus_words", focus: recentFocus[0] },
      { kind: "never_surfaced" },
    ]);
    expect(first.links[0]?.link.lastSurfacedAt).toEqual(now);
    expect(db.prepare("SELECT count(*) AS n FROM search_log").get()).toEqual({ n: 0 });
    expect((await getDigest(deps, OWNER)).links.map((l) => l.link.id)).toEqual(
      links.slice(4, 6).map((l) => l.id),
    );
    db.close();
  });
});
