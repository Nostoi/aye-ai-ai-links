import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveLink } from "../core/links.js";
import type { SearchTrace } from "../core/search.js";
import { openDatabase } from "../store/database.js";
import { SqliteStore } from "../store/sqlite-store.js";
import type { Embedder } from "./embedder.js";
import { FtsSearch } from "./fts-search.js";
import { HybridSearch } from "./hybrid-search.js";

const KEY = "test-model";
const OWNER = "o";

type Parts = { fields: string[]; pageOnly: string[] };

/** A keyword side that returns fixed lists, capped like the real one. */
function fakeKeyword(parts: Parts) {
  const calls: { limit: number; depth: number }[] = [];
  return {
    calls,
    search: vi.fn(async () => [...parts.fields, ...parts.pageOnly]),
    parts: (_o: string, _q: string, _f: object, limit: number, depth: number) => {
      calls.push({ limit, depth });
      const fields = parts.fields.slice(0, limit);
      return {
        fields,
        pageOnly: fields.length >= limit ? [] : parts.pageOnly.slice(0, depth),
      };
    },
  };
}

/** A meaning side that returns fixed ranked ids, as the real one would for any query vector. */
function fakeVectors(ranked: string[], similarity = 0.5) {
  const asked: number[] = [];
  return {
    asked,
    nearest: (_o: string, _v: Float32Array, _f: object, k: number) => {
      asked.push(k);
      return ranked.slice(0, k).map((id) => ({ id, similarity }));
    },
  };
}

function countingEmbedder() {
  const texts: string[] = [];
  const embedder: Embedder = {
    embedQuery: async (t) => {
      texts.push(t);
      return new Float32Array([1, 0]);
    },
    embedDocuments: async () => [],
  };
  return { texts, embedder };
}

const make = (
  keyword: ReturnType<typeof fakeKeyword>,
  vectors: ReturnType<typeof fakeVectors>,
  embedder: Embedder,
  log: (...a: unknown[]) => void = () => undefined,
) => new HybridSearch(keyword, vectors, embedder, KEY, log);

const run = async (
  h: HybridSearch,
  query: string,
  limit: number,
): Promise<{ ids: string[]; traces: SearchTrace[] }> => {
  const traces: SearchTrace[] = [];
  const ids = await h.search(OWNER, query, {}, limit, (t) => traces.push(t));
  return { ids, traces };
};

describe("HybridSearch", () => {
  it("C1-T1: a query with no word returns [] and never embeds", async () => {
    const { texts, embedder } = countingEmbedder();
    const { ids, traces } = await run(
      make(fakeKeyword({ fields: ["1"], pageOnly: [] }), fakeVectors(["2"]), embedder),
      "?!",
      5,
    );
    expect(ids).toEqual([]);
    expect(texts).toEqual([]);
    expect(traces).toEqual([]);
  });

  it("a blank query goes to the keyword search and never embeds", async () => {
    const { texts, embedder } = countingEmbedder();
    const keyword = fakeKeyword({ fields: ["9"], pageOnly: [] });
    const { ids } = await run(make(keyword, fakeVectors(["2"]), embedder), "  ", 5);
    expect(ids).toEqual(["9"]);
    expect(keyword.search).toHaveBeenCalledOnce();
    expect(texts).toEqual([]);
  });

  it("C1-T2: your words come first, then fused page and meaning hits", async () => {
    const { embedder } = countingEmbedder();
    // X owner-field hit with no vector; Y page rank 1 and meaning rank 1; Z meaning only.
    const keyword = fakeKeyword({ fields: ["X"], pageOnly: ["Y"] });
    const { ids } = await run(make(keyword, fakeVectors(["Y", "Z"]), embedder), "w", 3);
    expect(ids).toEqual(["X", "Y", "Z"]);
  });

  it("C1-T2: an owner-field hit also found by meaning is not fused ahead of others", async () => {
    const { embedder } = countingEmbedder();
    // F is a field hit and meaning rank 1; it must stay first and appear once.
    const keyword = fakeKeyword({ fields: ["F"], pageOnly: [] });
    const { ids } = await run(make(keyword, fakeVectors(["F", "M"]), embedder), "w", 3);
    expect(ids).toEqual(["F", "M"]);
  });

  it("C1-T3: ranks are fused over a deeper candidate list than the limit", async () => {
    const { embedder } = countingEmbedder();
    // limit 2; page ranks [1,2,3]; meaning ranks [4,5,3]. 3 is in both lists and wins.
    const keyword = fakeKeyword({ fields: [], pageOnly: ["1", "2", "3"] });
    const { ids } = await run(make(keyword, fakeVectors(["4", "5", "3"]), embedder), "w", 2);
    expect(ids).toEqual(["3", "4"]);
    expect(keyword.calls).toEqual([{ limit: 2, depth: 6 }]);
  });

  it("C1-T3: depth is 3 times the limit, at most 150", async () => {
    const { embedder } = countingEmbedder();
    const keyword = fakeKeyword({ fields: [], pageOnly: [] });
    const vectors = fakeVectors([]);
    await run(make(keyword, vectors, embedder), "w", 100);
    expect(keyword.calls).toEqual([{ limit: 100, depth: 150 }]);
    expect(vectors.asked).toEqual([150]);
  });

  it("C1-T3: rank sum beats similarity, ties go to the better best rank, then the larger id", async () => {
    const { embedder } = countingEmbedder();
    // Equal-rank-sum ties: A (page 1) vs B (meaning 1) tie at 1/61 each, same best rank 1,
    // so the larger id (B > A numerically 20 > 3) comes first.
    const tie = await run(
      make(fakeKeyword({ fields: [], pageOnly: ["3"] }), fakeVectors(["20"]), embedder),
      "w",
      5,
    );
    expect(tie.ids).toEqual(["20", "3"]);
    // P: page 1 + meaning 3 ; Q: page 2 + meaning 2. Sums: 1/61+1/63 vs 1/62+1/62.
    // 1/61+1/63 = 0.032258...; 2/62 = 0.032258...; P is larger by a hair, and similarity is
    // set so a similarity sum would pick the other order.
    const keyword = fakeKeyword({ fields: [], pageOnly: ["P", "Q"] });
    const vectors = {
      nearest: () => [
        { id: "R", similarity: 0.99 },
        { id: "Q", similarity: 0.99 },
        { id: "P", similarity: 0.1 },
      ],
    };
    const { ids } = await run(make(keyword, vectors as never, embedder), "w", 3);
    expect(ids.slice(0, 2)).toEqual(["P", "Q"]);
  });

  it("C1-T3: equal scores go to the larger id, compared as numbers", async () => {
    const { embedder } = countingEmbedder();
    // 1 (page 1) ties 2 (meaning 1); 5 (page 2) ties 9 (meaning 2). "10" > "9" only as numbers.
    const keyword = fakeKeyword({ fields: [], pageOnly: ["1", "5", "9"] });
    const vectors = fakeVectors(["2", "10"]);
    const { ids } = await run(make(keyword, vectors, embedder), "w", 9);
    expect(ids).toEqual(["2", "1", "10", "5", "9"]);
  });

  it("C1-T4: a link found only by meaning is returned when keywords find nothing", async () => {
    // "automobile" and "car" share an axis; the link vectors are on the "car" axis.
    const axis = (t: string) => new Float32Array(/automobile|car/.test(t) ? [1, 0] : [0, 1]);
    const embedder: Embedder = {
      embedQuery: async (t) => axis(t),
      embedDocuments: async () => [],
    };
    const stored: Record<string, Float32Array> = { "7": axis("car"), "8": axis("boat") };
    const vectors = {
      nearest: (_o: string, v: Float32Array, _f: object, k: number) =>
        Object.entries(stored)
          .map(([id, s]) => ({
            id,
            similarity: (v[0] ?? 0) * (s[0] ?? 0) + (v[1] ?? 0) * (s[1] ?? 0),
          }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, k),
    };
    const { ids, traces } = await run(
      make(fakeKeyword({ fields: [], pageOnly: [] }), vectors as never, embedder),
      "automobile",
      1,
    );
    expect(ids).toEqual(["7"]);
    expect(traces).toEqual([
      {
        mode: "hybrid",
        embedded: "automobile",
        modelKey: KEY,
        similarity: { "7": 1 },
        meaningCandidates: 2,
        ranks: { "7": { meaning: 1 } },
      },
    ]);
  });

  it("C1-T6: no embedding when the owner-field hits fill the limit", async () => {
    const { texts, embedder } = countingEmbedder();
    const vectors = fakeVectors(["Z"]);
    const { ids, traces } = await run(
      make(fakeKeyword({ fields: ["a", "b"], pageOnly: ["c"] }), vectors, embedder),
      "w",
      2,
    );
    expect(ids).toEqual(["a", "b"]);
    expect(texts).toEqual([]);
    expect(vectors.asked).toEqual([]);
    expect(traces).toEqual([
      {
        mode: "keyword",
        embedded: null,
        modelKey: null,
        similarity: {},
        meaningCandidates: 0,
        ranks: { a: { field: 1 }, b: { field: 2 } },
      },
    ]);
  });

  it("C1-T7: the embedded text is at most 500 code points and never splits a surrogate pair", async () => {
    const { texts, embedder } = countingEmbedder();
    const query = `a${"😀".repeat(600)}`;
    await run(make(fakeKeyword({ fields: [], pageOnly: [] }), fakeVectors([]), embedder), query, 5);
    expect(texts).toHaveLength(1);
    expect([...(texts[0] as string)]).toHaveLength(500);
    expect(texts[0]).toBe(`a${"😀".repeat(499)}`);
    expect(texts[0]).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("C1-T5: when the embedder throws, returns the keyword result, logs it, and traces a fallback", async () => {
    const boom = new Error("model gone");
    const embedder: Embedder = {
      embedQuery: async () => {
        throw boom;
      },
      embedDocuments: async () => [],
    };
    const log = vi.fn();
    const keyword = fakeKeyword({ fields: ["F"], pageOnly: ["P1", "P2"] });
    const { ids, traces } = await run(make(keyword, fakeVectors(["M"]), embedder, log), "w", 3);
    expect(ids).toEqual(["F", "P1", "P2"]);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]).toContain(boom);
    expect(traces).toEqual([
      {
        mode: "fallback",
        embedded: "w",
        modelKey: KEY,
        similarity: {},
        meaningCandidates: 0,
        ranks: { F: { field: 1 }, P1: { page: 1 }, P2: { page: 2 } },
      },
    ]);
  });

  it("a trace callback that throws on the hybrid call does not cause a fallback or a second trace", async () => {
    const { embedder } = countingEmbedder();
    const log = vi.fn();
    const modes: string[] = [];
    const search = make(
      fakeKeyword({ fields: ["F"], pageOnly: [] }),
      fakeVectors(["M"]),
      embedder,
      log,
    ).search(OWNER, "w", {}, 3, (t) => {
      modes.push(t.mode);
      throw new Error("trace sink down");
    });
    await expect(search).rejects.toThrow("trace sink down");
    expect(modes).toEqual(["hybrid"]);
    expect(log).not.toHaveBeenCalled();
  });

  it("C1-T5: when nearest throws, falls back with the embedded text recorded", async () => {
    const { embedder } = countingEmbedder();
    const vectors = {
      nearest: () => {
        throw new Error("no such function: vec_distance_cosine");
      },
    };
    const log = vi.fn();
    const { ids, traces } = await run(
      make(fakeKeyword({ fields: [], pageOnly: ["P"] }), vectors as never, embedder, log),
      "hello",
      3,
    );
    expect(ids).toEqual(["P"]);
    expect(log).toHaveBeenCalledOnce();
    expect(traces).toEqual([
      {
        mode: "fallback",
        embedded: "hello",
        modelKey: KEY,
        similarity: {},
        meaningCandidates: 0,
        ranks: { P: { page: 1 } },
      },
    ]);
  });

  it("trace ranks give each returned id its place in every list that found it", async () => {
    const { embedder } = countingEmbedder();
    const vectors = {
      nearest: () => [
        { id: "F", similarity: 0.9 },
        { id: "M", similarity: 0.8 },
        { id: "B", similarity: 0.7 },
      ],
    };
    const { ids, traces } = await run(
      make(fakeKeyword({ fields: ["F"], pageOnly: ["P", "B"] }), vectors as never, embedder),
      "w",
      10,
    );
    expect([...ids].sort()).toEqual(["B", "F", "M", "P"]);
    expect(traces[0]?.ranks).toEqual({
      F: { field: 1 },
      P: { page: 1 },
      M: { meaning: 1 },
      B: { page: 2, meaning: 2 },
    });
  });

  it("trace similarity covers only the meaning candidates returned", async () => {
    const { embedder } = countingEmbedder();
    const vectors = {
      nearest: () => [
        { id: "6", similarity: 0.9 },
        { id: "7", similarity: 0.8 },
        { id: "8", similarity: 0.7 },
      ],
    };
    const { ids, traces } = await run(
      make(fakeKeyword({ fields: [], pageOnly: ["5"] }), vectors as never, embedder),
      "w",
      2,
    );
    expect(ids).toEqual(["6", "5"]);
    expect(traces[0]?.similarity).toEqual({ "6": 0.9 });
    expect(traces[0]?.ranks).toEqual({ "6": { meaning: 1 }, "5": { page: 1 } });
  });
});

describe("HybridSearch over a real database", () => {
  const dbs: Database.Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) if (db.open) db.close();
  });

  it("C1-T5: a failing embedder gives exactly what FtsSearch gives", async () => {
    const db = openDatabase(":memory:");
    dbs.push(db);
    const store = new SqliteStore(db);
    store.ensureUser(OWNER, OWNER);
    const deps = { store, now: () => new Date(5) };
    for (const [i, title] of ["solar panels", "solar notes", "battery"].entries()) {
      await saveLink(deps, OWNER, { url: `https://ex.com/${i}`, title, savedBy: "t" });
    }
    const fts = new FtsSearch(db);
    const failing: Embedder = {
      embedQuery: async () => {
        throw new Error("down");
      },
      embedDocuments: async () => [],
    };
    const log = vi.fn();
    const hybrid = new HybridSearch(fts, fakeVectors([]), failing, KEY, log);
    const expected = await fts.search(OWNER, "solar", {}, 5);
    expect(expected.length).toBe(2);
    expect(await hybrid.search(OWNER, "solar", {}, 5)).toEqual(expected);
    expect(log).toHaveBeenCalledOnce();
  });

  it("C2-T10: meaningCandidates counts every row the vector lookup returned, field hits included", async () => {
    const { embedder } = countingEmbedder();
    const vectors = fakeVectors(["F", "6", "7"]);
    const withVectors = await run(
      make(fakeKeyword({ fields: ["F"], pageOnly: [] }), vectors, embedder),
      "w",
      5,
    );
    expect(withVectors.traces[0]?.meaningCandidates).toBe(3);
    const none = await run(
      make(fakeKeyword({ fields: [], pageOnly: ["P"] }), fakeVectors([]), embedder),
      "w",
      5,
    );
    expect(none.traces[0]).toMatchObject({ mode: "hybrid", meaningCandidates: 0 });
  });
});
