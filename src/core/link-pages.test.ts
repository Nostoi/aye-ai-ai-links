import { afterEach, describe, expect, it } from "vitest";
import { FtsSearch } from "../search/fts-search.js";
import { openDatabase } from "../store/database.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { CoreError } from "./errors.js";
import { FakeSearch } from "./fake-search.js";
import { FakeStore } from "./fake-store.js";
import { newestLinks } from "./link-pages.js";
import { saveLink } from "./links.js";
import type { LinkSearch } from "./search.js";
import type { LinkStore } from "./store.js";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

type World = { store: LinkStore; search: LinkSearch };

const ENGINES: [string, () => World][] = [
  [
    "the fakes",
    () => {
      const store = new FakeStore();
      return { store, search: new FakeSearch(store) };
    },
  ],
  [
    "SQLite and FtsSearch",
    () => {
      const db = openDatabase(":memory:");
      closers.push(() => db.close());
      const store = new SqliteStore(db);
      for (const o of ["a", "b"]) store.ensureUser(o, o);
      return { store, search: new FtsSearch(db) };
    },
  ],
];

describe.each(ENGINES)("newestLinks on %s", (_, make) => {
  let n = 0;
  const setup = () => {
    const world = make();
    const save = async (owner: string, at: number, tags: string[] = []) => {
      const { link } = await saveLink({ store: world.store, now: () => new Date(at) }, owner, {
        url: `https://ex.com/${n++}`,
        savedBy: "t",
        tags: tags.map((name) => ({ name, source: "stated" as const })),
      });
      return link.id;
    };
    return { ...world, save };
  };

  it("pages 25 links saved at the same instant 24 at a time, reaching each exactly once", async () => {
    const w = setup();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await w.save("a", 5_000, ["kitchen"]));
    const first = await newestLinks(w, "a", { tagKey: "kitchen", limit: 24 });
    expect(first.links).toHaveLength(24);
    expect(first.older).toEqual(expect.any(String));
    const second = await newestLinks(w, "a", {
      tagKey: "kitchen",
      limit: 24,
      before: first.older as string,
    });
    expect(second.older).toBeNull();
    const seen = [...first.links, ...second.links].map((l) => l.id);
    expect(seen).toHaveLength(25);
    expect([...seen].sort()).toEqual([...ids].sort());
    // Newest first: the last saved link leads.
    expect(seen[0]).toBe(ids[24]);
  });

  it("gives no cursor when exactly a page of links exists, and none for an empty space", async () => {
    const w = setup();
    for (let i = 0; i < 3; i++) await w.save("a", 1_000 + i, ["kitchen"]);
    expect((await newestLinks(w, "a", { tagKey: "kitchen", limit: 3 })).older).toBeNull();
    expect((await newestLinks(w, "a", { tagKey: "kitchen", limit: 2 })).older).not.toBeNull();
    expect(await newestLinks(w, "a", { tagKey: "garden", limit: 3 })).toEqual({
      links: [],
      older: null,
    });
  });

  it("lists newest first, and leaves out another owner's links under the same tag key", async () => {
    const w = setup();
    const old = await w.save("a", 1_000, ["kitchen"]);
    await w.save("b", 2_000, ["Kitchen"]);
    await w.save("a", 2_500, ["garden"]);
    const recent = await newestLinks(w, "a", { tagKey: "kitchen", limit: 10 });
    const fresh = await w.save("a", 3_000, ["kitchen"]);
    expect(recent.links.map((l) => l.id)).toEqual([old]);
    const page = await newestLinks(w, "a", { tagKey: "kitchen", limit: 10 });
    expect(page.links.map((l) => l.id)).toEqual([fresh, old]);
  });

  it("filters by state: a done link is in the archived list only", async () => {
    const w = setup();
    const active = await w.save("a", 1_000, ["kitchen"]);
    const done = await w.save("a", 2_000, ["kitchen"]);
    await w.store.update("a", done, { state: "archived" });
    const ids = async (state: "active" | "archived") =>
      (await newestLinks(w, "a", { tagKey: "kitchen", state, limit: 10 })).links.map((l) => l.id);
    expect(await ids("active")).toEqual([active]);
    expect(await ids("archived")).toEqual([done]);
  });

  it("refuses a malformed cursor, or one that names no link of this owner at that time", async () => {
    const w = setup();
    const mine = await w.save("a", 1_000, ["kitchen"]);
    await w.save("a", 1_001, ["kitchen"]);
    const theirs = await w.save("b", 1_000, ["kitchen"]);
    const good = (await newestLinks(w, "a", { tagKey: "kitchen", limit: 1 })).older as string;
    expect(good).not.toBeNull();
    const bad = [
      "",
      "garbage",
      "1000",
      "abc.1",
      "1000.",
      "-5.x",
      `1000.${theirs}`,
      `1001.${mine}`,
      "1000.999999",
      `${good}x`,
    ];
    for (const before of bad) {
      const refusal = await newestLinks(w, "a", { tagKey: "kitchen", limit: 1, before }).catch(
        (e: unknown) => e,
      );
      expect(refusal, before).toBeInstanceOf(CoreError);
      expect((refusal as CoreError).code, before).toBe("invalid_input");
    }
  });
});
