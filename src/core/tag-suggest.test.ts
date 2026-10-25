import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import { mention } from "./tag-edit-store-contract.js";
import {
  dismissTagPair,
  MERGE_SUGGEST_MAX,
  MERGE_SUGGEST_MIN,
  type NameVectors,
  spellingTwins,
  suggestTagMerges,
  undismissTagPair,
} from "./tag-suggest.js";

describe("spellingTwins", () => {
  it.each([
    ["Java Script", "JavaScript"],
    ["pixel art", "pixel-art"],
    ["game asset", "Game Assets"],
    ["Game Assets", "game asset"],
    ["Café", "cafés"],
    ["ai", "AI"],
    ["node.js", "Node JS"],
    ["UI/UX", "ui ux"],
  ])("%s and %s are twins", (a, b) => {
    expect(spellingTwins(a, b)).toBe(true);
  });

  it.each([
    ["game", "gamer"],
    ["game art", "game assets"],
    ["java", "javascript"],
    ["!!", "??"],
    ["", ""],
    ["C#", "C++"],
    ["C#", "C"],
  ])("%s and %s are not twins", (a, b) => {
    expect(spellingTwins(a, b)).toBe(false);
  });
});

const DIMS = 24;

/** A pair of names whose vectors have exactly cosine `score`, and are orthogonal to every other family's. */
const family = (i: number, score: number): [Float32Array, Float32Array] => {
  const a = new Float32Array(DIMS);
  const b = new Float32Array(DIMS);
  a[2 * i] = 1;
  b[2 * i] = score;
  b[2 * i + 1] = Math.sqrt(1 - score * score);
  return [a, b];
};

/** Name vectors from a table. A name without one fails the test, so no tag is embedded unasked. */
const vectorsOf = (table: Record<string, Float32Array>): NameVectors & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    async vectorOf(name) {
      asked.push(name);
      const v = table[name];
      if (!v) throw new Error(`no vector for ${name}`);
      return v;
    },
  };
};

let n = 0;
/** A live link of `owner` carrying these tags. */
const save = async (store: FakeStore, tags: string[], owner = A) =>
  (await store.insertIfAbsent(owner, { ...newLink(++n, at(0)), tags: tags.map((t) => mention(t)) }))
    .link.id;

const suggest = (store: FakeStore, names: NameVectors, owner = A) =>
  suggestTagMerges({ store, tagEdits: store, tagSuggest: store, names }, owner);

/** The suggestions as "a|b" name pairs, in order. */
const pairs = async (store: FakeStore, names: NameVectors, owner = A) =>
  (await suggest(store, names, owner)).map((s) => `${s.a.tag.name}|${s.b.tag.name}`);

describe("suggestTagMerges", () => {
  it("suggests a pair at the threshold and not just under it", async () => {
    expect(MERGE_SUGGEST_MIN).toBe(0.75);
    const store = new FakeStore();
    await save(store, ["in"]);
    await save(store, ["near"]);
    await save(store, ["out"]);
    await save(store, ["near-too"]);
    const [inA, inB] = family(0, 0.75);
    const [outA, outB] = family(1, 0.7499);
    const names = vectorsOf({ in: inA, near: inB, out: outA, "near-too": outB });
    expect(await pairs(store, names)).toEqual(["in|near"]);
  });

  it("does not suggest meaning pairs that share a live link", async () => {
    const store = new FakeStore();
    await save(store, ["poetry", "literature"]);
    const [a, b] = family(0, 0.9);
    expect(await pairs(store, vectorsOf({ poetry: a, literature: b }))).toEqual([]);
  });

  it("suggests meaning pairs whose only shared link is hidden by a delete", async () => {
    const store = new FakeStore();
    const id = await save(store, ["poetry", "literature"]);
    await save(store, ["poetry"]);
    await save(store, ["literature"]);
    await store.markDeleted(A, id, at(1));
    const [a, b] = family(0, 0.9);
    expect(await pairs(store, vectorsOf({ poetry: a, literature: b }))).toEqual([
      "literature|poetry",
    ]);
  });

  it("suggests spelling twins even when they share links, and whatever their meaning scores", async () => {
    const store = new FakeStore();
    await save(store, ["pixel art", "pixel-art"]);
    const [a, b] = family(0, 0);
    const names = vectorsOf({ "pixel art": a, "pixel-art": b });
    expect(await pairs(store, names)).toEqual(["pixel art|pixel-art"]);
  });

  it("leaves out tags on no live link", async () => {
    const store = new FakeStore();
    await save(store, ["game art"]);
    const hidden = await save(store, ["game assets"]);
    await store.markDeleted(A, hidden, at(1));
    const emptied = await save(store, ["Game Art"]);
    await store.update(A, emptied, { tags: [] });
    const [a, b] = family(0, 0.9);
    const names = vectorsOf({ "game art": a, "game assets": b });
    expect(await pairs(store, names)).toEqual([]);
    expect(names.asked).not.toContain("game assets");
  });

  it("leaves out a pair dismissed in either key order", async () => {
    const store = new FakeStore();
    await save(store, ["x1"]);
    await save(store, ["y1"]);
    await save(store, ["x2"]);
    await save(store, ["y2"]);
    const [x1, y1] = family(0, 0.9);
    const [x2, y2] = family(1, 0.9);
    const names = vectorsOf({ x1, y1, x2, y2 });
    expect(await pairs(store, names)).toEqual(["x1|y1", "x2|y2"]);
    await store.dismissPair(A, "y1", "x1", at(1));
    await store.dismissPair(A, "x2", "y2", at(1));
    expect(await pairs(store, names)).toEqual([]);
    await store.undismissPair(A, "x1", "y1");
    expect(await pairs(store, names)).toEqual(["x1|y1"]);
  });

  it("names the tag with more links first, ties by name, and carries both counts", async () => {
    const store = new FakeStore();
    await save(store, ["few"]);
    await save(store, ["many"]);
    await save(store, ["many"]);
    await save(store, ["bee"]);
    await save(store, ["ant"]);
    const [few, many] = family(0, 0.9);
    const [bee, ant] = family(1, 0.9);
    const found = await suggest(store, vectorsOf({ few, many, bee, ant }));
    expect(found.map((s) => [s.a.tag.name, s.a.links, s.b.tag.name, s.b.links])).toEqual([
      ["ant", 1, "bee", 1],
      ["many", 2, "few", 1],
    ]);
  });

  it("orders twins first, then by similarity high to low, ties by the two names, and stops at the cap", async () => {
    expect(MERGE_SUGGEST_MAX).toBe(5);
    const store = new FakeStore();
    const table: Record<string, Float32Array> = {};
    const scores = [0.8, 0.95, 0.85, 0.85, 0.9, 0.78];
    for (const [i, score] of scores.entries()) {
      await save(store, [`p${i}a`]);
      await save(store, [`p${i}b`]);
      [table[`p${i}a`], table[`p${i}b`]] = family(i, score) as [Float32Array, Float32Array];
    }
    await save(store, ["Twin Tag", "twin-tags"]);
    [table["Twin Tag"], table["twin-tags"]] = family(6, 0);
    expect(await pairs(store, vectorsOf(table))).toEqual([
      "Twin Tag|twin-tags",
      "p1a|p1b",
      "p4a|p4b",
      "p2a|p2b",
      "p3a|p3b",
    ]);
  });

  it("never pairs one owner's tags with another's, or shows another owner's suggestions", async () => {
    const store = new FakeStore();
    await save(store, ["a-tag"]);
    await save(store, ["b-tag"], B);
    const [x, y] = family(0, 0.9);
    const names = vectorsOf({ "a-tag": x, "b-tag": y });
    expect(await pairs(store, names, A)).toEqual([]);
    expect(await pairs(store, names, B)).toEqual([]);
    expect(names.asked).toEqual(["a-tag", "b-tag"]);
  });
});

describe("dismissTagPair and undismissTagPair", () => {
  it("record and remove the pair under the tags' keys, either order, for that owner only", async () => {
    const store = new FakeStore();
    const when = new Date(5);
    await dismissTagPair({ tagSuggest: store, now: () => when }, A, "Game  Art", "game assets");
    expect(await store.dismissedPairs(A)).toEqual([["game art", "game assets"]]);
    expect(await store.dismissedPairs(B)).toEqual([]);
    await undismissTagPair({ tagSuggest: store }, A, "Game Assets", "GAME ART");
    expect(await store.dismissedPairs(A)).toEqual([]);
  });
});
