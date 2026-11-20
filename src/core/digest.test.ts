import { beforeEach, describe, expect, it } from "vitest";
import {
  compareIds,
  DIGEST_SIZE,
  type DigestReason,
  dueTool,
  FOCUS_SLOTS,
  FOCUS_WINDOW_MS,
  getDigest,
  NOT_OPENED_MS,
  previewDigest,
} from "./digest.js";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import type { LinkCheck } from "./link-check-store.js";
import type { FocusHit, FocusMatch, SearchFilters } from "./search.js";
import { keepHandy, notHandy } from "./tools.js";
import type { FocusEntry, Link, NewLink, Source } from "./types.js";

const OWNER = "o";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-06-01T00:00:00Z");
const at = (delta: number) => new Date(NOW.getTime() + delta);

/** Focus matching with hits set per text; each hit's `words` is the text unless a test sets them. */
class FakeFocusMatch implements FocusMatch {
  hits = new Map<string, string[]>();
  calls: { text: string; filters: SearchFilters }[] = [];
  async match(_owner: string, text: string, filters: SearchFilters): Promise<FocusHit[]> {
    this.calls.push({ text, filters });
    return (this.hits.get(text) ?? []).map((id) => ({ id, words: [text] }));
  }
}

let store: FakeStore;
let profile: FakeProfileStore;
let keyword: FakeFocusMatch;
let clock: Date;
const deps = () => ({
  store,
  tools: store,
  checks: store,
  profile,
  focusMatch: keyword,
  now: () => clock,
});

beforeEach(() => {
  store = new FakeStore();
  profile = new FakeProfileStore();
  keyword = new FakeFocusMatch();
  clock = NOW;
});

let n = 0;
/** A link with a why, saved yesterday: To explore and eligible, with no reason. */
async function link(over: Partial<NewLink> = {}): Promise<Link> {
  n += 1;
  const url = `https://ex.com/${n}`;
  return (
    await store.insertIfAbsent(OWNER, {
      url,
      urlKey: url,
      title: null,
      summary: null,
      summarySource: null,
      why: { text: "w", source: "stated" },
      tags: [],
      savedAt: at(-DAY),
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

async function focus(text: string, created: Date, source: Source = "stated"): Promise<FocusEntry> {
  const result = await profile.apply(
    OWNER,
    { addNotes: [], editNotes: [], removeNotes: [], addFocus: [{ text, source }] },
    { writtenBy: "agent", at: created, focusLimit: 100, purgeBefore: new Date(0) },
  );
  if (!result.ok) throw new Error("the focus entry was not added");
  return result.recentFocus.find((f) => f.text === text) as FocusEntry;
}

const digestIds = async () => (await getDigest(deps(), OWNER)).links.map((l) => l.link.id);
const reasonsOf = async (id: string) =>
  (await getDigest(deps(), OWNER)).links.find((l) => l.link.id === id)?.reasons;
const focusWords = (entry: FocusEntry, words = [entry.text]): DigestReason => ({
  kind: "focus_words",
  focus: entry,
  words,
});

/** A row as two dead checks a week apart leave it: flagged as gone a day ago. */
const goneCheck = (): LinkCheck => ({
  checkedAt: at(-DAY),
  result: "dead",
  detail: "http:404",
  firstDeadAt: at(-8 * DAY),
  flaggedAt: at(-DAY),
  stillWorksAt: null,
});
const flag = async (id: string) => {
  await store.updateCheckIf(OWNER, id, await store.getCheck(OWNER, id), goneCheck());
};

describe("getDigest reasons", () => {
  it("gives no_why to a link without a why", async () => {
    const l = await link({ why: null });
    expect(await reasonsOf(l.id)).toEqual([{ kind: "no_why" }]);
  });

  it("gives not_opened_recently at exactly 30 days since saving and opening", async () => {
    const old = at(-NOT_OPENED_MS);
    const l = await link({ savedAt: old, lastOpenedAt: old });
    const savedLater = await link({ savedAt: at(-NOT_OPENED_MS + 1) });
    const openedLater = await link({ savedAt: old, lastOpenedAt: at(-NOT_OPENED_MS + 1) });
    const neverOpened = await link({ savedAt: old });
    const reasons = async (id: string) => (await reasonsOf(id))?.map((r) => r.kind);
    expect(await reasons(l.id)).toEqual(["not_opened_recently"]);
    expect(await reasons(neverOpened.id)).toEqual(["not_opened_recently"]);
    expect(await reasons(savedLater.id)).toEqual([]);
    expect(await reasons(openedLater.id)).toEqual([]);
  });

  it("gives focus_words with the whole entry, inferred source included", async () => {
    const l = await link();
    const entry = await focus("home batteries", at(-DAY), "inferred");
    keyword.hits.set("home batteries", [l.id]);
    expect(await reasonsOf(l.id)).toEqual([focusWords(entry)]);
    expect(entry.source).toBe("inferred");
  });

  it("gives every reason that applies, focus first, including several focus entries", async () => {
    const l = await link({ why: null, savedAt: at(-60 * DAY) });
    const older = await focus("solar", at(-2 * DAY));
    const newer = await focus("batteries", at(-DAY));
    keyword.hits.set("solar", [l.id]);
    keyword.hits.set("batteries", [l.id]);
    expect(await reasonsOf(l.id)).toEqual([
      focusWords(newer),
      focusWords(older),
      { kind: "no_why" },
      { kind: "not_opened_recently" },
    ]);
  });

  it("returns a link with no reason at all, as the new To explore link it is", async () => {
    const l = await link();
    expect(await digestIds()).toEqual([l.id]);
    expect(await reasonsOf(l.id)).toEqual([]);
  });
});

describe("getDigest eligibility", () => {
  it("excludes archived and snoozed links, at the exact snooze boundary", async () => {
    await link({ state: "archived" });
    await link({ snoozedUntil: at(1) });
    const snoozeEnded = await link({ snoozedUntil: NOW });
    expect(await digestIds()).toEqual([snoozeEnded.id]);
  });

  it("does not look at lastSurfacedAt: a link marked surfaced a moment ago is still picked", async () => {
    const l = await link({ lastSurfacedAt: NOW });
    expect(await digestIds()).toEqual([l.id]);
  });
});

describe("getDigest writes nothing", () => {
  it("returns the same links on a repeat call, and leaves every row as it was", async () => {
    for (let i = 0; i < DIGEST_SIZE + 2; i++) await link({ why: null });
    const before = structuredClone(store.all(OWNER));
    const first = await digestIds();
    expect(first).toHaveLength(DIGEST_SIZE);
    expect(await digestIds()).toEqual(first);
    expect(store.all(OWNER)).toEqual(before);
  });

  it("returns an empty digest for an empty library without searching", async () => {
    await focus("topic", at(-DAY));
    expect(await getDigest(deps(), OWNER)).toEqual({ links: [] });
    expect(keyword.calls).toEqual([]);
  });
});

describe("getDigest focus", () => {
  it("counts an entry created exactly 30 days ago, not one a moment older", async () => {
    const inWindow = await link();
    const outOfWindow = await link();
    await focus("edge", at(-FOCUS_WINDOW_MS));
    await focus("stale", at(-FOCUS_WINDOW_MS - 1));
    keyword.hits.set("edge", [inWindow.id]);
    keyword.hits.set("stale", [outOfWindow.id]);
    const reasons = (id: string) => reasonsOf(id).then((r) => r?.map((x) => x.kind));
    expect(await reasons(inWindow.id)).toEqual(["focus_words"]);
    expect(await reasons(outOfWindow.id)).toEqual([]);
  });

  it("uses only the newest 10 entries", async () => {
    const l = await link();
    await focus("oldest", at(-20 * DAY));
    for (let i = 0; i < 10; i++) await focus(`f${i}`, at(-DAY));
    keyword.hits.set("oldest", [l.id]);
    expect(await reasonsOf(l.id)).toEqual([]);
  });

  it("gives every hit its reason: no per-entry cut and no rank", async () => {
    const hits = [];
    for (let i = 0; i < 8; i++) hits.push(await link());
    await focus("topic", at(-DAY));
    keyword.hits.set(
      "topic",
      [...hits].reverse().map((h) => h.id),
    );
    const all = (await previewDigest(deps(), OWNER, Number.POSITIVE_INFINITY)).links;
    expect(all).toHaveLength(8);
    for (const d of all) expect(d.reasons.map((r) => r.kind)).toEqual(["focus_words"]);
  });

  it("skips excluded hits, however many a search page holds", async () => {
    const excluded = [];
    for (let i = 0; i < 60; i++) excluded.push(await link({ snoozedUntil: at(DAY) }));
    const behind = await link();
    await focus("topic", at(-DAY));
    keyword.hits.set("topic", [...excluded.map((l) => l.id), behind.id]);
    expect(await reasonsOf(behind.id)).toHaveLength(1);
  });

  it("asks the focus matcher directly and unfiltered, so nothing is logged", async () => {
    await link({ why: null });
    await link({ state: "archived" });
    await focus("topic", at(-DAY));
    await getDigest(deps(), OWNER);
    expect(keyword.calls).toEqual([{ text: "topic", filters: {} }]);
  });
});

describe("getDigest order", () => {
  it("puts focus links first, oldest saved first, then the rest oldest saved first", async () => {
    const day = (d: number, over: Partial<NewLink> = {}) =>
      link({ savedAt: at(-d * DAY), ...over });
    const rest1 = await day(9);
    const f1 = await day(5);
    const rest2 = await day(7);
    const f2 = await day(3);
    await focus("topic", at(-DAY));
    keyword.hits.set("topic", [f2.id, f1.id]);
    expect(await digestIds()).toEqual([f1.id, f2.id, rest1.id, rest2.id]);
  });

  it("breaks a tie on the lowest id, as a number", () => {
    expect(compareIds("9", "10")).toBeLessThan(0);
    expect(compareIds("10", "10")).toBe(0);
    expect(compareIds("link-9", "link-10")).toBeGreaterThan(0);
  });

  it("orders links saved at the same instant by id, whatever order the store lists them in", async () => {
    const same = at(-3 * DAY);
    const made = [
      await link({ savedAt: same }),
      await link({ savedAt: same }),
      await link({ savedAt: same }),
    ];
    const reversed = Object.assign(Object.create(store), {
      listLinks: async (owner: string) => (await store.listLinks(owner)).reverse(),
    });
    const got = await previewDigest({ ...deps(), store: reversed }, OWNER);
    expect(got.links.map((d) => d.link.id)).toEqual(made.map((l) => l.id));
  });

  it("holds FOCUS_SLOTS focus picks; further focus matches follow in age order with the rest", async () => {
    const hits = [];
    for (let d = 20; d > 20 - (FOCUS_SLOTS + 1); d--)
      hits.push(await link({ savedAt: at(-d * DAY) }));
    const [fourth, ...firstThree] = [...hits].reverse();
    const older = await link({ savedAt: at(-30 * DAY) });
    await focus("topic", at(-DAY));
    keyword.hits.set(
      "topic",
      hits.map((l) => l.id),
    );
    expect(FOCUS_SLOTS).toBe(3);
    const got = await digestIds();
    expect(got.slice(0, FOCUS_SLOTS)).toEqual(hits.slice(0, FOCUS_SLOTS).map((l) => l.id));
    expect(got.slice(FOCUS_SLOTS)).toEqual([older.id, (fourth as Link).id]);
    expect(firstThree).toHaveLength(FOCUS_SLOTS);
  });

  it("returns a link that is both a focus match and without a why once", async () => {
    const both = await link({ why: null, savedAt: at(-50 * DAY) });
    for (let i = 0; i < 5; i++) await link({ why: null });
    await focus("topic", at(-DAY));
    keyword.hits.set("topic", [both.id]);
    const ids = await digestIds();
    expect(ids).toHaveLength(DIGEST_SIZE);
    expect(ids.filter((id) => id === both.id)).toHaveLength(1);
  });

  it("is the same on every day: no rotation", async () => {
    for (let i = 0; i < 12; i++) await link({ why: null, savedAt: at(-(i + 2) * DAY) });
    const first = await digestIds();
    for (const day of [1, 2, 3, 40]) {
      clock = at(day * DAY);
      expect(await digestIds()).toEqual(first);
    }
  });
});

describe("gone links (#128)", () => {
  it("leaves a gone link out of previewDigest and getDigest, while a dead link not yet flagged stays", async () => {
    const gone = await link({ why: null });
    const dead = await link({ why: null });
    await flag(gone.id);
    await store.updateCheckIf(OWNER, dead.id, null, {
      ...goneCheck(),
      firstDeadAt: at(-DAY),
      flaggedAt: null,
    });
    expect((await previewDigest(deps(), OWNER)).links.map((d) => d.link.id)).toEqual([dead.id]);
    expect(await digestIds()).toEqual([dead.id]);
  });
});

describe("previewDigest", () => {
  it("picks what getDigest then returns, in its order and with its reasons", async () => {
    await focus("solar", at(-DAY));
    const focused = await link();
    keyword.hits.set("solar", [focused.id]);
    for (let i = 0; i < DIGEST_SIZE + 2; i++)
      await link({ why: null, savedAt: at(-(i + 2) * DAY) });
    const preview = await previewDigest(deps(), OWNER);
    expect(preview.links).toHaveLength(DIGEST_SIZE);
    const digest = await getDigest(deps(), OWNER);
    expect(preview.links.map((l) => [l.link.id, l.reasons])).toEqual(
      digest.links.map((l) => [l.link.id, l.reasons]),
    );
  });

  it("with a larger limit returns the same order, then the rest", async () => {
    for (let i = 0; i < DIGEST_SIZE + 3; i++)
      await link({ why: null, savedAt: at(-(i + 2) * DAY) });
    const first = (await previewDigest(deps(), OWNER)).links.map((l) => l.link.id);
    const all = (await previewDigest(deps(), OWNER, Number.POSITIVE_INFINITY)).links;
    expect(all).toHaveLength(DIGEST_SIZE + 3);
    expect(all.slice(0, DIGEST_SIZE).map((l) => l.link.id)).toEqual(first);
  });

  it("takes `focusSlots` focus picks first and leaves out `exclude`", async () => {
    const old = await link({ savedAt: at(-30 * DAY) });
    const a = await link({ savedAt: at(-3 * DAY) });
    const b = await link({ savedAt: at(-2 * DAY) });
    await focus("topic", at(-DAY));
    keyword.hits.set("topic", [a.id, b.id]);
    const ids = async (...args: [number, Set<string>, number]) =>
      (await previewDigest(deps(), OWNER, ...args)).links.map((l) => l.link.id);
    expect(await ids(3, new Set(), 1)).toEqual([a.id, old.id, b.id]);
    expect(await ids(3, new Set(), 2)).toEqual([a.id, b.id, old.id]);
    expect(await ids(3, new Set([a.id]), 1)).toEqual([b.id, old.id]);
  });
});

describe("intent", () => {
  it("leaves a To keep link out of the preview and the digest, and picks the same link as To explore", async () => {
    const keep = await link({ why: null, intent: "keep", intentSource: "stated" });
    const guess = await link({ why: null, intent: "keep", intentSource: "inferred" });
    const explore = await link({ why: null });
    await focus("bills", at(-DAY));
    keyword.hits.set("bills", [keep.id, guess.id, explore.id]);
    expect((await previewDigest(deps(), OWNER)).links.map((l) => l.link.id)).toEqual([explore.id]);
    expect(await digestIds()).toEqual([explore.id]);
    await store.update(OWNER, keep.id, { intent: "explore", intentSource: "stated" });
    expect(await digestIds()).toContain(keep.id);
  });
});

describe("kept tools", () => {
  it("leaves a kept tool out, even one a focus entry matches", async () => {
    const tool = await link({ why: null, savedAt: at(-60 * DAY) });
    await focus("lunch", at(-DAY));
    keyword.hits.set("lunch", [tool.id]);
    await keepHandy(deps(), OWNER, tool.id, "stated");
    expect((await previewDigest(deps(), OWNER)).links).toEqual([]);
    expect((await getDigest(deps(), OWNER)).links).toEqual([]);
  });

  it("does not let a kept tool use up a focus entry's slots", async () => {
    const tool = await link({ savedAt: at(-90 * DAY) });
    const others = [await link(), await link(), await link()];
    const entry = await focus("lunch", at(-DAY));
    keyword.hits.set("lunch", [tool.id, ...others.map((l) => l.id)]);
    await keepHandy(deps(), OWNER, tool.id, "stated");
    const digest = await getDigest(deps(), OWNER);
    expect(digest.links.map((l) => [l.link.id, l.reasons])).toEqual(
      others.map((l) => [l.id, [focusWords(entry)]]),
    );
  });

  it("gives suggested and declined links their reasons, as ordinary links", async () => {
    const suggested = await link({ why: null });
    const declined = await link({ why: null });
    await keepHandy(deps(), OWNER, suggested.id, "inferred");
    await notHandy(deps(), OWNER, declined.id, "stated");
    const digest = await getDigest(deps(), OWNER);
    expect(digest.links.map((l) => [l.link.id, l.reasons])).toEqual([
      [suggested.id, [{ kind: "no_why" }]],
      [declined.id, [{ kind: "no_why" }]],
    ]);
  });
});

describe("dueTool", () => {
  /** A link kept handy 40 days before now, so it is due unless something says otherwise. */
  async function dueLink(over: Partial<NewLink> = {}): Promise<Link> {
    const l = await link(over);
    clock = at(-40 * DAY);
    await keepHandy(deps(), OWNER, l.id, "stated");
    clock = NOW;
    return l;
  }

  it("is null when no kept tool is due", async () => {
    const fresh = await link();
    await keepHandy(deps(), OWNER, fresh.id, "stated");
    await link({ why: null });
    expect(await dueTool(deps(), OWNER)).toBeNull();
  });

  it("skips a gone tool", async () => {
    const tool = await dueLink();
    await flag(tool.id);
    expect(await dueTool(deps(), OWNER)).toBeNull();
  });

  it("returns the oldest saved due tool, with whole days since its opening", async () => {
    await dueLink({ savedAt: at(-10 * DAY) });
    const oldest = await dueLink({ savedAt: at(-50 * DAY), lastOpenedAt: at(-45 * DAY - HOUR) });
    expect(await dueTool(deps(), OWNER)).toEqual({
      link: await store.get(OWNER, oldest.id),
      daysSinceOpened: 45,
    });
  });

  it("gives null days for a tool never opened", async () => {
    const never = await dueLink();
    expect(await dueTool(deps(), OWNER)).toEqual({
      link: await store.get(OWNER, never.id),
      daysSinceOpened: null,
    });
  });

  it("skips a due tool that is snoozed or archived, and does not look at lastSurfacedAt", async () => {
    await dueLink({ snoozedUntil: at(DAY) });
    await dueLink({ state: "archived" });
    expect(await dueTool(deps(), OWNER)).toBeNull();
    const surfaced = await dueLink({ lastSurfacedAt: at(-DAY) });
    expect((await dueTool(deps(), OWNER))?.link.id).toBe(surfaced.id);
  });
});

describe("getDigest's still_using_check", () => {
  /** A link kept handy 40 days before now: due unless something says otherwise. */
  async function due(over: Partial<NewLink> = {}): Promise<Link> {
    const l = await link(over);
    clock = at(-40 * DAY);
    await keepHandy(deps(), OWNER, l.id, "stated");
    clock = NOW;
    return l;
  }
  const check = (daysSinceOpened: number | null): DigestReason => ({
    kind: "still_using_check",
    daysSinceOpened,
  });
  const shown = async () =>
    (await getDigest(deps(), OWNER)).links.map((d) => [d.link.id, d.reasons]);

  it("adds the due tool last, as its own item with whole days since its opening", async () => {
    const reading = await link({ why: null });
    const tool = await due({ lastOpenedAt: at(-45 * DAY - HOUR) });
    expect(await shown()).toEqual([
      [reading.id, [{ kind: "no_why" }]],
      [tool.id, [check(45)]],
    ]);
  });

  it("asks nothing about a gone tool, and the reading link keeps its slot (#128)", async () => {
    const reading = await link({ why: null });
    const tool = await due();
    await flag(tool.id);
    expect(await shown()).toEqual([[reading.id, [{ kind: "no_why" }]]]);
  });

  it("gives null days for a tool never opened", async () => {
    const tool = await due();
    expect(await shown()).toEqual([[tool.id, [check(null)]]]);
  });

  it("holds at most one check, and asks about the same tool on a repeat call", async () => {
    const first = await due({ savedAt: at(-50 * DAY) });
    await due();
    expect(await shown()).toEqual([[first.id, [check(null)]]]);
    expect(await shown()).toEqual([[first.id, [check(null)]]]);
  });

  it("takes one of the DIGEST_SIZE slots: the oldest reading links fill the rest", async () => {
    const reading: Link[] = [];
    for (let i = 0; i < DIGEST_SIZE; i++) {
      reading.push(await link({ why: null, savedAt: at(-(DIGEST_SIZE + 3 - i) * DAY) }));
    }
    const tool = await due();
    const digest = await getDigest(deps(), OWNER);
    expect(digest.links.map((d) => d.link.id)).toEqual([
      ...reading.slice(0, DIGEST_SIZE - 1).map((l) => l.id),
      tool.id,
    ]);
  });

  it("previewDigest leaves the check out and writes nothing", async () => {
    const reading = await link({ why: null });
    await due();
    const before = structuredClone(store.all(OWNER));
    expect((await previewDigest(deps(), OWNER)).links.map((d) => d.link.id)).toEqual([reading.id]);
    expect(store.all(OWNER)).toEqual(before);
  });
});

describe("an archived link and a focus entry written after it", () => {
  it("is not offered", async () => {
    const archived = await link({ state: "archived" });
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", [archived.id]);
    expect((await previewDigest(deps(), OWNER)).links).toEqual([]);
    expect((await getDigest(deps(), OWNER)).links).toEqual([]);
  });
});
