import { beforeEach, describe, expect, it } from "vitest";
import {
  claimDueTool,
  claimSurfaced,
  compareIds,
  DIGEST_SIZE,
  type DigestReason,
  dueTool,
  FOCUS_MATCHES_PER_ENTRY,
  FOCUS_SLOTS,
  FOCUS_WINDOW_MS,
  getDigest,
  NOT_OPENED_MS,
  previewDigest,
  SURFACE_COOLDOWN_MS,
} from "./digest.js";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import type { LinkCheck } from "./link-check-store.js";
import { recordOpening } from "./links.js";
import type { LinkSearch, SearchFilters, SearchTrace } from "./search.js";
import type { LinkStore } from "./store.js";
import { keepHandy, notHandy, stillUsing } from "./tools.js";
import type { FocusEntry, Link, NewLink, Source } from "./types.js";
import { bringBackLink, putAwayLink } from "./worth-a-look.js";

const OWNER = "o";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-06-01T00:00:00Z");
const at = (delta: number) => new Date(NOW.getTime() + delta);
const CUTOFF = at(-SURFACE_COOLDOWN_MS);

/** Keyword search with hits set per query, honouring `limit` like the real engine. */
class FakeKeywordSearch implements LinkSearch {
  hits = new Map<string, string[]>();
  calls: { query: string; filters: SearchFilters; limit: number; traced: boolean }[] = [];
  async search(
    _owner: string,
    query: string,
    filters: SearchFilters,
    limit: number,
    trace?: (t: SearchTrace) => void,
  ) {
    this.calls.push({ query, filters, limit, traced: trace !== undefined });
    return (this.hits.get(query) ?? []).slice(0, limit);
  }
}

let store: FakeStore;
let profile: FakeProfileStore;
let keyword: FakeKeywordSearch;
let clock: Date;
const deps = (over: { store?: LinkStore } = {}) => ({
  store,
  tools: store,
  checks: store,
  profile,
  keywordSearch: keyword,
  now: () => clock,
  ...over,
});

beforeEach(() => {
  store = new FakeStore();
  profile = new FakeProfileStore();
  keyword = new FakeKeywordSearch();
  clock = NOW;
});

let n = 0;
/** A link with a why, saved yesterday and surfaced exactly at the cutoff: eligible, with no reason. */
async function link(over: Partial<NewLink> = {}): Promise<Link> {
  n += 1;
  const url = `https://ex.com/${n}`;
  return (
    await store.insertIfAbsent(OWNER, {
      url,
      urlKey: url,
      title: null,
      summary: null,
      why: { text: "w", source: "stated" },
      tags: [],
      savedAt: at(-DAY),
      savedBy: "t",
      lastOpenedAt: null,
      putAwayAt: null,
      tidyKeptAt: null,
      lastSurfacedAt: CUTOFF,
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
const focusWords = (entry: FocusEntry): DigestReason => ({ kind: "focus_words", focus: entry });

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
  it("gives no_why to a link without a why, surfaced exactly at the cooldown cutoff", async () => {
    const l = await link({ why: null });
    expect(await reasonsOf(l.id)).toEqual([{ kind: "no_why" }]);
  });

  it("gives not_opened_recently at exactly 30 days since saving and opening", async () => {
    const old = at(-NOT_OPENED_MS);
    const l = await link({ savedAt: old, lastOpenedAt: old });
    const savedLater = await link({ savedAt: at(-NOT_OPENED_MS + 1) });
    const openedLater = await link({ savedAt: old, lastOpenedAt: at(-NOT_OPENED_MS + 1) });
    const neverOpened = await link({ savedAt: old });
    expect(await digestIds()).toEqual([l.id, neverOpened.id]);
    expect(store.all(OWNER).find((x) => x.id === savedLater.id)?.lastSurfacedAt).toEqual(CUTOFF);
    expect(store.all(OWNER).find((x) => x.id === openedLater.id)?.lastSurfacedAt).toEqual(CUTOFF);
  });

  it("gives never_surfaced to a link never surfaced before", async () => {
    const l = await link({ lastSurfacedAt: null });
    expect(await reasonsOf(l.id)).toEqual([{ kind: "never_surfaced" }]);
  });

  it("gives focus_words with the whole entry, inferred source included", async () => {
    const l = await link();
    const entry = await focus("home batteries", at(-DAY), "inferred");
    keyword.hits.set("home batteries", [l.id]);
    expect(await reasonsOf(l.id)).toEqual([focusWords(entry)]);
    expect(entry.source).toBe("inferred");
  });

  it("gives every reason that applies, focus first, including several focus entries", async () => {
    const l = await link({ why: null, savedAt: at(-60 * DAY), lastSurfacedAt: null });
    const older = await focus("solar", at(-2 * DAY));
    const newer = await focus("batteries", at(-DAY));
    keyword.hits.set("solar", [l.id]);
    keyword.hits.set("batteries", [l.id]);
    expect(await reasonsOf(l.id)).toEqual([
      focusWords(newer),
      focusWords(older),
      { kind: "no_why" },
      { kind: "not_opened_recently" },
      { kind: "never_surfaced" },
    ]);
  });

  it("leaves out, and does not mark, an eligible link with no reason", async () => {
    const l = await link();
    expect(await digestIds()).toEqual([]);
    expect((await store.get(OWNER, l.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });
});

describe("getDigest eligibility", () => {
  it("excludes archived, snoozed and recently surfaced links, at the exact boundaries", async () => {
    const archived = await link({ why: null, state: "archived" });
    const snoozed = await link({ why: null, snoozedUntil: at(1) });
    const snoozeEnded = await link({ why: null, snoozedUntil: NOW });
    const inside = await link({ why: null, lastSurfacedAt: at(-SURFACE_COOLDOWN_MS + 1) });
    const atCutoff = await link({ why: null });
    expect(await digestIds()).toEqual([snoozeEnded.id, atCutoff.id]);
    const after = Object.fromEntries(store.all(OWNER).map((l) => [l.id, l.lastSurfacedAt]));
    expect(after[archived.id]).toEqual(CUTOFF);
    expect(after[snoozed.id]).toEqual(CUTOFF);
    expect(after[inside.id]).toEqual(at(-SURFACE_COOLDOWN_MS + 1));
  });

  it("marks what it returns at now, and the next call at the same time returns others", async () => {
    const links = [];
    for (let i = 0; i < DIGEST_SIZE + 2; i++) links.push(await link({ why: null }));
    const first = await getDigest(deps(), OWNER);
    expect(first.links).toHaveLength(DIGEST_SIZE);
    for (const { link: l } of first.links) {
      expect(l.lastSurfacedAt).toEqual(NOW);
      expect((await store.get(OWNER, l.id))?.lastSurfacedAt).toEqual(NOW);
    }
    const second = await digestIds();
    expect(second).toHaveLength(2);
    expect(second.some((id) => first.links.some((l) => l.link.id === id))).toBe(false);
    expect(await digestIds()).toEqual([]);
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
    expect(await digestIds()).toEqual([inWindow.id]);
  });

  it("uses only the newest 10 entries", async () => {
    const l = await link();
    await focus("oldest", at(-20 * DAY));
    for (let i = 0; i < 10; i++) await focus(`f${i}`, at(-DAY));
    keyword.hits.set("oldest", [l.id]);
    expect(await digestIds()).toEqual([]);
  });

  it("gives an entry's reason to its first 3 eligible hits, skipping excluded ones", async () => {
    const archived = await link({ state: "archived" });
    const snoozed = await link({ snoozedUntil: at(DAY) });
    const hits = [];
    for (let i = 0; i < FOCUS_MATCHES_PER_ENTRY + 1; i++) hits.push(await link());
    await focus("topic", at(-DAY));
    keyword.hits.set("topic", [archived.id, snoozed.id, ...hits.map((h) => h.id)]);
    expect(await digestIds()).toEqual(hits.slice(0, FOCUS_MATCHES_PER_ENTRY).map((h) => h.id));
  });

  it("finds an eligible match ranked behind more excluded matches than a search page holds", async () => {
    const excluded = [];
    for (let i = 0; i < 60; i++) excluded.push(await link({ snoozedUntil: at(DAY) }));
    const behind = await link();
    await focus("topic", at(-DAY));
    keyword.hits.set("topic", [...excluded.map((l) => l.id), behind.id]);
    expect(await digestIds()).toEqual([behind.id]);
  });

  it("asks the keyword engine directly, unfiltered and untraced, so nothing is logged", async () => {
    await link({ why: null });
    await link({ state: "archived" });
    await focus("topic", at(-DAY));
    await getDigest(deps(), OWNER);
    expect(keyword.calls).toEqual([{ query: "topic", filters: {}, limit: 2, traced: false }]);
  });
});

describe("getDigest order", () => {
  it("puts focus links first by newest entry then rank, then rotates the rest", async () => {
    const f1 = await link();
    const f2 = await link();
    const f3 = await link();
    const rest = await link({ why: null, lastSurfacedAt: null });
    const older = await focus("older", at(-2 * DAY));
    const newer = await focus("newer", at(-DAY));
    keyword.hits.set("newer", [f2.id, f1.id]);
    keyword.hits.set("older", [f3.id, f2.id]);
    const digest = await getDigest(deps(), OWNER);
    expect(digest.links.map((l) => l.link.id)).toEqual([f2.id, f1.id, f3.id, rest.id]);
    expect(digest.links[0]?.reasons).toEqual([focusWords(newer), focusWords(older)]);
  });

  it("orders other links by last touched (surfaced, or saved if never), then oldest saved, then id, and keeps 5", async () => {
    const q = await link({ why: null, savedAt: at(-DAY), lastSurfacedAt: null });
    const u = await link({ why: null, savedAt: at(-3 * DAY), lastSurfacedAt: null });
    const w = await link({ why: null, savedAt: at(-15 * DAY), lastSurfacedAt: null });
    const p = await link({ why: null, savedAt: at(-20 * DAY), lastSurfacedAt: at(-20 * DAY) });
    const t = await link({ why: null, savedAt: at(-3 * DAY), lastSurfacedAt: null });
    const v = await link({ why: null, savedAt: at(-30 * DAY), lastSurfacedAt: at(-15 * DAY) });
    expect(await digestIds()).toEqual([p.id, v.id, w.id, u.id, t.id]);
    expect((await store.get(OWNER, q.id))?.lastSurfacedAt).toBeNull();
  });

  it("holds FOCUS_SLOTS focus picks, then rotation links, when focus matches outnumber the slots", async () => {
    const newerHits = [await link(), await link(), await link()];
    const olderHits = [await link(), await link(), await link()];
    const rotating = [];
    for (let i = 0; i < 3; i++) {
      rotating.push(await link({ why: null, savedAt: at(-20 * DAY), lastSurfacedAt: null }));
    }
    await focus("older", at(-2 * DAY));
    await focus("newer", at(-DAY));
    keyword.hits.set(
      "newer",
      newerHits.map((l) => l.id),
    );
    keyword.hits.set(
      "older",
      olderHits.map((l) => l.id),
    );
    expect(FOCUS_SLOTS).toBe(3);
    expect(await digestIds()).toEqual([
      ...newerHits.slice(0, FOCUS_SLOTS).map((l) => l.id),
      rotating[0]?.id,
      rotating[1]?.id,
    ]);
  });

  it("lets rotation fill the slots focus does not use", async () => {
    const hit = await link();
    const rotating = [];
    for (let i = 0; i < 5; i++) rotating.push(await link({ why: null, lastSurfacedAt: null }));
    await focus("topic", at(-DAY));
    keyword.hits.set("topic", [hit.id]);
    expect(await digestIds()).toEqual([
      hit.id,
      ...rotating.slice(0, DIGEST_SIZE - 1).map((l) => l.id),
    ]);
  });

  it("returns a link that is both a focus match and without a why once", async () => {
    const both = await link({ why: null, savedAt: at(-50 * DAY) });
    for (let i = 0; i < 5; i++) await link({ why: null });
    await focus("topic", at(-DAY));
    keyword.hits.set("topic", [both.id]);
    const ids = await digestIds();
    expect(ids).toHaveLength(DIGEST_SIZE);
    expect(new Set(ids).size).toBe(DIGEST_SIZE);
    expect(ids.filter((id) => id === both.id)).toHaveLength(1);
  });

  it("gives every link a turn in 30 days although two broad focus entries match 120 links", async () => {
    const newerHits = [];
    const olderHits = [];
    for (let i = 0; i < 60; i++) newerHits.push(await link());
    for (let i = 0; i < 60; i++) olderHits.push(await link());
    const lone = await link({ why: null, savedAt: at(-90 * DAY), lastSurfacedAt: null });
    const oldestOnly = await link({ savedAt: NOW });
    await focus("oldest", at(-2 * HOUR));
    await focus("older", at(-HOUR));
    await focus("newer", NOW);
    keyword.hits.set(
      "newer",
      newerHits.map((l) => l.id),
    );
    keyword.hits.set(
      "older",
      olderHits.map((l) => l.id),
    );
    keyword.hits.set("oldest", [oldestOnly.id]);
    const seen = new Set<string>();
    for (let day = 0; day < 30; day++) {
      clock = at(day * DAY);
      for (const id of await digestIds()) seen.add(id);
    }
    expect(seen.has(lone.id), "the link with no why").toBe(true);
    expect(seen.has(oldestOnly.id), "the link matched only by the oldest entry").toBe(true);
  });

  it("compares decimal ids as numbers and other ids as strings", () => {
    expect(compareIds("9", "10")).toBeLessThan(0);
    expect(compareIds("10", "10")).toBe(0);
    expect(compareIds("link-9", "link-10")).toBeGreaterThan(0);
  });

  it("rotates through every link over 60 daily digests, whatever their reasons", async () => {
    // 75 links without a why could fill every digest for good; 26 with only not_opened_recently must still appear.
    const ids = new Set<string>();
    for (let i = 0; i < 75; i++) ids.add((await link({ why: null, lastSurfacedAt: null })).id);
    for (let i = 0; i < 26; i++) {
      ids.add((await link({ savedAt: at(-60 * DAY), lastSurfacedAt: null })).id);
    }
    const seen = new Set<string>();
    for (let day = 0; day < 60; day++) {
      clock = at(day * DAY);
      const today = await digestIds();
      expect(today).toHaveLength(DIGEST_SIZE);
      for (const id of today) seen.add(id);
    }
    expect(seen).toEqual(ids);
  });

  it("brings shown links back although more new links are saved each day than a digest holds", async () => {
    const first: string[] = [];
    for (let i = 0; i < 10; i++) {
      first.push((await link({ why: null, savedAt: at(-60 * DAY), lastSurfacedAt: null })).id);
    }
    const shown = new Map<string, number>();
    for (let day = 0; day < 60; day++) {
      clock = at(day * DAY);
      for (const id of await digestIds()) shown.set(id, (shown.get(id) ?? 0) + 1);
      for (let i = 0; i < DIGEST_SIZE; i++) {
        await link({ why: null, savedAt: clock, lastSurfacedAt: null });
      }
    }
    for (const id of first) expect(shown.get(id) ?? 0, `link ${id}`).toBeGreaterThanOrEqual(2);
  });
});

/** Runs `meanwhile` after selection and before the claim reaches the store. */
const racing = (meanwhile: () => Promise<unknown>): LinkStore =>
  Object.assign(Object.create(store) as FakeStore, {
    claimSurfaced: async (...args: Parameters<LinkStore["claimSurfaced"]>) => {
      await meanwhile();
      return store.claimSurfaced(...args);
    },
  });

describe("getDigest claim", () => {
  it("judges reasons from the claimed link, dropping one left with none and skipping one snoozed", async () => {
    const filled = await link({ why: null });
    const halfFilled = await link({ why: null, savedAt: at(-20 * DAY), lastSurfacedAt: null });
    const snoozed = await link({ why: null });
    const kept = await link({ why: null });
    const digest = await getDigest(
      deps({
        store: racing(async () => {
          for (const l of [filled, halfFilled]) {
            await store.update(OWNER, l.id, { why: { text: "now", source: "asked" } });
          }
          await store.update(OWNER, snoozed.id, { snoozedUntil: at(DAY) });
        }),
      }),
      OWNER,
    );
    expect(digest.links.map((l) => [l.link.id, l.reasons])).toEqual([
      [halfFilled.id, [{ kind: "never_surfaced" }]],
      [kept.id, [{ kind: "no_why" }]],
    ]);
    expect(digest.links[0]?.link.why).toEqual({ text: "now", source: "asked" });
    expect((await store.get(OWNER, filled.id))?.lastSurfacedAt).toEqual(NOW);
    expect((await store.get(OWNER, snoozed.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });

  it("returns every link it claimed, including one it left out, and none it skipped", async () => {
    const filled = await link({ why: null });
    const snoozed = await link({ why: null });
    const kept = await link({ why: null });
    const digest = await getDigest(
      deps({
        store: racing(async () => {
          await store.update(OWNER, filled.id, { why: { text: "now", source: "asked" } });
          await store.update(OWNER, snoozed.id, { snoozedUntil: at(DAY) });
        }),
      }),
      OWNER,
    );
    expect(digest.links.map((l) => l.link.id)).toEqual([kept.id]);
    expect([...digest.claimed].sort()).toEqual([filled.id, kept.id].sort());
  });

  it("claims the still-using check's link even when the check is then dropped", async () => {
    const tool = await link({ lastOpenedAt: at(-45 * DAY) });
    clock = at(-40 * DAY);
    await keepHandy(deps(), OWNER, tool.id, "stated");
    clock = NOW;
    const digest = await getDigest(
      deps({ store: racing(() => recordOpening(deps(), OWNER, tool.id)) }),
      OWNER,
    );
    expect(digest.links).toEqual([]);
    expect(digest.claimed).toEqual([tool.id]);
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toEqual(NOW);
  });

  it("leaves a still-using check skipped at its claim out of claimed", async () => {
    const tool = await link({ lastOpenedAt: at(-45 * DAY) });
    clock = at(-40 * DAY);
    await keepHandy(deps(), OWNER, tool.id, "stated");
    clock = NOW;
    const digest = await getDigest(deps({ store: racing(() => flag(tool.id)) }), OWNER);
    expect(digest.claimed).toEqual([]);
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });

  it("leaves out a link kept handy between selection and the claim, without marking it", async () => {
    const tool = await link({ why: null, savedAt: at(-100 * DAY), lastSurfacedAt: null });
    const other = await link({ why: null });
    const digest = await getDigest(
      deps({ store: racing(() => keepHandy(deps(), OWNER, tool.id, "stated")) }),
      OWNER,
    );
    expect(digest.links.map((l) => l.link.id)).toEqual([other.id]);
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toBeNull();
  });

  it("returns an empty digest for an empty library without searching", async () => {
    await focus("topic", at(-DAY));
    expect(await getDigest(deps(), OWNER)).toEqual({ links: [], claimed: [] });
    expect(keyword.calls).toEqual([]);
  });
});

describe("gone links (#128)", () => {
  it("leaves a gone link out of previewDigest and getDigest, unmarked, while a dead link not yet flagged keeps its reason", async () => {
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
    expect((await store.get(OWNER, gone.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });

  it("leaves out a link flagged between selection and the claim, without marking it", async () => {
    const goneLater = await link({ why: null });
    const other = await link({ why: null });
    const digest = await getDigest(deps({ store: racing(() => flag(goneLater.id)) }), OWNER);
    expect(digest.links.map((l) => l.link.id)).toEqual([other.id]);
    expect((await store.get(OWNER, goneLater.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });
});

describe("previewDigest", () => {
  /** A mix of focus, no-why, old and never-shown links, more than one digest holds. */
  async function library() {
    await focus("solar", at(-DAY));
    const focused = await link();
    keyword.hits.set("solar", [focused.id]);
    for (let i = 0; i < DIGEST_SIZE + 2; i++)
      await link({ why: null, savedAt: at(-(i + 2) * DAY) });
    await link({ lastSurfacedAt: null });
    await link({ savedAt: at(-60 * DAY) });
  }

  it("writes nothing, and picks what getDigest then returns, in its order and with its reasons", async () => {
    await library();
    const before = structuredClone(store.all(OWNER));
    const preview = await previewDigest(deps(), OWNER);
    expect(store.all(OWNER)).toEqual(before);
    expect(preview.links).toHaveLength(DIGEST_SIZE);
    const digest = await getDigest(deps(), OWNER);
    expect(preview.links.map((l) => [l.link.id, l.reasons])).toEqual(
      digest.links.map((l) => [l.link.id, l.reasons]),
    );
  });

  it("with a larger limit returns the same order, then the rest of the queue", async () => {
    await library();
    const first = (await previewDigest(deps(), OWNER)).links.map((l) => l.link.id);
    const all = (await previewDigest(deps(), OWNER, Number.POSITIVE_INFINITY)).links;
    expect(all.length).toBe(DIGEST_SIZE + 5);
    expect(all.slice(0, DIGEST_SIZE).map((l) => l.link.id)).toEqual(first);
  });
});

describe("kept tools", () => {
  it("gives a kept tool no reading reason and leaves it unmarked", async () => {
    const tool = await link({ why: null, savedAt: at(-60 * DAY), lastSurfacedAt: null });
    await focus("lunch", at(-DAY));
    keyword.hits.set("lunch", [tool.id]);
    await keepHandy(deps(), OWNER, tool.id, "stated");
    expect((await previewDigest(deps(), OWNER)).links).toEqual([]);
    expect((await getDigest(deps(), OWNER)).links).toEqual([]);
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toBeNull();
  });

  it("does not let a kept tool use up a focus entry's matches", async () => {
    const tool = await link();
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

  it("skips a gone tool, writing nothing (#128)", async () => {
    const tool = await dueLink();
    await flag(tool.id);
    expect(await dueTool(deps(), OWNER)).toBeNull();
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });

  it("claimDueTool drops a tool flagged between selection and claim, leaving it unmarked (#128)", async () => {
    const tool = await dueLink({ lastOpenedAt: at(-45 * DAY) });
    expect(await claimDueTool(deps({ store: racing(() => flag(tool.id)) }), OWNER)).toBeNull();
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });

  it("claimDueTool drops a tool flagged gone after its claim succeeded, leaving it marked (#128)", async () => {
    const tool = await dueLink({ lastOpenedAt: at(-45 * DAY) });
    const flaggedAfterClaim = Object.assign(Object.create(store) as FakeStore, {
      claimSurfaced: async (...args: Parameters<LinkStore["claimSurfaced"]>) => {
        const claimed = await store.claimSurfaced(...args);
        await flag(tool.id);
        return claimed;
      },
    });
    expect(await claimDueTool(deps({ store: flaggedAfterClaim }), OWNER)).toBeNull();
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toEqual(NOW);
  });

  it("returns one due tool, first in the digest's rotation, with whole days since its opening", async () => {
    await dueLink({ lastSurfacedAt: null });
    const first = await dueLink({ lastOpenedAt: at(-45 * DAY - HOUR) });
    expect(await dueTool(deps(), OWNER)).toEqual({
      link: await store.get(OWNER, first.id),
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

  it("skips a due tool surfaced within the cooldown, snoozed or archived, and writes nothing", async () => {
    const recent = await dueLink({ lastSurfacedAt: at(-DAY) });
    await dueLink({ snoozedUntil: at(DAY) });
    await dueLink({ state: "archived" });
    expect(await dueTool(deps(), OWNER)).toBeNull();
    expect((await store.get(OWNER, recent.id))?.lastSurfacedAt).toEqual(at(-DAY));
    const ready = await dueLink({ lastSurfacedAt: CUTOFF });
    expect((await dueTool(deps(), OWNER))?.link.id).toBe(ready.id);
  });

  it("claimDueTool claims the due tool, marking it surfaced", async () => {
    const tool = await dueLink({ lastOpenedAt: at(-45 * DAY) });
    expect(await claimDueTool(deps(), OWNER)).toEqual({
      link: await store.get(OWNER, tool.id),
      daysSinceOpened: 45,
    });
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toEqual(NOW);
    expect(await claimDueTool(deps(), OWNER)).toBeNull();
  });

  it.each([
    ["an opening", (id: string) => recordOpening(deps(), OWNER, id)],
    ["Not handy anymore", (id: string) => notHandy(deps(), OWNER, id, "stated")],
    ["a Still using answer", (id: string) => stillUsing(deps(), OWNER, id, "stated")],
  ])(
    "claimDueTool drops a tool %s made not due between selection and claim, leaving it marked",
    async (_, meanwhile) => {
      const tool = await dueLink({ lastOpenedAt: at(-45 * DAY) });
      expect(
        await claimDueTool(deps({ store: racing(() => meanwhile(tool.id)) }), OWNER),
      ).toBeNull();
      expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toEqual(NOW);
    },
  );
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

  it("adds the due tool last, as its own item with whole days since its opening, and marks it surfaced", async () => {
    const reading = await link({ why: null });
    const tool = await due({ lastOpenedAt: at(-45 * DAY - HOUR) });
    expect(await shown()).toEqual([
      [reading.id, [{ kind: "no_why" }]],
      [tool.id, [check(45)]],
    ]);
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toEqual(NOW);
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

  it("holds at most one check, leaving a second due tool unmarked", async () => {
    const first = await due();
    const second = await due();
    expect(await shown()).toEqual([[first.id, [check(null)]]]);
    expect((await store.get(OWNER, second.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });

  it("takes one of the DIGEST_SIZE slots: the reading link it displaces is neither returned nor marked", async () => {
    const reading: Link[] = [];
    for (let i = 0; i < DIGEST_SIZE; i++) reading.push(await link({ why: null }));
    const tool = await due();
    const digest = await getDigest(deps(), OWNER);
    expect(digest.links.map((d) => d.link.id)).toEqual([
      ...reading.slice(0, DIGEST_SIZE - 1).map((l) => l.id),
      tool.id,
    ]);
    const displaced = reading[DIGEST_SIZE - 1] as Link;
    expect((await store.get(OWNER, displaced.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });

  it("frees its slot when the tool is no longer due once claimed, leaving the tool marked", async () => {
    const reading: Link[] = [];
    for (let i = 0; i < DIGEST_SIZE; i++) reading.push(await link({ why: null }));
    const tool = await due();
    const digest = await getDigest(
      deps({ store: racing(() => recordOpening(deps(), OWNER, tool.id)) }),
      OWNER,
    );
    expect(digest.links.map((d) => d.link.id)).toEqual(reading.map((l) => l.id));
    expect((await store.get(OWNER, tool.id))?.lastSurfacedAt).toEqual(NOW);
  });

  it("uses the digest's cooldown: no check again until SURFACE_COOLDOWN_MS after it was shown", async () => {
    const tool = await due();
    await getDigest(deps(), OWNER);
    clock = at(SURFACE_COOLDOWN_MS - 1);
    expect(await shown()).toEqual([]);
    clock = at(SURFACE_COOLDOWN_MS);
    expect(await shown()).toEqual([[tool.id, [check(null)]]]);
  });

  it("previewDigest leaves the check out and writes nothing", async () => {
    const reading = await link({ why: null });
    await due();
    const before = structuredClone(store.all(OWNER));
    expect((await previewDigest(deps(), OWNER)).links.map((d) => d.link.id)).toEqual([reading.id]);
    expect(store.all(OWNER)).toEqual(before);
  });
});

describe("came back", () => {
  const AWAY = at(-3 * DAY);
  const cameBack = (entry: FocusEntry, putAwayAt = AWAY): DigestReason => ({
    kind: "came_back",
    focus: entry,
    putAwayAt,
  });
  /** A put-away link: archived with its marker, surfaced (if ever) before it was put away. */
  const away = (over: Partial<NewLink> = {}) =>
    link({ state: "archived", putAwayAt: AWAY, lastSurfacedAt: null, ...over });
  const previewed = async () => (await previewDigest(deps(), OWNER)).links;
  const previewIds = async () => (await previewed()).map((d) => d.link.id);

  it("gives a link put away before a matching focus entry a came_back reason carrying the entry and the marker", async () => {
    const l = await away();
    const entry = await focus("solar", at(-DAY), "inferred");
    keyword.hits.set("solar", [l.id]);
    expect(await reasonsOf(l.id)).toEqual([cameBack(entry), { kind: "never_surfaced" }]);
  });

  it("asks for put-away links only, across the whole library, and marks the link surfaced at now", async () => {
    const l = await away();
    await link();
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", [l.id]);
    await getDigest(deps(), OWNER);
    expect(keyword.calls).toContainEqual({
      query: "solar",
      filters: { state: "archived" },
      limit: 2,
      traced: false,
    });
    expect((await store.get(OWNER, l.id))?.lastSurfacedAt).toEqual(NOW);
  });

  it("does not search the archive when nothing is put away", async () => {
    await link({ state: "archived" });
    await focus("solar", at(-DAY));
    await previewIds();
    expect(keyword.calls).toEqual([]);
  });

  it("does not bring back a link put away after the matching entry was written", async () => {
    const l = await away({ putAwayAt: at(-HOUR) });
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", [l.id]);
    expect(await previewIds()).toEqual([]);
    await focus("wind", at(-HOUR + 1));
    keyword.hits.set("wind", [l.id]);
    expect(await previewIds()).toEqual([l.id]);
  });

  it("does not bring back a stale link that shares the words", async () => {
    const stale = await link({ state: "archived", putAwayAt: null });
    const active = await link();
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", [stale.id, active.id]);
    expect(await previewIds()).toEqual([active.id]);
  });

  it("brings back a put-away kept tool, but not a put-away gone link", async () => {
    const tool = await away();
    const gone = await away();
    await keepHandy(deps(), OWNER, tool.id, "stated");
    await flag(gone.id);
    const entry = await focus("solar", at(-DAY));
    keyword.hits.set("solar", [gone.id, tool.id]);
    expect(await previewIds()).toEqual([tool.id]);
    const digest = await getDigest(deps(), OWNER);
    expect(digest.links.map((d) => d.link.id)).toEqual([tool.id]);
    expect(digest.links[0]?.reasons[0]).toEqual(cameBack(entry));
    expect((await store.get(OWNER, gone.id))?.lastSurfacedAt).toBeNull();
  });

  it("stays out while snoozed", async () => {
    const l = await away({ snoozedUntil: at(DAY) });
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", [l.id]);
    expect(await previewIds()).toEqual([]);
  });

  it("is offered when it was last surfaced before it was put away, even inside the cooldown", async () => {
    const l = await away({ lastSurfacedAt: at(-4 * DAY) });
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", [l.id]);
    expect(await previewIds()).toEqual([l.id]);
  });

  it("is left alone for the cooldown once surfaced since it was put away", async () => {
    const l = await away();
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", [l.id]);
    expect(await digestIds()).toEqual([l.id]);
    clock = at(SURFACE_COOLDOWN_MS - 1);
    expect(await previewIds()).toEqual([]);
    clock = at(SURFACE_COOLDOWN_MS);
    expect(await previewIds()).toEqual([l.id]);
  });

  it("offers three of five matches, and different three on different days", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await away()).id);
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", ids);
    const offered = new Set<string>();
    for (let day = 0; day < 8; day++) {
      clock = at(day * DAY);
      const picks = await previewIds();
      expect(picks).toHaveLength(FOCUS_MATCHES_PER_ENTRY);
      offered.add([...picks].sort().join());
    }
    expect(offered.size).toBeGreaterThan(1);
  });

  it("offers nothing once the focus entry leaves the window", async () => {
    const l = await away({ putAwayAt: at(-40 * DAY) });
    await focus("solar", at(-FOCUS_WINDOW_MS - 1));
    keyword.hits.set("solar", [l.id]);
    expect(await previewIds()).toEqual([]);
  });

  it("finds a put-away link ranked behind stale matches", async () => {
    const outranking = [];
    for (let i = 0; i < 3; i++) outranking.push(await link({ state: "archived", putAwayAt: null }));
    const l = await away();
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", [...outranking.map((o) => o.id), l.id]);
    expect(await previewIds()).toEqual([l.id]);
  });

  it("matches on the next build once the search finds the link, as a summary added later makes it", async () => {
    const l = await away();
    await focus("solar", at(-DAY));
    expect(await previewIds()).toEqual([]);
    keyword.hits.set("solar", [l.id]);
    expect(await previewIds()).toEqual([l.id]);
  });

  it("takes the focus slots ahead of focus_words links", async () => {
    const reading = [];
    for (let i = 0; i < FOCUS_SLOTS; i++) reading.push(await link());
    const back = await away();
    await focus("older", at(-2 * DAY));
    await focus("newer", at(-DAY));
    keyword.hits.set(
      "newer",
      reading.map((r) => r.id),
    );
    keyword.hits.set("older", [back.id]);
    expect((await previewIds()).slice(0, FOCUS_SLOTS)).toEqual([
      back.id,
      ...reading.slice(0, FOCUS_SLOTS - 1).map((r) => r.id),
    ]);
  });

  it("never offers another owner's put-away link", async () => {
    const theirs = (
      await store.insertIfAbsent("other", {
        url: "https://ex.com/theirs",
        urlKey: "https://ex.com/theirs",
        title: null,
        summary: null,
        why: null,
        tags: [],
        savedAt: at(-DAY),
        savedBy: "t",
        lastOpenedAt: null,
        putAwayAt: AWAY,
        tidyKeptAt: null,
        lastSurfacedAt: null,
        snoozedUntil: null,
        state: "archived",
      })
    ).link;
    await focus("solar", at(-DAY));
    keyword.hits.set("solar", [theirs.id]);
    expect(await previewIds()).toEqual([]);
    expect((await getDigest(deps(), OWNER)).claimed).toEqual([]);
    expect((await store.get("other", theirs.id))?.lastSurfacedAt).toBeNull();
  });

  describe("claiming", () => {
    it("applies with the selected marker", async () => {
      const l = await away();
      const claimed = await claimSurfaced(deps(), OWNER, [l.id], { putAwayAt: AWAY });
      expect(claimed.map((c) => c.link.id)).toEqual([l.id]);
      expect((await store.get(OWNER, l.id))?.lastSurfacedAt).toEqual(NOW);
    });

    it("does not apply after Bring it back and putting it away again between selection and claim", async () => {
      clock = AWAY;
      const l = await link({ lastSurfacedAt: null });
      await putAwayLink(deps(), OWNER, l.id);
      clock = NOW;
      await focus("solar", at(-DAY));
      keyword.hits.set("solar", [l.id]);
      const racingStore = racing(async () => {
        await bringBackLink(deps(), OWNER, l.id);
        clock = at(-HOUR);
        await putAwayLink(deps(), OWNER, l.id);
        clock = NOW;
      });
      const digest = await getDigest(deps({ store: racingStore }), OWNER);
      expect(digest.links).toEqual([]);
      expect(digest.claimed).toEqual([]);
      expect((await store.get(OWNER, l.id))?.lastSurfacedAt).toBeNull();
    });
  });
});
