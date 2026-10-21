import { beforeEach, describe, expect, it } from "vitest";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import type { LinkSearch } from "./search.js";
import {
  keepInTidy,
  TIDY_KEEP_WAIT_MS,
  TIDY_SESSION,
  type TidyDeps,
  tidyQueue,
  tidyReady,
} from "./tidy-up.js";
import { keepHandy } from "./tools.js";
import type { Link, NewLink } from "./types.js";

const A = "a";
const B = "b";
const DAY = 86_400_000;
const NOW = new Date("2026-10-21T09:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let store: FakeStore;
let profile: FakeProfileStore;
let hits: Map<string, string[]>;
let searches: string[];
const keywordSearch: LinkSearch = {
  search: async (_owner, query) => {
    searches.push(query);
    return hits.get(query) ?? [];
  },
};
const deps = (): TidyDeps => ({
  store,
  tools: store,
  checks: store,
  profile,
  keywordSearch,
  now: () => NOW,
});

beforeEach(() => {
  store = new FakeStore();
  profile = new FakeProfileStore();
  hits = new Map();
  searches = [];
});

let n = 0;
/** A link that qualifies unless `over` says otherwise: saved 60 days ago, never opened. */
async function link(over: Partial<NewLink> = {}, owner = A): Promise<Link> {
  n += 1;
  const url = `https://ex.com/${n}`;
  return (
    await store.insertIfAbsent(owner, {
      url,
      urlKey: url,
      title: `Link ${n}`,
      summary: null,
      why: null,
      tags: [],
      savedAt: ago(60 * DAY),
      savedBy: "t",
      lastOpenedAt: null,
      putAwayAt: null,
      tidyKeptAt: null,
      lastSurfacedAt: null,
      snoozedUntil: null,
      state: "active",
      ...over,
    })
  ).link;
}

async function focus(text: string, created: Date, found: string[]): Promise<void> {
  await profile.apply(
    A,
    { addNotes: [], editNotes: [], removeNotes: [], addFocus: [{ text, source: "stated" }] },
    { writtenBy: "agent", at: created, focusLimit: 100, purgeBefore: new Date(0) },
  );
  hits.set(text, found);
}

const queueIds = async (limit = 100) => (await tidyQueue(deps(), A, limit)).map((t) => t.link.id);

describe("which links qualify", () => {
  it("takes an old active link", async () => {
    const l = await link();
    expect(await queueIds()).toEqual([l.id]);
  });

  it("counts exactly 30 days as old, for saving and for opening", async () => {
    const l = await link({ savedAt: ago(30 * DAY), lastOpenedAt: ago(30 * DAY) });
    expect(await queueIds()).toEqual([l.id]);
  });

  it("leaves out a link saved less than 30 days ago", async () => {
    await link({ savedAt: ago(30 * DAY - 1) });
    expect(await queueIds()).toEqual([]);
  });

  it("leaves out a link opened less than 30 days ago", async () => {
    await link({ lastOpenedAt: ago(30 * DAY - 1) });
    expect(await queueIds()).toEqual([]);
  });

  it("leaves out archived links, put away or not", async () => {
    await link({ state: "archived" });
    await link({ state: "archived", putAwayAt: ago(DAY) });
    expect(await queueIds()).toEqual([]);
  });

  it("leaves out a kept tool", async () => {
    const tool = await link();
    await keepHandy(deps(), A, tool.id, "stated");
    expect(await queueIds()).toEqual([]);
  });

  it("leaves out a gone link", async () => {
    const gone = await link();
    await store.updateCheckIf(A, gone.id, null, {
      checkedAt: ago(DAY),
      result: "dead",
      detail: "http:404",
      firstDeadAt: ago(8 * DAY),
      flaggedAt: ago(DAY),
      stillWorksAt: null,
    });
    expect(await queueIds()).toEqual([]);
  });

  it("waits 180 days after Keep, and no longer", async () => {
    expect(TIDY_KEEP_WAIT_MS).toBe(180 * DAY);
    await link({ tidyKeptAt: ago(180 * DAY - 1) });
    const due = await link({ tidyKeptAt: ago(180 * DAY) });
    expect(await queueIds()).toEqual([due.id]);
  });

  it("never returns another owner's links", async () => {
    await link({}, B);
    const mine = await link();
    expect(await queueIds()).toEqual([mine.id]);
  });
});

describe("order and limit", () => {
  it("is oldest saved first", async () => {
    const newer = await link({ savedAt: ago(40 * DAY) });
    const older = await link({ savedAt: ago(90 * DAY) });
    expect(await queueIds()).toEqual([older.id, newer.id]);
  });

  it("breaks a tie on the lowest id, as a number", async () => {
    const saved = ago(60 * DAY);
    const first = await link({ savedAt: saved });
    const second = await link({ savedAt: saved });
    // The fake store issues "link-N" ids; show the queue numbers where text order would differ.
    const numbered = Object.create(store) as FakeStore;
    numbered.listLinks = async () => [
      { ...second, id: "9" },
      { ...first, id: "10" },
    ];
    const got = await tidyQueue({ ...deps(), store: numbered }, A, 5);
    expect(got.map((t) => t.link.id)).toEqual(["9", "10"]);
  });

  it("returns at most `limit`, the oldest ones", async () => {
    const old = await link({ savedAt: ago(100 * DAY) });
    await link({ savedAt: ago(50 * DAY) });
    expect(await queueIds(1)).toEqual([old.id]);
  });
});

describe("fit", () => {
  it("is null with no current focus", async () => {
    await link();
    await focus("stale", ago(30 * DAY + 1), []);
    const [t] = await tidyQueue(deps(), A, 5);
    expect(t?.fit).toBeNull();
    expect(searches).toEqual([]);
  });

  it("is null when nothing matches", async () => {
    await link();
    await focus("lunch", ago(DAY), []);
    expect((await tidyQueue(deps(), A, 5))[0]?.fit).toBeNull();
  });

  it("is the newest current entry that matches, and a window-edge entry counts", async () => {
    const l = await link();
    await focus("edge", ago(30 * DAY), [l.id]);
    expect((await tidyQueue(deps(), A, 5))[0]?.fit?.text).toBe("edge");
    await focus("newer", ago(DAY), [l.id]);
    await focus("newest unrelated", ago(1000), []);
    expect((await tidyQueue(deps(), A, 5))[0]?.fit?.text).toBe("newer");
  });

  it("searches once per current entry, not once per link", async () => {
    for (let i = 0; i < 4; i++) await link();
    await focus("one", ago(2 * DAY), []);
    await focus("two", ago(DAY), []);
    await tidyQueue(deps(), A, 5);
    expect(searches.sort()).toEqual(["one", "two"]);
  });
});

describe("tidyReady", () => {
  it("is false at four qualifying links and true at five", async () => {
    expect(TIDY_SESSION).toBe(5);
    for (let i = 0; i < 4; i++) await link();
    await link({ state: "archived" });
    expect(await tidyReady(deps(), A)).toBe(false);
    await link();
    expect(await tidyReady(deps(), A)).toBe(true);
  });

  it("counts only the owner's links", async () => {
    for (let i = 0; i < 5; i++) await link({}, B);
    expect(await tidyReady(deps(), A)).toBe(false);
  });
});

describe("keepInTidy", () => {
  it("sets tidyKeptAt to now and takes the link out of the queue", async () => {
    const l = await link();
    await keepInTidy(deps(), A, l.id);
    expect((await store.get(A, l.id))?.tidyKeptAt).toEqual(NOW);
    expect(await queueIds()).toEqual([]);
  });

  it("refuses an archived link with a conflict and leaves it unchanged", async () => {
    const l = await link({ state: "archived" });
    await expect(keepInTidy(deps(), A, l.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await store.get(A, l.id))?.tidyKeptAt).toBeNull();
  });

  it("refuses a put-away link the same way", async () => {
    const l = await link({ state: "archived", putAwayAt: ago(DAY) });
    await expect(keepInTidy(deps(), A, l.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await store.get(A, l.id))?.tidyKeptAt).toBeNull();
  });

  it("is not_found for a missing link or another owner's", async () => {
    const theirs = await link({}, B);
    await expect(keepInTidy(deps(), A, theirs.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(keepInTidy(deps(), A, "999")).rejects.toMatchObject({ code: "not_found" });
    expect((await store.get(B, theirs.id))?.tidyKeptAt).toBeNull();
  });
});
