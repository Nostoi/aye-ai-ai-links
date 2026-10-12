import { beforeEach, describe, expect, it } from "vitest";
import {
  compareIds,
  DIGEST_SIZE,
  type DigestReason,
  FOCUS_MATCHES_PER_ENTRY,
  FOCUS_SLOTS,
  FOCUS_WINDOW_MS,
  getDigest,
  NOT_OPENED_MS,
  SURFACE_COOLDOWN_MS,
} from "./digest.js";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import type { LinkSearch, SearchFilters, SearchTrace } from "./search.js";
import type { LinkStore } from "./store.js";
import type { FocusEntry, Link, NewLink, Source } from "./types.js";

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
    { writtenBy: "agent", at: created, focusLimit: 100 },
  );
  if (!result.ok) throw new Error("the focus entry was not added");
  return result.recentFocus.find((f) => f.text === text) as FocusEntry;
}

const digestIds = async () => (await getDigest(deps(), OWNER)).links.map((l) => l.link.id);
const reasonsOf = async (id: string) =>
  (await getDigest(deps(), OWNER)).links.find((l) => l.link.id === id)?.reasons;
const focusWords = (entry: FocusEntry): DigestReason => ({ kind: "focus_words", focus: entry });

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

  it("orders other links by last surfaced (never first), then oldest saved, then id, and keeps 5", async () => {
    const s = await link({ why: null, savedAt: at(-10 * DAY) });
    const q = await link({ why: null, savedAt: at(-DAY), lastSurfacedAt: null });
    const u = await link({ why: null, savedAt: at(-3 * DAY), lastSurfacedAt: null });
    const p = await link({ why: null, savedAt: at(-20 * DAY), lastSurfacedAt: at(-20 * DAY) });
    const t = await link({ why: null, savedAt: at(-3 * DAY), lastSurfacedAt: null });
    const r = await link({ why: null, savedAt: at(-5 * DAY), lastSurfacedAt: null });
    expect(await digestIds()).toEqual([r.id, u.id, t.id, q.id, p.id]);
    expect((await store.get(OWNER, s.id))?.lastSurfacedAt).toEqual(CUTOFF);
  });

  it("holds FOCUS_SLOTS focus picks, then rotation links, when focus matches outnumber the slots", async () => {
    const newerHits = [await link(), await link(), await link()];
    const olderHits = [await link(), await link(), await link()];
    const rotating = [];
    for (let i = 0; i < 3; i++) rotating.push(await link({ why: null, lastSurfacedAt: null }));
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
});

describe("getDigest claim", () => {
  /** Runs `meanwhile` after selection and before the claim reaches the store. */
  const racing = (meanwhile: () => Promise<unknown>): LinkStore =>
    Object.assign(Object.create(store) as FakeStore, {
      claimSurfaced: async (...args: Parameters<LinkStore["claimSurfaced"]>) => {
        await meanwhile();
        return store.claimSurfaced(...args);
      },
    });

  it("judges reasons from the claimed link, dropping one left with none and skipping one snoozed", async () => {
    const filled = await link({ why: null });
    const halfFilled = await link({ why: null, lastSurfacedAt: null });
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

  it("returns an empty digest for an empty library without searching", async () => {
    await focus("topic", at(-DAY));
    expect(await getDigest(deps(), OWNER)).toEqual({ links: [] });
    expect(keyword.calls).toEqual([]);
  });
});
