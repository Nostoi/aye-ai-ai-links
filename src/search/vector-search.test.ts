import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { saveLink } from "../core/links.js";
import type { SearchFilters } from "../core/search.js";
import { openDatabase } from "../store/database.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { loadVectorFunctions, VectorSearch } from "./vector-search.js";

const MODEL = "m";
const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

/** Nearer to the query [1, 0, 0, 0] the smaller `away` is; 0 is the query itself. */
const vec = (away: number, dims = 4) => {
  const v = new Float32Array(dims);
  v[0] = 1;
  v[1] = away;
  return v;
};
const QUERY = vec(0);

function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  loadVectorFunctions(db);
  const store = new SqliteStore(db);
  for (const o of ["a", "b"]) store.ensureUser(o, o);
  let clock = 1_000;
  let n = 0;
  const deps = { store, now: () => new Date(clock) };
  const save = async (
    owner: string,
    f: { away?: number; tags?: { name: string; kind?: "topic" | "project" }[]; at?: number } = {},
  ) => {
    clock = f.at ?? clock + 1;
    const { link } = await saveLink(deps, owner, {
      url: `https://ex.com/${n++}`,
      title: null,
      summary: null,
      why: null,
      tags: (f.tags ?? []).map((t) => ({ ...t, source: "stated" as const })),
      savedBy: "t",
    });
    if (f.away !== undefined) putVector(owner, link.id, vec(f.away));
    return link.id;
  };
  const putVector = (owner: string, linkId: string, v: Float32Array, model = MODEL) =>
    db
      .prepare("INSERT INTO link_vectors VALUES (?, ?, ?, ?, 'h', ?, 0)")
      .run(owner, Number(linkId), model, v.length, Buffer.from(v.buffer));
  const nearest = (filters: SearchFilters = {}, k = 10, owner = "a", q = QUERY) =>
    new VectorSearch(db, MODEL).nearest(owner, q, filters, k);
  const ids = (filters: SearchFilters = {}, k = 10, owner = "a") =>
    nearest(filters, k, owner).map((r) => r.id);
  return { db, save, putVector, nearest, ids };
}

describe("VectorSearch filters apply before the cut", () => {
  it("tagKey: the 2 tagged links come back though 3 untagged ones are nearer", async () => {
    const s = setup();
    const tag = [{ name: "Wombat" }];
    await s.save("a", { away: 0.1 });
    await s.save("a", { away: 0.2 });
    await s.save("a", { away: 0.3 });
    const far1 = await s.save("a", { away: 5, tags: tag });
    const far2 = await s.save("a", { away: 6, tags: tag });
    expect(s.ids({ tagKey: "wombat" }, 2)).toEqual([far1, far2]);
  });

  it("projectKey: only project-kind tags match, and past the cut", async () => {
    const s = setup();
    await s.save("a", { away: 0.1, tags: [{ name: "Beta Topic" }] });
    await s.save("a", { away: 0.2 });
    await s.save("a", { away: 0.3 });
    const far1 = await s.save("a", { away: 5, tags: [{ name: "Beta", kind: "project" }] });
    const far2 = await s.save("a", { away: 6, tags: [{ name: "Beta", kind: "project" }] });
    expect(s.ids({ projectKey: "beta" }, 2)).toEqual([far1, far2]);
  });

  it("projectKey: a topic tag with the same key does not match", async () => {
    const s = setup();
    await s.save("a", { away: 0.1, tags: [{ name: "Beta" }] });
    expect(s.ids({ projectKey: "beta" })).toEqual([]);
    expect(s.ids({ tagKey: "beta" })).toHaveLength(1);
  });

  it("date bounds: in-range links come back past the cut, and both bounds are inclusive", async () => {
    const s = setup();
    await s.save("a", { away: 0.1, at: 100 });
    await s.save("a", { away: 0.2, at: 100 });
    await s.save("a", { away: 0.3, at: 100 });
    const lo = await s.save("a", { away: 5, at: 2_000 });
    const hi = await s.save("a", { away: 6, at: 3_000 });
    await s.save("a", { away: 0.05, at: 3_001 });
    const range = { savedFrom: new Date(2_000), savedTo: new Date(3_000) };
    expect(s.ids(range, 2)).toEqual([lo, hi]);
    expect(s.ids({ savedFrom: new Date(3_000), savedTo: new Date(3_000) }, 2)).toEqual([hi]);
  });
});

describe("VectorSearch isolation", () => {
  it("never returns another owner's vectors, even for the identical vector", async () => {
    const s = setup();
    const mine = await s.save("a", { away: 3 });
    await s.save("b", { away: 0 });
    expect(s.ids({}, 10, "a")).toEqual([mine]);
  });

  it("ignores vectors of a different model_key", async () => {
    const s = setup();
    const id = await s.save("a", { away: 1 });
    const other = await s.save("a");
    s.putVector("a", other, vec(0), "other-model");
    expect(s.ids()).toEqual([id]);
  });

  it("skips a row whose dims differ from the query's, without throwing", async () => {
    const s = setup();
    const good = await s.save("a", { away: 1 });
    const odd = await s.save("a");
    s.putVector("a", odd, vec(0, 3));
    expect(s.ids()).toEqual([good]);
  });

  it("leaves out links that have no vector", async () => {
    const s = setup();
    const withVec = await s.save("a", { away: 1 });
    await s.save("a");
    expect(s.ids()).toEqual([withVec]);
  });
});

describe("VectorSearch ordering", () => {
  it("scores an identical vector at about 1 and a farther one lower", async () => {
    const s = setup();
    const same = await s.save("a", { away: 0 });
    const off = await s.save("a", { away: 1 });
    const [first, second] = s.nearest();
    expect(first?.id).toBe(same);
    expect(first?.similarity).toBeCloseTo(1, 5);
    expect(second?.id).toBe(off);
    expect(second?.similarity).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it("orders by similarity, nearest first, regardless of save order", async () => {
    const s = setup();
    const mid = await s.save("a", { away: 2 });
    const far = await s.save("a", { away: 9 });
    const near = await s.save("a", { away: 0.5 });
    const sims = s.nearest().map((r) => r.similarity);
    expect(s.ids()).toEqual([near, mid, far]);
    expect(sims).toEqual([...sims].sort((x, y) => y - x));
  });

  it("falls back to newest first when distances are equal", async () => {
    const s = setup();
    const newest = await s.save("a", { away: 1, at: 300 });
    const older = await s.save("a", { away: 1, at: 100 });
    const same = await s.save("a", { away: 1, at: 100 });
    expect(s.ids()).toEqual([newest, same, older]);
  });

  it("returns at most k", async () => {
    const s = setup();
    for (const away of [1, 2, 3]) await s.save("a", { away });
    expect(s.ids({}, 2)).toHaveLength(2);
  });
});

describe("VectorSearch inputs", () => {
  it("leaves out stored zero and NaN vectors, which have no direction", async () => {
    const s = setup();
    const good = await s.save("a", { away: 0.5 });
    s.putVector("a", await s.save("a"), new Float32Array(4));
    s.putVector("a", await s.save("a"), new Float32Array([1, Number.NaN, 0, 0]));
    expect(s.ids()).toEqual([good]);
  });

  it("leaves out a stored vector too small to score", async () => {
    const s = setup();
    const good = await s.save("a", { away: 0.5 });
    s.putVector("a", await s.save("a"), new Float32Array([1e-30, 0, 0, 0]));
    expect(s.ids()).toEqual([good]);
  });

  it("returns nothing for a zero query vector", async () => {
    const s = setup();
    await s.save("a", { away: 0 });
    expect(s.nearest({}, 10, "a", new Float32Array(4))).toEqual([]);
  });

  it.each([-1, 0, 1.5, Number.NaN])("returns nothing for k = %s", async (k) => {
    const s = setup();
    await s.save("a", { away: 0 });
    expect(s.nearest({}, k)).toEqual([]);
  });

  it("reads a query that is a view into a larger buffer", async () => {
    const s = setup();
    const id = await s.save("a", { away: 0 });
    await s.save("a", { away: 9 });
    const big = new Float32Array([0, 1, 1, 0, 0, 0, 0, 1]);
    const [first] = s.nearest({}, 10, "a", big.subarray(2, 6));
    expect(first?.id).toBe(id);
    expect(first?.similarity).toBeCloseTo(1, 5);
  });
});
