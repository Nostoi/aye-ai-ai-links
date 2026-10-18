import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  compareIds,
  DIGEST_SIZE,
  getDigest,
  previewDigest,
  SURFACE_COOLDOWN_MS,
} from "./digest.js";
import type { CoreError } from "./errors.js";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import type { LinkSearch } from "./search.js";
import type { SearchLog } from "./search-log.js";
import { answerSuggestion, keepHandy, listSuggestions, type ToolItem } from "./tools.js";
import type { Link, NewLink } from "./types.js";
import {
  archiveLink,
  markOpened,
  SNOOZE_MS,
  snoozeLink,
  tellWhy,
  unarchiveLink,
  unsnoozeLink,
  WORTH_SIZE,
  worthALook,
} from "./worth-a-look.js";

const A = "a";
const B = "b";
const DAY = 86_400_000;
const NOW = new Date("2026-10-14T09:00:00Z");
const at = (delta: number) => new Date(NOW.getTime() + delta);

let hits: Map<string, string[]>;
const keyword: LinkSearch = { search: async (_owner, query) => hits.get(query) ?? [] };

/** Records every call, so a test can show nothing was logged. */
class SpySearchLog implements SearchLog {
  calls: string[] = [];
  async record() {
    this.calls.push("record");
  }
  async pairOpen() {
    this.calls.push("pairOpen");
  }
}

let store: FakeStore;
let profile: FakeProfileStore;
let clock: Date;
let searchLog: SpySearchLog;
const deps = () => ({
  store,
  tools: store,
  checks: store,
  profile,
  keywordSearch: keyword,
  searchLog,
  now: () => clock,
});

beforeEach(() => {
  store = new FakeStore();
  profile = new FakeProfileStore();
  hits = new Map();
  clock = NOW;
  searchLog = new SpySearchLog();
});

let n = 0;
/** A link with no why, never surfaced: eligible, with reasons. */
async function link(owner = A, over: Partial<NewLink> = {}): Promise<Link> {
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
      savedAt: at(-(n + 1) * DAY),
      savedBy: "t",
      lastOpenedAt: null,
      lastSurfacedAt: null,
      snoozedUntil: null,
      state: "active",
      ...over,
    })
  ).link;
}

/** A focus entry the owner gave, whose keyword search finds `found`. */
async function focus(text: string, created: Date, found: string[]): Promise<void> {
  await profile.apply(
    A,
    { addNotes: [], editNotes: [], removeNotes: [], addFocus: [{ text, source: "stated" }] },
    { writtenBy: "agent", at: created, focusLimit: 100, purgeBefore: new Date(0) },
  );
  hits.set(text, found);
}

const get = async (id: string, owner = A) => (await store.get(owner, id)) as Link;
const picked = async () => worthALook(deps(), A, await listSuggestions(deps(), A));
const ids = async () => (await picked()).links.map((d) => d.link.id);

/** Flags the link as gone, first flagged at `flaggedAt`. */
const flagGone = (id: string, flaggedAt: Date) =>
  store.updateCheckIf(A, id, null, {
    checkedAt: flaggedAt,
    result: "dead",
    detail: "http:404",
    firstDeadAt: new Date(flaggedAt.getTime() - 7 * DAY),
    flaggedAt,
    stillWorksAt: null,
  });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as CoreError).code;
  }
  return "no error";
}

describe("worthALook's gone pick (#128)", () => {
  it("is the earliest flagged link, and the lowest id on a tie", async () => {
    const late = await link();
    const early = await link();
    await flagGone(late.id, at(-2 * DAY));
    await flagGone(early.id, at(-9 * DAY));
    expect((await picked()).gone?.id).toBe(early.id);
    const tied = [await link(), await link()];
    for (const l of tied) await flagGone(l.id, at(-20 * DAY));
    expect((await picked()).gone?.id).toBe(tied.map((l) => l.id).sort(compareIds)[0]);
  });

  it("takes a slot: three reading candidates and a gone link give two reading links and the gone one", async () => {
    await link();
    await link();
    await link();
    const gone = await link();
    await flagGone(gone.id, at(-DAY));
    const { links, gone: pick } = await picked();
    expect(links).toHaveLength(WORTH_SIZE - 1);
    expect(pick?.id).toBe(gone.id);
    expect(links.map((d) => d.link.id)).not.toContain(gone.id);
  });

  it("is never an archived, snoozed or kept-tool link", async () => {
    const archived = await link(A, { state: "archived" });
    const snoozed = await link(A, { snoozedUntil: at(DAY) });
    const kept = await link();
    await keepHandy(deps(), A, kept.id, "stated");
    for (const l of [archived, snoozed, kept]) await flagGone(l.id, at(-9 * DAY));
    expect((await picked()).gone).toBeNull();
    const ok = await link();
    await flagGone(ok.id, at(-DAY));
    expect((await picked()).gone?.id).toBe(ok.id);
  });

  it("picks a link whose snooze has ended", async () => {
    const over = await link(A, { snoozedUntil: at(-DAY) });
    await flagGone(over.id, at(-DAY));
    expect((await picked()).gone?.id).toBe(over.id);
  });

  it("writes nothing", async () => {
    const gone = await link();
    await link();
    await flagGone(gone.id, at(-DAY));
    const rows = async () =>
      structuredClone([
        await store.listLinks(A),
        [...(await store.listChecks(A))],
        [...(await store.listTools(A))],
      ]);
    const before = await rows();
    await picked();
    expect(await rows()).toEqual(before);
  });

  it("is null, and the reading picks fill all slots, with no gone link", async () => {
    for (let i = 0; i < 4; i++) await link();
    const { links, gone } = await picked();
    expect(gone).toBeNull();
    expect(links).toHaveLength(WORTH_SIZE);
  });
});

describe("worthALook", () => {
  it("leaves a gone link out of its reading picks (#128)", async () => {
    const gone = await link();
    const other = await link();
    await store.updateCheckIf(A, gone.id, null, {
      checkedAt: at(-DAY),
      result: "dead",
      detail: "http:404",
      firstDeadAt: at(-8 * DAY),
      flaggedAt: at(-DAY),
      stillWorksAt: null,
    });
    expect(await ids()).toEqual([other.id]);
    expect((await picked()).gone?.id).toBe(gone.id);
  });

  it("leaves out a kept tool, even one that matches the focus", async () => {
    const tool = await link();
    const other = await link();
    await focus("lunch", at(-DAY), [tool.id]);
    await keepHandy(deps(), A, tool.id, "stated");
    expect(await ids()).toEqual([other.id]);
  });

  it("leaves out a due tool, which the shelf shows instead, even one that matches the focus", async () => {
    const tool = await link();
    const other = await link();
    await focus("lunch", at(-DAY), [tool.id]);
    clock = at(-40 * DAY);
    await keepHandy(deps(), A, tool.id, "stated");
    clock = NOW;
    expect(await ids()).toEqual([other.id]);
    expect((await get(tool.id)).lastSurfacedAt).toBeNull();
  });

  it("leaves out a shown suggestion, and another link takes its place", async () => {
    const suggested = await link();
    const others = [await link(), await link(), await link()];
    await keepHandy(deps(), A, suggested.id, "inferred");
    const picks = await ids();
    expect(picks).not.toContain(suggested.id);
    expect(picks).toHaveLength(WORTH_SIZE);
    expect(others.map((o) => o.id)).toEqual(expect.arrayContaining(picks));
  });

  it("leaves out a shown suggestion even when it matches the focus", async () => {
    const suggested = await link();
    const other = await link();
    await focus("lunch", at(-DAY), [suggested.id]);
    await keepHandy(deps(), A, suggested.id, "inferred");
    expect(await ids()).toEqual([other.id]);
  });

  it("gives focus matches to the links that are shown, not to the suggestions the shelf shows", async () => {
    const suggested = [await link(), await link(), await link()];
    const ordinary = await link(A, {
      why: { text: "x", source: "stated" },
      lastOpenedAt: at(-DAY),
      lastSurfacedAt: at(-20 * DAY),
      savedAt: at(-2 * DAY),
    });
    const [oldest, middle, newest] = suggested as [Link, Link, Link];
    await focus("lunch", at(-DAY), [newest.id, middle.id, oldest.id, ordinary.id]);
    for (const [i, s] of [oldest, middle, newest].entries()) {
      clock = at(-(3 - i) * DAY);
      await keepHandy(deps(), A, s.id, "inferred");
    }
    clock = NOW;
    const { links: picks } = await picked();
    expect(picks.map((d) => d.link.id).sort()).toEqual([oldest.id, ordinary.id].sort());
    for (const d of picks) expect(d.reasons.map((r) => r.kind)).toContain("focus_words");
  });

  it("shows a suggestion past the shelf's two in Worth a look, and not the two shown", async () => {
    const [oldest, middle, newest] = [await link(), await link(), await link()];
    for (const [i, s] of [oldest, middle, newest].entries()) {
      clock = at(-(3 - i) * DAY);
      await keepHandy(deps(), A, s.id, "inferred");
    }
    clock = NOW;
    expect(await ids()).toEqual([oldest.id]);
  });

  it("leaves out exactly the suggestions it is given, not a fresh read of them", async () => {
    const suggested: Link[] = [];
    for (let i = 0; i < 3; i++) {
      suggested.push(await link());
      clock = at(-(3 - i) * DAY);
      await keepHandy(deps(), A, (suggested[i] as Link).id, "inferred");
    }
    clock = NOW;
    const [oldest, , newest] = suggested as [Link, Link, Link];
    // The caller's list: the middle and oldest tools, though a fresh read would give newest and middle.
    const [, middleItem] = await listSuggestions(deps(), A);
    const shown = [middleItem as ToolItem, { ...(middleItem as ToolItem), link: oldest }];
    const { links: picks } = await worthALook(deps(), A, shown);
    expect(picks.map((d) => d.link.id)).toEqual([newest.id]);
  });

  it("brings a suggested tool back once it is declined", async () => {
    const suggested = await link();
    await link();
    await keepHandy(deps(), A, suggested.id, "inferred");
    expect(await ids()).not.toContain(suggested.id);
    await answerSuggestion(deps(), A, suggested.id, false);
    expect(await ids()).toContain(suggested.id);
  });

  it("leaves a suggested tool in the digest preview", async () => {
    const suggested = await link();
    await keepHandy(deps(), A, suggested.id, "inferred");
    const { links } = await previewDigest(deps(), A, Number.POSITIVE_INFINITY);
    expect(links.map((d) => d.link.id)).toContain(suggested.id);
  });

  it("shows the same three picks all day, writing nothing", async () => {
    for (let i = 0; i < DIGEST_SIZE + 3; i++) await link();
    const before = structuredClone(store.all(A));
    const morning = await ids();
    clock = new Date("2026-10-14T23:59:59.999Z");
    expect(await ids()).toEqual(morning);
    expect(morning).toHaveLength(WORTH_SIZE);
    expect(store.all(A)).toEqual(before);
  });

  it("keeps the other picks in place when one is put off, opened or archived, or a link is saved", async () => {
    for (let i = 0; i < DIGEST_SIZE + 3; i++) await link();
    for (const act of [
      (id: string) => snoozeLink(deps(), A, id),
      (id: string) => markOpened(deps(), A, id),
      (id: string) => archiveLink(deps(), A, id),
    ]) {
      const [first, ...rest] = await ids();
      await act(first as string);
      expect(await ids()).toEqual(expect.arrayContaining(rest));
    }
    const before = await ids();
    await link();
    expect((await ids()).filter((id) => before.includes(id)).length).toBeGreaterThanOrEqual(2);
  });

  it("shows other picks on another day, from the whole queue, not only one digest's worth", async () => {
    for (let i = 0; i < DIGEST_SIZE + 3; i++) await link();
    const seen = new Set<string>();
    const days: string[][] = [];
    // A daily shuffle: over 60 days every link of eight comes up (a miss is about 1 in 10^12).
    for (let d = 0; d < 60; d++) {
      clock = at(d * DAY);
      days.push(await ids());
      for (const id of days.at(-1) ?? []) seen.add(id);
    }
    expect(days.slice(1, 8).some((day) => day.join() !== days[0]?.join())).toBe(true);
    expect(seen.size).toBe(DIGEST_SIZE + 3);
  });

  it("leads with the queue's first focus match every day, the other two from the day's shuffle", async () => {
    const all: Link[] = [];
    for (let i = 0; i < DIGEST_SIZE + 3; i++) all.push(await link());
    const [older, newer, also] = all.slice(-3) as [Link, Link, Link];
    await focus("older", at(-2 * DAY), [older.id]);
    await focus("newer", at(-DAY), [newer.id, also.id]);
    for (let d = 0; d < 10; d++) {
      clock = at(d * DAY);
      const picks = await ids();
      expect(picks[0]).toBe(newer.id);
      expect(new Set(picks).size).toBe(WORTH_SIZE);
    }
  });

  it("with no focus match, leads with the day's shuffle first, not the queue's first", async () => {
    const all: Link[] = [];
    for (let i = 0; i < DIGEST_SIZE + 3; i++) all.push(await link());
    const rank = (day: number, id: string) =>
      createHash("sha256").update(`${day}:${id}`).digest("hex");
    for (let d = 0; d < 10; d++) {
      clock = at(d * DAY);
      const day = Math.floor(clock.getTime() / DAY);
      const shuffled = all.map((l) => l.id).sort((x, y) => (rank(day, x) < rank(day, y) ? -1 : 1));
      expect((await ids())[0]).toBe(shuffled[0]);
    }
  });

  it("when the lead goes, the next focus match leads, else the shuffle's first, and the other picks stay", async () => {
    const all: Link[] = [];
    for (let i = 0; i < DIGEST_SIZE + 3; i++) all.push(await link());
    const [first, second] = all.slice(-2) as [Link, Link];
    await focus("topic", at(-DAY), [first.id, second.id]);
    const [lead, ...rest] = await ids();
    expect(lead).toBe(first.id);
    await snoozeLink(deps(), A, first.id);
    const [nextLead, ...nextRest] = await ids();
    expect(nextLead).toBe(second.id);
    expect(nextRest).toEqual(expect.arrayContaining(rest.filter((id) => id !== second.id)));
    await archiveLink(deps(), A, second.id);
    expect(await ids()).toEqual(expect.arrayContaining(nextRest));
  });

  it("shows every eligible link when there are fewer than three, and none when nothing is due", async () => {
    expect(await ids()).toEqual([]);
    const only = await link();
    await link(A, { state: "archived" });
    expect(await ids()).toEqual([only.id]);
  });
});

describe("markOpened", () => {
  it("records the opening and marks it surfaced, so home leaves it out for two weeks", async () => {
    const l = await link();
    await markOpened(deps(), A, l.id);
    expect(await get(l.id)).toMatchObject({ lastOpenedAt: NOW, lastSurfacedAt: NOW });
    clock = at(SURFACE_COOLDOWN_MS - 1);
    expect(await ids()).not.toContain(l.id);
    clock = at(SURFACE_COOLDOWN_MS);
    expect(await ids()).toContain(l.id);
  });

  it("records the opening and the surfacing at one instant, though the clock moves", async () => {
    const l = await link();
    let tick = 0;
    await markOpened({ ...deps(), now: () => at(tick++) }, A, l.id);
    const after = await get(l.id);
    expect(after.lastSurfacedAt).toEqual(after.lastOpenedAt);
  });

  it("writes no search log row", async () => {
    const l = await link();
    await markOpened(deps(), A, l.id);
    expect(searchLog.calls).toEqual([]);
  });

  it("records the opening of a link an agent's digest already marked, leaving that mark", async () => {
    const l = await link(A, { lastSurfacedAt: at(-DAY) });
    await markOpened(deps(), A, l.id);
    expect(await get(l.id)).toMatchObject({ lastOpenedAt: NOW, lastSurfacedAt: at(-DAY) });
  });

  it("refuses another owner's link as not found, changing nothing", async () => {
    const theirs = await link(B);
    const before = structuredClone(store.all(B));
    expect(await code(markOpened(deps(), A, theirs.id))).toBe("not_found");
    expect(store.all(B)).toEqual(before);
  });
});

describe("Not now", () => {
  it("marks the link surfaced and snoozes it for two weeks, returning when the snooze ends", async () => {
    const l = await link();
    const { until } = await snoozeLink(deps(), A, l.id);
    expect(until).toEqual(at(SNOOZE_MS));
    expect(SNOOZE_MS).toBe(14 * DAY);
    expect(await get(l.id)).toMatchObject({ lastSurfacedAt: NOW, snoozedUntil: at(SNOOZE_MS) });
  });

  it("marks and snoozes from one instant, though the clock moves while it runs", async () => {
    const l = await link();
    let tick = 0;
    const { until } = await snoozeLink({ ...deps(), now: () => at(tick++) }, A, l.id);
    const after = await get(l.id);
    expect(after.snoozedUntil).toEqual(until);
    expect(until.getTime() - (after.lastSurfacedAt as Date).getTime()).toBe(SNOOZE_MS);
  });

  it("will not override a snooze an AI set after the page was shown: a conflict, nothing written", async () => {
    const l = await link();
    await store.update(A, l.id, { snoozedUntil: at(3 * DAY) });
    const before = await get(l.id);
    expect(await code(snoozeLink(deps(), A, l.id))).toBe("conflict");
    expect(await get(l.id)).toEqual(before);
  });

  it("will not override an AI's snooze written after its read: a conflict, the AI's value kept", async () => {
    const l = await link();
    const racing = Object.create(store) as FakeStore;
    racing.get = async (owner, id) => {
      const read = await store.get(owner, id);
      await store.update(A, l.id, { snoozedUntil: at(3 * DAY) });
      return read;
    };
    expect(await code(snoozeLink({ ...deps(), store: racing }, A, l.id))).toBe("conflict");
    expect(await get(l.id)).toMatchObject({ snoozedUntil: at(3 * DAY), lastSurfacedAt: null });
  });

  it("will not put off a link an AI archived after the page was shown: a conflict, nothing written", async () => {
    const l = await link();
    await store.update(A, l.id, { state: "archived" });
    const before = await get(l.id);
    expect(await code(snoozeLink(deps(), A, l.id))).toBe("conflict");
    expect(await get(l.id)).toEqual(before);
  });

  it("will not put off a link an AI archived after its read: a conflict, nothing written", async () => {
    const l = await link();
    const racing = Object.create(store) as FakeStore;
    racing.get = async (owner, id) => {
      const read = await store.get(owner, id);
      await store.update(A, l.id, { state: "archived" });
      return read;
    };
    expect(await code(snoozeLink({ ...deps(), store: racing }, A, l.id))).toBe("conflict");
    expect(await get(l.id)).toMatchObject({ snoozedUntil: null, lastSurfacedAt: null });
  });

  it("will not put off a link an AI archived after its claim: a conflict, the claim taken back", async () => {
    const l = await link(A, { lastSurfacedAt: at(-SURFACE_COOLDOWN_MS) });
    const racing = Object.create(store) as FakeStore;
    racing.claimSurfaced = async (owner, ids, when) => {
      const claimed = await store.claimSurfaced(owner, ids, when);
      await store.update(A, l.id, { state: "archived" });
      return claimed;
    };
    expect(await code(snoozeLink({ ...deps(), store: racing }, A, l.id))).toBe("conflict");
    expect(await get(l.id)).toMatchObject({
      snoozedUntil: null,
      lastSurfacedAt: at(-SURFACE_COOLDOWN_MS),
    });
  });

  it("puts off a link whose earlier snooze has ended", async () => {
    const l = await link(A, { snoozedUntil: NOW });
    await snoozeLink(deps(), A, l.id);
    expect((await get(l.id)).snoozedUntil).toEqual(at(SNOOZE_MS));
  });

  it("answers the claim it made and the value it replaced, which undo sends back", async () => {
    const l = await link(A, { lastSurfacedAt: at(-SURFACE_COOLDOWN_MS) });
    expect(await snoozeLink(deps(), A, l.id)).toEqual({
      until: at(SNOOZE_MS),
      claimedAt: NOW,
      previousSurfacedAt: at(-SURFACE_COOLDOWN_MS),
    });
  });

  it("undo clears the snooze and the claim it set: the link is back on home and in a digest at once", async () => {
    const l = await link();
    const snooze = await snoozeLink(deps(), A, l.id);
    await unsnoozeLink(deps(), A, l.id, structuredClone(snooze));
    expect(await get(l.id)).toMatchObject({ snoozedUntil: null, lastSurfacedAt: null });
    expect(await ids()).toContain(l.id);
    expect((await getDigest(deps(), A)).links.map((d) => d.link.id)).toContain(l.id);
  });

  it("undo puts back the surfacing the claim replaced", async () => {
    const l = await link(A, { lastSurfacedAt: at(-SURFACE_COOLDOWN_MS) });
    await unsnoozeLink(deps(), A, l.id, await snoozeLink(deps(), A, l.id));
    expect((await get(l.id)).lastSurfacedAt).toEqual(at(-SURFACE_COOLDOWN_MS));
  });

  it("undo after an AI changed the snooze is a conflict, leaves the AI's value, and still takes back its claim", async () => {
    const l = await link();
    const snooze = await snoozeLink(deps(), A, l.id);
    await store.update(A, l.id, { snoozedUntil: at(3 * DAY) });
    expect(await code(unsnoozeLink(deps(), A, l.id, snooze))).toBe("conflict");
    expect(await get(l.id)).toMatchObject({ snoozedUntil: at(3 * DAY), lastSurfacedAt: null });
  });

  it("undo after an agent's digest claimed the link clears the snooze and leaves the agent's claim", async () => {
    const l = await link();
    const snooze = await snoozeLink(deps(), A, l.id);
    clock = snooze.until;
    expect((await getDigest(deps(), A)).links.map((d) => d.link.id)).toEqual([l.id]);
    await unsnoozeLink(deps(), A, l.id, snooze);
    expect(await get(l.id)).toMatchObject({ snoozedUntil: null, lastSurfacedAt: snooze.until });
  });

  it("undo refuses a replaced value that is not before the claim, writing nothing", async () => {
    const l = await link();
    const snooze = await snoozeLink(deps(), A, l.id);
    const before = await get(l.id);
    for (const previousSurfacedAt of [snooze.claimedAt, at(DAY)]) {
      const bad = { ...snooze, previousSurfacedAt };
      expect(await code(unsnoozeLink(deps(), A, l.id, bad))).toBe("invalid_input");
    }
    expect(await get(l.id)).toEqual(before);
  });

  it("refuses another owner's link as not found, never as a conflict, changing nothing", async () => {
    const theirs = await link(B, { snoozedUntil: at(DAY), lastSurfacedAt: NOW });
    const before = structuredClone(store.all(B));
    expect(await code(snoozeLink(deps(), A, theirs.id))).toBe("not_found");
    for (const until of [at(DAY), at(2 * DAY)]) {
      const snooze = { until, claimedAt: NOW, previousSurfacedAt: null };
      expect(await code(unsnoozeLink(deps(), A, theirs.id, snooze))).toBe("not_found");
    }
    expect(store.all(B)).toEqual(before);
  });
});

describe("I'm done with it", () => {
  it("archives the link, and undo makes it active again", async () => {
    const l = await link();
    await archiveLink(deps(), A, l.id);
    expect((await get(l.id)).state).toBe("archived");
    expect(await ids()).not.toContain(l.id);
    await unarchiveLink(deps(), A, l.id);
    expect((await get(l.id)).state).toBe("active");
  });

  it("will not take over an archive an AI made: a conflict, nothing written", async () => {
    const l = await link();
    await store.update(A, l.id, { state: "archived" });
    const before = await get(l.id);
    expect(await code(archiveLink(deps(), A, l.id))).toBe("conflict");
    expect(await get(l.id)).toEqual(before);
  });

  it("undo of a link no longer archived is a conflict", async () => {
    const l = await link();
    await archiveLink(deps(), A, l.id);
    await store.update(A, l.id, { state: "active", title: "changed elsewhere" });
    const before = await get(l.id);
    expect(await code(unarchiveLink(deps(), A, l.id))).toBe("conflict");
    expect(await get(l.id)).toEqual(before);
  });

  it("refuses another owner's link as not found, never as a conflict, changing nothing", async () => {
    const theirs = await link(B);
    const archived = await link(B, { state: "archived" });
    const before = structuredClone(store.all(B));
    expect(await code(archiveLink(deps(), A, theirs.id))).toBe("not_found");
    expect(await code(unarchiveLink(deps(), A, theirs.id))).toBe("not_found");
    expect(await code(unarchiveLink(deps(), A, archived.id))).toBe("not_found");
    expect(store.all(B)).toEqual(before);
  });
});

describe("tellWhy", () => {
  it("records the owner's answer, trimmed, as asked", async () => {
    const l = await link();
    const updated = await tellWhy(deps(), A, l.id, "  to compare quotes  ");
    expect(updated.why).toEqual({ text: "to compare quotes", source: "asked" });
    expect((await get(l.id)).why).toEqual({ text: "to compare quotes", source: "asked" });
  });

  it("replaces an agent's guess", async () => {
    const l = await link(A, { why: { text: "a guess", source: "inferred" } });
    await tellWhy(deps(), A, l.id, "the real reason");
    expect((await get(l.id)).why).toEqual({ text: "the real reason", source: "asked" });
  });

  it.each(["", "   ", "\n\t"])("refuses blank text %j and keeps the old why", async (text) => {
    const l = await link(A, { why: { text: "a guess", source: "inferred" } });
    expect(await code(tellWhy(deps(), A, l.id, text))).toBe("invalid_input");
    expect((await get(l.id)).why).toEqual({ text: "a guess", source: "inferred" });
  });

  it.each(["stated", "asked"] as const)(
    "will not replace a why that is %s: a conflict, and the why is unchanged",
    async (source) => {
      const l = await link(A, { why: { text: "theirs", source } });
      expect(await code(tellWhy(deps(), A, l.id, "new"))).toBe("conflict");
      expect((await get(l.id)).why).toEqual({ text: "theirs", source });
    },
  );

  it("refuses another owner's link as not found, never as a conflict, changing nothing", async () => {
    const open = await link(B);
    const said = await link(B, { why: { text: "b's", source: "stated" } });
    const before = structuredClone(store.all(B));
    expect(await code(tellWhy(deps(), A, open.id, "x"))).toBe("not_found");
    expect(await code(tellWhy(deps(), A, said.id, "x"))).toBe("not_found");
    expect(store.all(B)).toEqual(before);
  });
});
