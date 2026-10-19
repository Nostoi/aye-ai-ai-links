import { afterEach, describe, expect, it } from "vitest";
import { FtsSearch } from "../search/fts-search.js";
import { openDatabase } from "../store/database.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { CoreError } from "./errors.js";
import { FakeSearch } from "./fake-search.js";
import { FakeStore } from "./fake-store.js";
import { checkedOrder, linkPage } from "./link-pages.js";
import { saveLink } from "./links.js";
import { listLinks } from "./list-links.js";
import { LINK_ORDERS, type LinkCount, type LinkOrder, type LinkSearch } from "./search.js";
import type { LinkRemover, LinkStore } from "./store.js";
import type { TagKind } from "./types.js";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

type World = { store: LinkStore & LinkRemover; search: LinkSearch; count: LinkCount };

const ENGINES: [string, () => World][] = [
  [
    "the fakes",
    () => {
      const store = new FakeStore();
      const search = new FakeSearch(store);
      return { store, search, count: search };
    },
  ],
  [
    "SQLite and FtsSearch",
    () => {
      const db = openDatabase(":memory:");
      closers.push(() => db.close());
      const store = new SqliteStore(db);
      for (const o of ["a", "b"]) store.ensureUser(o, o);
      const search = new FtsSearch(db);
      return { store, search, count: search };
    },
  ],
];

const refusal = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);

const expectInvalid = async (promise: Promise<unknown>, label: string) => {
  const error = await refusal(promise);
  expect(error, label).toBeInstanceOf(CoreError);
  expect((error as CoreError).code, label).toBe("invalid_input");
};

let n = 0;
const setup = (make: () => World) => {
  const world = make();
  const save = async (
    owner: string,
    at: number,
    tags: string[] = [],
    kind: TagKind | undefined = undefined,
  ) => {
    const { link } = await saveLink({ store: world.store, now: () => new Date(at) }, owner, {
      url: `https://ex.com/${n++}`,
      savedBy: "t",
      tags: tags.map((name) => ({ name, source: "stated" as const, ...(kind ? { kind } : {}) })),
    });
    return link.id;
  };
  const open = (owner: string, id: string, at: number) =>
    world.store.update(owner, id, { lastOpenedAt: new Date(at) });
  return { ...world, save, open };
};

describe.each(ENGINES)("linkPage on %s", (_, make) => {
  it("pages 25 links saved at the same instant 24 at a time, reaching each exactly once", async () => {
    const w = setup(make);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await w.save("a", 5_000, ["kitchen"]));
    const first = await linkPage(w, "a", { tagKey: "kitchen", limit: 24 });
    expect(first.links).toHaveLength(24);
    expect(first.older).toEqual(expect.any(String));
    const second = await linkPage(w, "a", {
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
    const w = setup(make);
    for (let i = 0; i < 3; i++) await w.save("a", 1_000 + i, ["kitchen"]);
    expect((await linkPage(w, "a", { tagKey: "kitchen", limit: 3 })).older).toBeNull();
    expect((await linkPage(w, "a", { tagKey: "kitchen", limit: 2 })).older).not.toBeNull();
    expect(await linkPage(w, "a", { tagKey: "garden", limit: 3 })).toEqual({
      links: [],
      older: null,
    });
  });

  it("lists newest first, and leaves out another owner's links under the same tag key", async () => {
    const w = setup(make);
    const old = await w.save("a", 1_000, ["kitchen"]);
    await w.save("b", 2_000, ["Kitchen"]);
    await w.save("a", 2_500, ["garden"]);
    const recent = await linkPage(w, "a", { tagKey: "kitchen", limit: 10 });
    const fresh = await w.save("a", 3_000, ["kitchen"]);
    expect(recent.links.map((l) => l.id)).toEqual([old]);
    const page = await linkPage(w, "a", { tagKey: "kitchen", limit: 10 });
    expect(page.links.map((l) => l.id)).toEqual([fresh, old]);
  });

  it("filters by state: a done link is in the archived list only", async () => {
    const w = setup(make);
    const active = await w.save("a", 1_000, ["kitchen"]);
    const done = await w.save("a", 2_000, ["kitchen"]);
    await w.store.update("a", done, { state: "archived" });
    const ids = async (state: "active" | "archived") =>
      (await linkPage(w, "a", { tagKey: "kitchen", state, limit: 10 })).links.map((l) => l.id);
    expect(await ids("active")).toEqual([active]);
    expect(await ids("archived")).toEqual([done]);
  });

  it("refuses a malformed cursor, or one that does not fit the link it names", async () => {
    const w = setup(make);
    const mine = await w.save("a", 1_000, ["kitchen"]);
    await w.save("a", 1_001, ["kitchen"]);
    const good = (await linkPage(w, "a", { tagKey: "kitchen", limit: 1 })).older as string;
    expect(good).not.toBeNull();
    const bad = ["", "garbage", "1000", "abc.1", "1000.", "-5.x", `1001.${mine}`];
    for (const before of bad) {
      await expectInvalid(linkPage(w, "a", { tagKey: "kitchen", limit: 1, before }), before);
    }
  });

  it("answers not_found, with the restart message, for a well-formed cursor naming no live link of this owner", async () => {
    const w = setup(make);
    await w.save("a", 1_000, ["kitchen"]);
    const gone = await w.save("a", 1_001, ["kitchen"]);
    const theirs = await w.save("b", 1_000, ["kitchen"]);
    const deleted = (await linkPage(w, "a", { tagKey: "kitchen", limit: 1 })).older as string;
    expect(deleted).toBe(`1001.${gone}`);
    expect(await w.store.markDeleted("a", gone, new Date(5_000))).toBe(true);
    for (const before of [`1000.${theirs}`, "1000.999999", `${deleted}x`, deleted]) {
      const error = await refusal(linkPage(w, "a", { tagKey: "kitchen", limit: 1, before }));
      expect(error, before).toBeInstanceOf(CoreError);
      expect((error as CoreError).code, before).toBe("not_found");
      expect((error as CoreError).message, before).toBe(
        "That page of older links is not valid. Start again from the newest links.",
      );
    }
  });

  /**
   * A's 51 links: 30 saved at one instant and 21 at times of their own, 40 of them opened (20 at
   * one instant). B's 3 links are saved and opened at the same times as some of A's.
   */
  const library = async (w: ReturnType<typeof setup>) => {
    const saved: { id: string; savedAt: number; openedAt: number | null }[] = [];
    for (let i = 0; i < 51; i++) {
      const savedAt = i < 30 ? 5_000 : 1_000 + i;
      const id = await w.save("a", savedAt);
      const openedAt = i >= 40 ? null : i % 2 === 0 ? 9_000 : 6_000 + i;
      if (openedAt !== null) await w.open("a", id, openedAt);
      saved.push({ id, savedAt, openedAt });
    }
    for (let i = 0; i < 3; i++) await w.open("b", await w.save("b", 5_000), 9_000);
    return saved;
  };

  /** The ids of `saved` in `order`'s sequence, ties broken by the order they were saved in. */
  const sequence = (saved: Awaited<ReturnType<typeof library>>, order: LinkOrder) => {
    const placed = saved.map((s, place) => ({ ...s, place }));
    const listed = order === "opened" ? placed.filter((s) => s.openedAt !== null) : placed;
    const key = (s: (typeof placed)[number]) =>
      order === "opened" ? (s.openedAt as number) : s.savedAt;
    const sign = order === "oldest" ? 1 : -1;
    return listed.sort((x, y) => sign * (key(x) - key(y) || x.place - y.place)).map((s) => s.id);
  };

  it.each(LINK_ORDERS)(
    "pages 51 links in %s order 20 at a time, reaching each once in the order's sequence",
    async (order) => {
      const w = setup(make);
      const saved = await library(w);
      const seen: string[] = [];
      let before: string | undefined;
      let pages = 0;
      do {
        const page = await linkPage(w, "a", { order, limit: 20, ...(before ? { before } : {}) });
        seen.push(...page.links.map((l) => l.id));
        before = page.older ?? undefined;
        pages += 1;
      } while (before !== undefined && pages < 10);
      const expected = sequence(saved, order);
      expect(expected).toHaveLength(order === "opened" ? 40 : 51);
      expect(seen).toEqual(expected);
      expect(pages).toBe(order === "opened" ? 2 : 3);
    },
  );

  it("refuses a cursor made for another order", async () => {
    const w = setup(make);
    for (let i = 0; i < 3; i++) await w.open("a", await w.save("a", 1_000 + i), 2_000 + i);
    const cursors = Object.fromEntries(
      await Promise.all(
        LINK_ORDERS.map(async (order) => [
          order,
          (await linkPage(w, "a", { order, limit: 1 })).older as string,
        ]),
      ),
    ) as Record<LinkOrder, string>;
    for (const made of LINK_ORDERS) {
      for (const order of LINK_ORDERS) {
        const page = linkPage(w, "a", { order, limit: 1, before: cursors[made] });
        if (made === order) await expect(page).resolves.toMatchObject({ links: [{}] });
        else await expectInvalid(page, `${made} cursor sent with ${order}`);
      }
    }
  });

  it("refuses an oldest cursor whose time is not the link's save time", async () => {
    const w = setup(make);
    const first = await w.save("a", 1_000);
    await w.save("a", 2_000);
    const good = (await linkPage(w, "a", { order: "oldest", limit: 1 })).older as string;
    expect(good).toBe(`o1000.${first}`);
    for (const before of [`o1001.${first}`, `o999.${first}`, `1000.${first}`]) {
      await expectInvalid(linkPage(w, "a", { order: "oldest", limit: 1, before }), before);
    }
  });

  it("refuses an opened cursor from the future, or one naming a link never opened", async () => {
    const w = setup(make);
    const opened = await w.save("a", 1_000);
    await w.open("a", opened, 5_000);
    const never = await w.save("a", 2_000);
    for (const before of [`r5001.${opened}`, `r1000.${never}`, `5000.${opened}`]) {
      await expectInvalid(linkPage(w, "a", { order: "opened", limit: 1, before }), before);
    }
  });

  it("keeps an opened walk going when the cursor's link is opened again meanwhile", async () => {
    const w = setup(make);
    const ids: string[] = [];
    // Saved in the reverse of the order they were opened in.
    for (let i = 1; i <= 5; i++) {
      const id = await w.save("a", 10 - i);
      await w.open("a", id, i * 1_000);
      ids.push(id);
    }
    const first = await linkPage(w, "a", { order: "opened", limit: 2 });
    expect(first.links.map((l) => l.id)).toEqual([ids[4], ids[3]]);
    await w.open("a", ids[3] as string, 9_000);
    const second = await linkPage(w, "a", {
      order: "opened",
      limit: 2,
      before: first.older as string,
    });
    expect(second.links.map((l) => l.id)).toEqual([ids[2], ids[1]]);
  });

  it("misses a link first opened during an opened walk, as list_links says, while the total counts it", async () => {
    const w = setup(make);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const id = await w.save("a", i);
      await w.open("a", id, i * 1_000);
      ids.push(id);
    }
    const late = await w.save("a", 6);
    const seen: string[] = [];
    let cursor: string | undefined;
    let total = 0;
    for (let page = 0; page < 3; page++) {
      const got = await listLinks(w, "a", {
        order: "opened",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...got.links.map((l) => l.id));
      total = got.total;
      cursor = got.older ?? undefined;
      if (page === 0) await w.open("a", late, 9_000);
    }
    expect(cursor).toBeUndefined();
    expect(seen).toEqual([...ids].reverse());
    expect(seen).not.toContain(late);
    expect(total).toBe(6);
  });
});

describe.each(ENGINES)("listLinks on %s", (_, make) => {
  it("counts only the owner's links, and gives the same total on every page", async () => {
    const w = setup(make);
    for (let i = 0; i < 51; i++) await w.save("a", i < 30 ? 5_000 : 1_000 + i);
    for (let i = 0; i < 3; i++) await w.save("b", 5_000);
    const seen: string[] = [];
    const totals: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await listLinks(w, "a", { limit: 20, ...(cursor ? { cursor } : {}) });
      seen.push(...page.links.map((l) => l.id));
      totals.push(page.total);
      cursor = page.older ?? undefined;
    } while (cursor !== undefined && totals.length < 10);
    expect(totals).toEqual([51, 51, 51]);
    expect(new Set(seen).size).toBe(51);
    expect((await listLinks(w, "b", {})).total).toBe(3);
  });

  it("narrows the total by each filter exactly", async () => {
    const w = setup(make);
    await w.save("a", 1_000, ["Kitchen"]);
    await w.save("a", 2_000, ["Kitchen"]);
    await w.save("a", 3_000, ["Solar"], "project");
    const done = await w.save("a", 4_000);
    await w.store.update("a", done, { state: "archived" });
    await w.save("b", 2_000, ["Kitchen"]);
    const total = async (input: Parameters<typeof listLinks>[2]) =>
      (await listLinks(w, "a", input)).total;
    expect(await total({})).toBe(4);
    expect(await total({ tag: " KITCHEN " })).toBe(2);
    expect(await total({ tag: "solar" })).toBe(1);
    expect(await total({ project: "Solar" })).toBe(1);
    // A topic is no project, whatever its name.
    expect(await total({ project: "kitchen" })).toBe(0);
    expect(await total({ savedFrom: new Date(2_000), savedTo: new Date(3_000) })).toBe(2);
    expect(await total({ savedFrom: new Date(3_001) })).toBe(1);
    expect(await total({ state: "archived" })).toBe(1);
    expect(await total({ state: "active", tag: "kitchen", savedTo: new Date(1_000) })).toBe(1);
    expect(await total({ order: "oldest", tag: "kitchen" })).toBe(2);
  });

  it("counts only links with a recorded opening in opened order, and lists only them", async () => {
    const w = setup(make);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await w.save("a", 1_000 + i));
    await w.open("a", ids[1] as string, 7_000);
    await w.open("a", ids[3] as string, 8_000);
    await w.open("a", ids[4] as string, 7_000);
    await w.open("b", await w.save("b", 1_000), 7_000);
    const opened = await listLinks(w, "a", { order: "opened" });
    expect(opened.total).toBe(3);
    // Ties on the opening time go later save first, as in newest order.
    expect(opened.links.map((l) => l.id)).toEqual([ids[3], ids[4], ids[1]]);
    expect((await listLinks(w, "a", { order: "newest" })).total).toBe(5);
    expect((await listLinks(w, "a", { order: "opened", state: "archived" })).total).toBe(0);
  });

  it("clamps the limit to 1..50, 20 by default", async () => {
    const w = setup(make);
    for (let i = 0; i < 51; i++) await w.save("a", 1_000 + i);
    expect((await listLinks(w, "a", {})).links).toHaveLength(20);
    expect((await listLinks(w, "a", { limit: 500 })).links).toHaveLength(50);
    expect((await listLinks(w, "a", { limit: 0 })).links).toHaveLength(1);
  });

  it("refuses a fractional limit, savedFrom after savedTo, an invalid date and another owner's cursor", async () => {
    const w = setup(make);
    await w.save("a", 1_000);
    await w.save("b", 1_000);
    await w.save("b", 2_000);
    const theirs = (await listLinks(w, "b", { limit: 1 })).older as string;
    expect(theirs).not.toBeNull();
    await expectInvalid(listLinks(w, "a", { limit: 1.5 }), "fractional limit");
    await expectInvalid(
      listLinks(w, "a", { savedFrom: new Date(2_000), savedTo: new Date(1_000) }),
      "savedFrom after savedTo",
    );
    await expectInvalid(listLinks(w, "a", { savedFrom: new Date(Number.NaN) }), "invalid date");
    const error = await refusal(listLinks(w, "a", { cursor: theirs }));
    expect((error as CoreError).code, "B's cursor sent by A").toBe("not_found");
  });
});

describe("checkedOrder", () => {
  it("takes each order, newest when left out, and refuses anything else", () => {
    for (const order of LINK_ORDERS) expect(checkedOrder(order)).toBe(order);
    expect(checkedOrder(undefined)).toBe("newest");
    for (const bad of ["", "Newest", "random", "opened "]) {
      expect(() => checkedOrder(bad), bad).toThrow(CoreError);
    }
  });
});
