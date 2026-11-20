import { beforeEach, describe, expect, it } from "vitest";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import type { FocusMatch } from "./search.js";
import { TIDY_SESSION, type TidyDeps, tidyQueue, tidySession } from "./tidy-up.js";
import { keepHandy } from "./tools.js";
import type { Link, NewLink } from "./types.js";
import { exploreLink, keepLink } from "./worth-a-look.js";

const A = "a";
const B = "b";
const DAY = 86_400_000;
const NOW = new Date("2026-10-21T09:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let store: FakeStore;
let profile: FakeProfileStore;
let hits: Map<string, string[]>;
let searches: string[];
const focusMatch: FocusMatch = {
  match: async (_owner, text) => {
    searches.push(text);
    return (hits.get(text) ?? []).map((id) => ({ id, words: [text] }));
  },
};
const deps = (): TidyDeps => ({
  store,
  tools: store,
  checks: store,
  profile,
  focusMatch,
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
      summarySource: null,
      why: null,
      tags: [],
      savedAt: ago(60 * DAY),
      savedBy: "t",
      lastOpenedAt: null,
      intent: "explore",
      intentSource: null,
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

  it("leaves out archived links", async () => {
    await link({ state: "archived" });
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

  it("never asks about a To keep link, stated, asked or guessed", async () => {
    await link({ intent: "keep", intentSource: "stated" });
    await link({ intent: "keep", intentSource: "asked" });
    await link({ intent: "keep", intentSource: "inferred" });
    const asked = await link({ intent: "explore", intentSource: "stated" });
    const plain = await link();
    expect(await queueIds()).toEqual([asked.id, plain.id]);
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

describe("skip", () => {
  it("leaves out the skipped links before the limit is applied", async () => {
    const old = await link({ savedAt: ago(100 * DAY) });
    const rest = [];
    for (let i = 0; i < TIDY_SESSION; i++) rest.push(await link({ savedAt: ago((90 - i) * DAY) }));
    const got = await tidyQueue(deps(), A, TIDY_SESSION, new Set([old.id]));
    expect(got.map((t) => t.link.id)).toEqual(rest.map((l) => l.id));
  });

  it("looks up a fit for the links it keeps", async () => {
    const skipped = await link({ savedAt: ago(100 * DAY) });
    const kept = await link({ savedAt: ago(90 * DAY) });
    await focus("both", ago(DAY), [skipped.id, kept.id]);
    const got = await tidyQueue(deps(), A, 5, new Set([skipped.id]));
    expect(got.map((t) => [t.link.id, t.fit?.text])).toEqual([[kept.id, "both"]]);
  });

  it("answers nothing, and searches nothing, when every qualifying link is skipped", async () => {
    const l = await link();
    await focus("x", ago(DAY), [l.id]);
    expect(await tidyQueue(deps(), A, 5, new Set([l.id]))).toEqual([]);
    expect(searches).toEqual([]);
  });
});

describe("tidySession", () => {
  it("gives the queue when a full session is left after the skip", async () => {
    const skipped = await link({ savedAt: ago(100 * DAY) });
    const rest = [];
    for (let i = 0; i < TIDY_SESSION; i++) rest.push(await link({ savedAt: ago((90 - i) * DAY) }));
    const got = await tidySession(deps(), A, new Set([skipped.id]));
    expect(got?.map((t) => t.link.id)).toEqual(rest.map((l) => l.id));
  });

  it("gives nothing when one fewer than a full session is left", async () => {
    for (let i = 0; i < TIDY_SESSION - 1; i++) await link({ savedAt: ago((90 - i) * DAY) });
    expect(await tidySession(deps(), A, new Set())).toBeNull();
  });

  it("gives nothing when the skip takes a full session down by one", async () => {
    const [first] = [await link({ savedAt: ago(100 * DAY) })];
    for (let i = 0; i < TIDY_SESSION - 1; i++) await link({ savedAt: ago((90 - i) * DAY) });
    expect(await tidySession(deps(), A, new Set())).not.toBeNull();
    expect(await tidySession(deps(), A, new Set([first.id]))).toBeNull();
  });
});

describe("Keep it and Explore it in Tidy up", () => {
  it("Keep it takes the link out of the queue for good, and Explore it puts it back", async () => {
    const l = await link();
    await keepLink(deps(), A, l.id);
    expect(await queueIds()).toEqual([]);
    expect(await store.get(A, l.id)).toMatchObject({ intent: "keep", intentSource: "stated" });
    await exploreLink(deps(), A, l.id);
    expect(await queueIds()).toEqual([l.id]);
  });

  it("refuses an archived link with a conflict and leaves it unchanged", async () => {
    const l = await link({ state: "archived" });
    await expect(keepLink(deps(), A, l.id)).rejects.toMatchObject({ code: "conflict" });
    expect(await store.get(A, l.id)).toMatchObject({ intent: "explore", intentSource: null });
  });

  it("is not_found for a missing link or another owner's", async () => {
    const theirs = await link({}, B);
    await expect(keepLink(deps(), A, theirs.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(keepLink(deps(), A, "999")).rejects.toMatchObject({ code: "not_found" });
    expect(await store.get(B, theirs.id)).toMatchObject({ intent: "explore" });
  });
});
