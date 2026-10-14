import { beforeEach, describe, expect, it } from "vitest";
import { DIGEST_SIZE, SURFACE_COOLDOWN_MS } from "./digest.js";
import type { CoreError } from "./errors.js";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import type { LinkSearch } from "./search.js";
import type { SearchLog } from "./search-log.js";
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
    { writtenBy: "agent", at: created, focusLimit: 100 },
  );
  hits.set(text, found);
}

const get = async (id: string, owner = A) => (await store.get(owner, id)) as Link;
const ids = async () => (await worthALook(deps(), A)).map((d) => d.link.id);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as CoreError).code;
  }
  return "no error";
}

describe("worthALook", () => {
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
    const until = await snoozeLink(deps(), A, l.id);
    expect(until).toEqual(at(SNOOZE_MS));
    expect(SNOOZE_MS).toBe(14 * DAY);
    expect(await get(l.id)).toMatchObject({ lastSurfacedAt: NOW, snoozedUntil: at(SNOOZE_MS) });
  });

  it("marks and snoozes from one instant, though the clock moves while it runs", async () => {
    const l = await link();
    let tick = 0;
    const until = await snoozeLink({ ...deps(), now: () => at(tick++) }, A, l.id);
    const after = await get(l.id);
    expect(after.snoozedUntil).toEqual(until);
    expect(until.getTime() - (after.lastSurfacedAt as Date).getTime()).toBe(SNOOZE_MS);
  });

  it("undo clears the snooze it set", async () => {
    const l = await link();
    const until = await snoozeLink(deps(), A, l.id);
    await unsnoozeLink(deps(), A, l.id, new Date(until));
    expect((await get(l.id)).snoozedUntil).toBeNull();
  });

  it("undo after an AI changed the snooze is a conflict and leaves the AI's value", async () => {
    const l = await link();
    const until = await snoozeLink(deps(), A, l.id);
    await store.update(A, l.id, { snoozedUntil: at(3 * DAY) });
    expect(await code(unsnoozeLink(deps(), A, l.id, until))).toBe("conflict");
    expect((await get(l.id)).snoozedUntil).toEqual(at(3 * DAY));
  });

  it("refuses another owner's link as not found, never as a conflict, changing nothing", async () => {
    const theirs = await link(B, { snoozedUntil: at(DAY) });
    const before = structuredClone(store.all(B));
    expect(await code(snoozeLink(deps(), A, theirs.id))).toBe("not_found");
    expect(await code(unsnoozeLink(deps(), A, theirs.id, at(DAY)))).toBe("not_found");
    expect(await code(unsnoozeLink(deps(), A, theirs.id, at(2 * DAY)))).toBe("not_found");
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
