import { afterEach, describe, expect, it, vi } from "vitest";
import { type DocumentInput, documentHash, linkDocument } from "./link-document.js";
import type { IndexRow, VectorIndexStore } from "./vector-index-store.js";
import {
  createVectorIndexer,
  type DocumentEmbedder,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type VectorIndexer,
  type VectorIndexerOptions,
} from "./vector-indexer.js";

const KEY = "model-1";
const OWNER = "o";

type Link = DocumentInput & { owner: string; linkId: string };

/** An in-memory index store that counts what the indexer reads and writes. */
class FakeIndexStore implements VectorIndexStore {
  links: Link[] = [];
  vectors = new Map<string, { hash: string; modelKey: string; at: Date }>();
  changes = 0;
  scanned = 0;
  pageCalls: (string | null)[] = [];
  retired: string[] = [];
  onPage: (afterId: string | null) => void = () => {};
  writeError: (linkId: string) => Error | null = () => null;
  failPage: Error | null = null;
  failChangeCount: Error | null = null;
  failRetire: Error | null = null;

  add(id: number, o: Partial<DocumentInput> = {}): Link {
    const link: Link = {
      owner: OWNER,
      linkId: String(id),
      url: `https://ex.com/${id}`,
      title: `Link ${id}`,
      summary: null,
      why: null,
      tags: [],
      pageTitle: null,
      pageDescription: null,
      pageText: null,
      ...o,
    };
    this.links.push(link);
    this.links.sort((a, b) => Number(a.linkId) - Number(b.linkId));
    this.changes++;
    return link;
  }

  edit(id: number, o: Partial<DocumentInput>): void {
    const link = this.links.find((l) => l.linkId === String(id));
    if (!link) throw new Error(`no link ${id}`);
    Object.assign(link, o);
    this.changes++;
  }

  remove(id: number): void {
    this.links = this.links.filter((l) => l.linkId !== String(id));
    this.vectors.delete(String(id));
    this.changes++;
  }

  async indexPage(modelKey: string, afterId: string | null, limit: number): Promise<IndexRow[]> {
    this.pageCalls.push(afterId);
    this.onPage(afterId);
    if (this.failPage) throw this.failPage;
    const rows = this.links
      .filter((l) => afterId === null || Number(l.linkId) > Number(afterId))
      .slice(0, limit)
      .map((l) => {
        const v = this.vectors.get(l.linkId);
        return { ...l, tags: [...l.tags], textHash: v?.modelKey === modelKey ? v.hash : null };
      });
    this.scanned += rows.length;
    return rows;
  }

  async writeVector(
    owner: string,
    linkId: string,
    modelKey: string,
    textHash: string,
    _vector: Float32Array,
    at: Date,
  ): Promise<boolean> {
    const error = this.writeError(linkId);
    if (error) throw error;
    if (!this.links.some((l) => l.linkId === linkId && l.owner === owner)) return false;
    this.vectors.set(linkId, { hash: textHash, modelKey, at });
    this.changes++;
    return true;
  }

  async retireModels(currentKey: string): Promise<number> {
    this.retired.push(currentKey);
    if (this.failRetire) throw this.failRetire;
    return 0;
  }

  async changeCount(): Promise<number> {
    if (this.failChangeCount) throw this.failChangeCount;
    return this.changes;
  }
}

/** A document embedder that records each call; `fail` and `hold` pick documents by substring. */
function fakeEmbedder() {
  const e = {
    calls: [] as string[][],
    fail: null as string | null,
    hold: null as string | null,
    release: () => {},
    held: null as Promise<void> | null,
    embedDocuments: async (texts: string[]): Promise<Float32Array[]> => {
      e.calls.push(texts);
      if (e.hold !== null && texts.some((t) => t.includes(e.hold as string))) {
        e.held = new Promise<void>((r) => {
          e.release = r;
        });
        await e.held;
      }
      if (e.fail !== null && texts.some((t) => t.includes(e.fail as string))) {
        throw new Error("inference failed");
      }
      return texts.map(() => Float32Array.of(1, 0));
    },
  };
  return e;
}

/** Lets queued promise and setImmediate work run; setImmediate is never faked here. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const indexers: VectorIndexer[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(indexers.splice(0).map((i) => i.stop()));
});

function setup(o: Partial<VectorIndexerOptions> = {}) {
  const store = new FakeIndexStore();
  const embedder = fakeEmbedder();
  const clock = { ms: Date.UTC(2026, 0, 1) };
  const log = vi.fn();
  const indexer = createVectorIndexer({
    store,
    embedder: embedder as DocumentEmbedder,
    modelKey: KEY,
    now: () => new Date(clock.ms),
    log,
    pageSize: 2,
    ...o,
  });
  indexers.push(indexer);
  /** The documents embedded, as link ids, in order. */
  const embedded = () =>
    embedder.calls.map((texts) => texts.map((t) => (t.match(/ex\.com\/(\d+)/) ?? [])[1]));
  const hashOf = (id: number) => {
    const link = store.links.find((l) => l.linkId === String(id));
    if (!link) throw new Error(`no link ${id}`);
    return documentHash(KEY, linkDocument(link));
  };
  /** Rows read by the sweep `fn` runs. */
  const scans = async (fn: () => Promise<void>) => {
    const before = store.scanned;
    await fn();
    return store.scanned - before;
  };
  return { store, embedder, clock, log, indexer, embedded, hashOf, scans };
}

describe("createVectorIndexer: the first sweep (D-T4)", () => {
  it("embeds every link that has no vector, one document per call, and stores its hash", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.store.add(3);
    await h.indexer.sweep();
    expect(h.embedded()).toEqual([["1"], ["2"], ["3"]]);
    expect(h.embedder.calls[0]).toEqual([linkDocument(h.store.links[0] as Link)]);
    for (const id of [1, 2, 3]) {
      expect(h.store.vectors.get(String(id))).toEqual({
        hash: h.hashOf(id),
        modelKey: KEY,
        at: new Date(h.clock.ms),
      });
    }
  });

  it("re-embeds a vector stored with another hash, and leaves a current one alone", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.store.vectors.set("1", { hash: "stale", modelKey: KEY, at: new Date(0) });
    h.store.vectors.set("2", { hash: h.hashOf(2), modelKey: KEY, at: new Date(0) });
    await h.indexer.sweep();
    expect(h.embedded()).toEqual([["1"]]);
  });

  it("counts an embedder that returns no vector as a failure", async () => {
    const h = setup();
    h.store.add(1);
    h.embedder.embedDocuments = async (texts) => {
      h.embedder.calls.push(texts);
      return [];
    };
    await h.indexer.sweep();
    expect(h.store.vectors.size).toBe(0);
    expect(h.log).toHaveBeenCalledOnce();
  });
});

describe("createVectorIndexer: freshness (D-T5)", () => {
  it("re-embeds exactly the edited link on the next sweep", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.store.add(3);
    await h.indexer.sweep();
    h.store.edit(2, { tags: ["new tag"] });
    h.embedder.calls.length = 0;
    await h.indexer.sweep();
    expect(h.embedded()).toEqual([["2"]]);
    expect(h.store.vectors.get("2")?.hash).toBe(h.hashOf(2));
  });

  it("re-embeds a link edited while the sweep that indexed it was running", async () => {
    const h = setup();
    h.store.add(1);
    h.embedder.hold = "ex.com/1";
    const first = h.indexer.sweep();
    await vi.waitFor(() => expect(h.embedder.held).not.toBeNull());
    h.store.edit(1, { title: "Gardening" });
    h.embedder.hold = null;
    h.embedder.release();
    await first;
    h.embedder.calls.length = 0;
    await h.indexer.sweep();
    expect(h.embedded()).toEqual([["1"]]);
    expect(h.store.vectors.get("1")?.hash).toBe(h.hashOf(1));
  });
});

describe("createVectorIndexer: the change-count guard (D-T6)", () => {
  it("skips the scan once a full sweep since the last write has found nothing to do", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.store.add(3);
    expect(await h.scans(h.indexer.sweep)).toBe(3);
    // Its own writes came after the checkpoint, so the next sweep looks again.
    expect(await h.scans(h.indexer.sweep)).toBe(3);
    expect(await h.scans(h.indexer.sweep)).toBe(0);
    expect(await h.scans(h.indexer.sweep)).toBe(0);
    expect(h.embedder.calls).toHaveLength(3);
  });

  it("scans again after any write, even one that changes no document", async () => {
    const h = setup();
    h.store.add(1);
    await h.indexer.sweep();
    await h.indexer.sweep();
    expect(await h.scans(h.indexer.sweep)).toBe(0);
    h.store.changes++;
    expect(await h.scans(h.indexer.sweep)).toBe(1);
    expect(h.embedder.calls).toHaveLength(1);
    expect(await h.scans(h.indexer.sweep)).toBe(0);
  });

  it("does not arm the guard on a sweep that ended early", async () => {
    const h = setup();
    h.store.add(1);
    await h.indexer.sweep();
    await h.indexer.sweep();
    h.store.changes++;
    h.store.failPage = new Error("disk");
    await h.indexer.sweep();
    h.store.failPage = null;
    expect(await h.scans(h.indexer.sweep)).toBe(1);
  });
});

describe("createVectorIndexer: failures (D-T7, D-T7b)", () => {
  it("logs a failing link with its error and indexes the others", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.store.add(3);
    h.embedder.fail = "ex.com/2";
    await h.indexer.sweep();
    expect([...h.store.vectors.keys()].sort()).toEqual(["1", "3"]);
    expect(h.log).toHaveBeenCalledOnce();
    expect(h.log.mock.calls[0]?.[0]).toMatch(/"2"/);
    expect(h.log.mock.calls[0]?.[1]).toMatchObject({ message: "inference failed" });
  });

  it("does not retry an unchanged link before its retry time, and keeps scanning meanwhile", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.embedder.fail = "ex.com/2";
    await h.indexer.sweep();
    h.embedder.calls.length = 0;
    for (let i = 0; i < 3; i++) {
      h.clock.ms += 15_000;
      // The failure is pending, so the guard never skips the scan.
      expect(await h.scans(h.indexer.sweep)).toBe(2);
    }
    expect(h.embedder.calls).toEqual([]);
    expect(h.log).toHaveBeenCalledOnce();
  });

  it("D-T7b: retries an unchanged link once its retry time passes, with no edit", async () => {
    const h = setup();
    h.store.add(1);
    h.embedder.fail = "ex.com/1";
    await h.indexer.sweep();
    h.embedder.fail = null;
    h.clock.ms += RETRY_BASE_MS - 1;
    await h.indexer.sweep();
    expect(h.store.vectors.size).toBe(0);
    h.clock.ms += 1;
    await h.indexer.sweep();
    expect(h.store.vectors.get("1")?.hash).toBe(h.hashOf(1));
    // Recovered: no failure is pending, so the guard arms again.
    await h.indexer.sweep();
    expect(await h.scans(h.indexer.sweep)).toBe(0);
  });

  it("retries at once when the link's document changes", async () => {
    const h = setup();
    h.store.add(1);
    h.embedder.fail = "Link 1";
    await h.indexer.sweep();
    h.store.edit(1, { title: "Fixed" });
    await h.indexer.sweep();
    expect(h.store.vectors.get("1")?.hash).toBe(h.hashOf(1));
  });

  it("forgets a failure when the link's document is back to the one already stored", async () => {
    const h = setup();
    h.store.add(1, { title: "Alpha" });
    await h.indexer.sweep();
    h.store.edit(1, { title: "Beta" });
    h.embedder.fail = "Beta";
    await h.indexer.sweep();
    h.store.edit(1, { title: "Alpha" });
    await h.indexer.sweep();
    expect(await h.scans(h.indexer.sweep)).toBe(0);
  });

  it("starts the backoff over when the document changes", async () => {
    const h = setup();
    h.store.add(1, { title: "Alpha" });
    h.embedder.fail = "ex.com/1";
    await h.indexer.sweep();
    for (const wait of [1, 2]) {
      h.clock.ms += wait * RETRY_BASE_MS;
      await h.indexer.sweep();
    }
    h.store.edit(1, { title: "Beta" });
    await h.indexer.sweep();
    const tries = h.embedder.calls.length;
    h.clock.ms += RETRY_BASE_MS - 1;
    await h.indexer.sweep();
    expect(h.embedder.calls).toHaveLength(tries);
    h.clock.ms += 1;
    await h.indexer.sweep();
    expect(h.embedder.calls).toHaveLength(tries + 1);
  });

  it("doubles the wait after each failure, up to an hour", async () => {
    const h = setup();
    h.store.add(1);
    h.embedder.fail = "ex.com/1";
    const waits: number[] = [];
    await h.indexer.sweep();
    for (let attempt = 1; attempt <= 8; attempt++) {
      // Find the wait by stepping a minute at a time until the link is tried again.
      const tries = h.embedder.calls.length;
      let waited = 0;
      while (h.embedder.calls.length === tries && waited < 2 * RETRY_MAX_MS) {
        h.clock.ms += RETRY_BASE_MS;
        waited += RETRY_BASE_MS;
        await h.indexer.sweep();
      }
      waits.push(waited / RETRY_BASE_MS);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(RETRY_MAX_MS).toBe(60 * RETRY_BASE_MS);
  });

  it("forgets the failure of a link that is gone, so the guard can arm", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.embedder.fail = "ex.com/2";
    await h.indexer.sweep();
    h.store.remove(2);
    await h.indexer.sweep();
    expect(await h.scans(h.indexer.sweep)).toBe(0);
  });

  it("records a rejected vector as that link's failure and indexes the links after it", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.store.writeError = (id) => (id === "1" ? new RangeError("bad vector") : null);
    await h.indexer.sweep();
    expect([...h.store.vectors.keys()]).toEqual(["2"]);
    expect(h.log).toHaveBeenCalledOnce();
    h.clock.ms += 15_000;
    h.embedder.calls.length = 0;
    await h.indexer.sweep();
    expect(h.embedder.calls).toEqual([]);
  });

  it("ends the sweep on any other store error, and the next sweep carries on", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.store.writeError = (id) => (id === "1" ? new Error("database is locked") : null);
    await h.indexer.sweep();
    expect(h.embedded()).toEqual([["1"]]);
    expect(h.log).toHaveBeenCalledOnce();
    h.store.writeError = () => null;
    h.clock.ms += RETRY_BASE_MS;
    await h.indexer.sweep();
    expect([...h.store.vectors.keys()].sort()).toEqual(["1", "2"]);
  });
});

describe("createVectorIndexer: lifecycle", () => {
  it("D-T8: start retires other models' vectors before the first scan", async () => {
    const h = setup();
    h.store.onPage = () => {
      if (h.store.retired.length === 0) throw new Error("scanned before retiring");
    };
    h.store.add(1);
    h.indexer.start();
    await vi.waitFor(() => expect(h.store.vectors.size).toBe(1));
    expect(h.store.retired).toEqual([KEY]);
  });

  it("logs a failed retirement and still sweeps", async () => {
    const h = setup();
    h.store.failRetire = new Error("disk");
    h.store.add(1);
    h.indexer.start();
    await vi.waitFor(() => expect(h.store.vectors.size).toBe(1));
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/retire/), h.store.failRetire);
  });

  it("sweeps at start, then every pollMs, never two at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = setup({ pollMs: 1000 });
    h.store.add(1);
    h.store.changes++;
    h.indexer.start();
    await flush();
    const after = h.store.pageCalls.length;
    expect(after).toBeGreaterThan(0);
    h.store.changes++;
    await vi.advanceTimersByTimeAsync(999);
    await flush();
    expect(h.store.pageCalls.length).toBe(after);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.store.pageCalls.length).toBeGreaterThan(after);
  });

  it("D-T15: a page read that throws is logged, and the next sweep still runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = setup({ pollMs: 1000 });
    h.store.add(1);
    h.store.failPage = new Error("disk");
    h.indexer.start();
    await flush();
    expect(h.log).toHaveBeenCalledWith(expect.any(String), h.store.failPage);
    expect(h.store.vectors.size).toBe(0);
    h.store.failPage = null;
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(h.store.vectors.size).toBe(1);
  });

  it("a change count that throws is logged, and the next sweep still runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = setup({ pollMs: 1000 });
    h.store.add(1);
    h.store.failChangeCount = new Error("disk");
    h.indexer.start();
    await flush();
    expect(h.log).toHaveBeenCalledWith(expect.any(String), h.store.failChangeCount);
    expect(h.store.vectors.size).toBe(0);
    h.store.failChangeCount = null;
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(h.store.vectors.size).toBe(1);
  });

  it("D-T9: stop waits for the embed in flight, writes it, and starts nothing after", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.embedder.hold = "ex.com/1";
    h.indexer.start();
    await vi.waitFor(() => expect(h.embedder.held).not.toBeNull());
    let stopped = false;
    const stopping = h.indexer.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);
    h.embedder.release();
    await stopping;
    expect(h.embedded()).toEqual([["1"]]);
    expect([...h.store.vectors.keys()]).toEqual(["1"]);
  });

  it("D-T9: a sweep that ends after stop arms no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = setup({ pollMs: 1000 });
    h.store.add(1);
    h.embedder.hold = "ex.com/1";
    h.indexer.start();
    await vi.waitFor(() => expect(h.embedder.held).not.toBeNull());
    const stopping = h.indexer.stop();
    h.embedder.release();
    await stopping;
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    h.store.changes++;
    const reads = h.store.pageCalls.length;
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(h.store.pageCalls).toHaveLength(reads);
  });

  it("D-T9: after quiesce nothing new starts, and start does nothing", async () => {
    const h = setup();
    h.store.add(1);
    h.indexer.quiesce();
    h.indexer.start();
    await h.indexer.sweep();
    await h.indexer.stop();
    expect(h.store.pageCalls).toEqual([]);
    expect(h.store.retired).toEqual([]);
    expect(h.embedder.calls).toEqual([]);
  });

  it("stop before start resolves at once", async () => {
    const h = setup();
    await expect(h.indexer.stop()).resolves.toBeUndefined();
  });

  it("D-T14: yields to the event loop between pages, even when every link is current", async () => {
    const h = setup();
    for (let i = 1; i <= 6; i++) h.store.add(i);
    await h.indexer.sweep();
    h.store.changes++;
    let ticked = false;
    const seen: boolean[] = [];
    h.store.onPage = () => seen.push(ticked);
    setImmediate(() => {
      ticked = true;
    });
    await h.indexer.sweep();
    expect(h.embedder.calls).toHaveLength(6);
    // Page 1 is read at once; every later page only after the queued callback has run.
    expect(seen[0]).toBe(false);
    expect(seen.slice(1).every(Boolean)).toBe(true);
    expect(seen.length).toBeGreaterThan(2);
  });
});

describe("createVectorIndexer: a purged link", () => {
  it("survives its link being purged mid-embed, and still handles the next link", async () => {
    const h = setup();
    h.store.add(1);
    h.store.add(2);
    h.embedder.hold = "ex.com/1";
    const first = h.indexer.sweep();
    await vi.waitFor(() => expect(h.embedder.held).not.toBeNull());
    h.store.remove(1);
    h.embedder.hold = null;
    h.embedder.release();
    await expect(first).resolves.toBeUndefined();
    await expect(h.indexer.sweep()).resolves.toBeUndefined();

    expect(h.embedded().filter(([id]) => id === "1")).toHaveLength(1);
    expect(h.store.vectors.has("1")).toBe(false);
    expect(h.store.vectors.get("2")?.hash).toBe(h.hashOf(2));
    expect(h.log).not.toHaveBeenCalled();
  });
});
