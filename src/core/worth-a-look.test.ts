import { beforeEach, describe, expect, it } from "vitest";
import { DIGEST_SIZE, getDigest, previewDigest } from "./digest.js";
import type { CoreError } from "./errors.js";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import type { FocusMatch } from "./search.js";
import type { SearchLog } from "./search-log.js";
import { answerSuggestion, keepHandy, listSuggestions, type ToolItem } from "./tools.js";
import type { Link, NewLink } from "./types.js";
import {
  archiveLink,
  bringBackLink,
  SNOOZE_MS,
  snoozeLink,
  tellWhy,
  undoStateChange,
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
const keyword: FocusMatch = {
  match: async (_owner, text) => (hits.get(text) ?? []).map((id) => ({ id, words: [text] })),
};

/** Records every call, so a test can show nothing was logged. */
class SpySearchLog implements SearchLog {
  calls: string[] = [];
  async record() {
    this.calls.push("record");
  }
  async pairOpen() {
    this.calls.push("pairOpen");
  }
  async receiptRow() {
    this.calls.push("receiptRow");
    return null;
  }
  async pairReceipt() {
    this.calls.push("pairReceipt");
  }
  async agentRows() {
    this.calls.push("agentRows");
    return [];
  }
  async pairRow() {
    this.calls.push("pairRow");
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
  focusMatch: keyword,
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
      summarySource: null,
      why: null,
      tags: [],
      savedAt: at(-(n + 1) * DAY),
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
const _flagGone = (id: string, flaggedAt: Date) =>
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

  it("when the lead goes, the next focus match leads and the other picks stay", async () => {
    const all: Link[] = [];
    for (let i = 0; i < DIGEST_SIZE + 3; i++) all.push(await link());
    const [newer, older] = all.slice(-2) as [Link, Link];
    await focus("topic", at(-DAY), [older.id, newer.id]);
    expect((await ids())[0]).toBe(older.id);
    await snoozeLink(deps(), A, older.id);
    expect((await ids())[0]).toBe(newer.id);
    await archiveLink(deps(), A, newer.id);
    expect(await ids()).not.toContain(newer.id);
    expect(await ids()).toHaveLength(WORTH_SIZE);
  });

  it("shows every eligible link when there are fewer than three, and none when nothing is due", async () => {
    expect(await ids()).toEqual([]);
    const only = await link();
    await link(A, { state: "archived" });
    expect(await ids()).toEqual([only.id]);
  });
});

describe("Skip", () => {
  it("snoozes the link for two weeks without marking it surfaced", async () => {
    const l = await link();
    const { until } = await snoozeLink(deps(), A, l.id);
    expect(until).toEqual(at(SNOOZE_MS));
    expect(SNOOZE_MS).toBe(14 * DAY);
    expect(await get(l.id)).toMatchObject({ lastSurfacedAt: null, snoozedUntil: at(SNOOZE_MS) });
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

  it("puts off a link whose earlier snooze has ended", async () => {
    const l = await link(A, { snoozedUntil: NOW });
    await snoozeLink(deps(), A, l.id);
    expect((await get(l.id)).snoozedUntil).toEqual(at(SNOOZE_MS));
  });

  it("answers the snooze it set, which undo sends back", async () => {
    const l = await link();
    expect(await snoozeLink(deps(), A, l.id)).toEqual({ until: at(SNOOZE_MS), previous: null });
  });

  it("undo clears the snooze: the link is back on home and in a digest at once", async () => {
    const l = await link();
    const snooze = await snoozeLink(deps(), A, l.id);
    await unsnoozeLink(deps(), A, l.id, structuredClone(snooze));
    expect(await get(l.id)).toMatchObject({ snoozedUntil: null, lastSurfacedAt: null });
    expect(await ids()).toContain(l.id);
    expect((await getDigest(deps(), A)).links.map((d) => d.link.id)).toContain(l.id);
  });

  it("undo after an AI changed the snooze is a conflict and leaves the AI's value", async () => {
    const l = await link();
    const snooze = await snoozeLink(deps(), A, l.id);
    await store.update(A, l.id, { snoozedUntil: at(3 * DAY) });
    expect(await code(unsnoozeLink(deps(), A, l.id, snooze))).toBe("conflict");
    expect(await get(l.id)).toMatchObject({ snoozedUntil: at(3 * DAY), lastSurfacedAt: null });
  });

  it("refuses another owner's link as not found, never as a conflict, changing nothing", async () => {
    const theirs = await link(B, { snoozedUntil: at(DAY), lastSurfacedAt: NOW });
    const before = structuredClone(store.all(B));
    expect(await code(snoozeLink(deps(), A, theirs.id))).toBe("not_found");
    for (const until of [at(DAY), at(2 * DAY)]) {
      expect(await code(unsnoozeLink(deps(), A, theirs.id, { until, previous: null }))).toBe(
        "not_found",
      );
    }
    expect(store.all(B)).toEqual(before);
  });
});

describe("Archive", () => {
  it("archives the link, and undo makes it active again", async () => {
    const l = await link();
    await archiveLink(deps(), A, l.id);
    expect((await get(l.id)).state).toBe("archived");
    expect(await ids()).not.toContain(l.id);
    await bringBackLink(deps(), A, l.id);
    expect((await get(l.id)).state).toBe("active");
  });

  it("will not take over an archive an AI made: a conflict, nothing written", async () => {
    const l = await link();
    await store.update(A, l.id, { state: "archived" });
    const before = await get(l.id);
    expect(await code(archiveLink(deps(), A, l.id))).toBe("conflict");
    expect(await get(l.id)).toEqual(before);
  });

  it("Bring it back on a link already active is a quiet success that writes nothing", async () => {
    const l = await link(A, {
      snoozedUntil: at(DAY),
      lastSurfacedAt: at(-DAY),
      title: "elsewhere",
    });
    const before = await get(l.id);
    const change = await bringBackLink(deps(), A, l.id);
    expect(change).toEqual({
      before: { state: "active", snoozedUntil: at(DAY) },
      after: { state: "active" },
      at: NOW,
    });
    expect(await get(l.id)).toEqual(before);
    await undoStateChange(deps(), A, l.id, change);
    expect(await get(l.id)).toEqual(before);
  });

  it("refuses another owner's link as not found, never as a conflict, changing nothing", async () => {
    const theirs = await link(B);
    const archived = await link(B, { state: "archived" });
    const before = structuredClone(store.all(B));
    expect(await code(archiveLink(deps(), A, theirs.id))).toBe("not_found");
    expect(await code(bringBackLink(deps(), A, theirs.id))).toBe("not_found");
    expect(await code(bringBackLink(deps(), A, archived.id))).toBe("not_found");
    expect(store.all(B)).toEqual(before);
  });
});

describe("archive, bring back and their Undo", () => {
  it("Archive: active becomes archived, leaves the snooze and returns before", async () => {
    const l = await link(A, { snoozedUntil: at(DAY) });
    const change = await archiveLink(deps(), A, l.id);
    expect(change).toEqual({
      before: { state: "active", snoozedUntil: at(DAY) },
      after: { state: "archived" },
      at: NOW,
    });
    expect(await get(l.id)).toMatchObject({ state: "archived", snoozedUntil: at(DAY) });
  });

  it("Archive refuses an archived link, writing nothing", async () => {
    const archived = await link(A, { state: "archived" });
    const before = await get(archived.id);
    expect(await code(archiveLink(deps(), A, archived.id))).toBe("conflict");
    expect(await get(archived.id)).toEqual(before);
  });

  it("Bring it back: an archived link becomes active", async () => {
    const archived = await link(A, { state: "archived" });
    const change = await bringBackLink(deps(), A, archived.id);
    expect(change.before).toEqual({ state: "archived", snoozedUntil: null });
    expect(await get(archived.id)).toMatchObject({ state: "active" });
    expect((await bringBackLink(deps(), A, archived.id)).before.state).toBe("active");
  });

  it("Undo of Archive restores the active state and the snooze", async () => {
    const l = await link(A, { snoozedUntil: at(DAY) });
    const change = await archiveLink(deps(), A, l.id);
    await undoStateChange(deps(), A, l.id, change);
    expect(await get(l.id)).toMatchObject({ state: "active", snoozedUntil: at(DAY) });
  });

  it("Undo of Bring it back restores an archived link", async () => {
    const archived = await link(A, { state: "archived" });
    const change = await bringBackLink(deps(), A, archived.id);
    await undoStateChange(deps(), A, archived.id, change);
    expect(await get(archived.id)).toMatchObject({ state: "archived" });
  });

  it("a late Undo is a conflict: archive, bring back elsewhere, then the first Undo", async () => {
    const l = await link();
    const first = await archiveLink(deps(), A, l.id);
    await bringBackLink(deps(), A, l.id);
    const before = await get(l.id);
    expect(await code(undoStateChange(deps(), A, l.id, first))).toBe("conflict");
    expect(await get(l.id)).toEqual(before);
    expect(before).toMatchObject({ state: "active" });
  });

  it("Undo of another owner's link is not found, changing nothing", async () => {
    const theirs = await link(B);
    const change = await archiveLink(deps(), B, theirs.id);
    const before = structuredClone(store.all(B));
    expect(await code(undoStateChange(deps(), A, theirs.id, change))).toBe("not_found");
    expect(store.all(B)).toEqual(before);
  });

  it("Not now refuses an archived link", async () => {
    const archived = await link(A, { state: "archived" });
    expect(await code(snoozeLink(deps(), A, archived.id))).toBe("conflict");
  });
});

describe("stats events from the state actions (#161)", () => {
  const kinds = (l: Link) => store.eventsOf(A, l.id).map((e) => [e.kind, e.at.getTime()]);

  it("Archive records stale at now, and a refused one records nothing", async () => {
    const l = await link();
    await archiveLink(deps(), A, l.id);
    expect(await code(archiveLink(deps(), A, l.id))).toBe("conflict");
    expect(kinds(l)).toEqual([["stale", NOW.getTime()]]);
  });

  it("Not now records not_now at now, and a refused one records nothing", async () => {
    const l = await link();
    await snoozeLink(deps(), A, l.id);
    expect(await code(snoozeLink(deps(), A, l.id))).toBe("conflict");
    expect(kinds(l)).toEqual([["not_now", NOW.getTime()]]);
  });

  it("undo of Not now removes the not_now event", async () => {
    const l = await link();
    const snooze = await snoozeLink(deps(), A, l.id);
    await unsnoozeLink(deps(), A, l.id, snooze);
    expect(kinds(l)).toEqual([]);
  });

  it("Bring it back records nothing and adds no event to undo", async () => {
    const l = await link(A, { state: "archived" });
    const change = await bringBackLink(deps(), A, l.id);
    expect(change.at).toEqual(NOW);
    expect(kinds(l)).toEqual([]);
    await undoStateChange(deps(), A, l.id, change);
    expect(kinds(l)).toEqual([]);
  });

  it("Bring it back on an already active link still carries its time", async () => {
    const l = await link();
    expect((await bringBackLink(deps(), A, l.id)).at).toEqual(NOW);
  });

  it("undo of Archive removes the stale event", async () => {
    const l = await link();
    const change = await archiveLink(deps(), A, l.id);
    await undoStateChange(deps(), A, l.id, change);
    expect(kinds(l)).toEqual([]);
  });

  it("an old stale Undo removes its own event, not a later one", async () => {
    const l = await link();
    const first = await archiveLink(deps(), A, l.id);
    clock = at(DAY);
    await bringBackLink(deps(), A, l.id);
    clock = at(2 * DAY);
    await archiveLink(deps(), A, l.id);
    // the row is archived again, so the first Undo still applies and takes out only its own event
    await undoStateChange(deps(), A, l.id, first);
    expect(kinds(l)).toEqual([["stale", at(2 * DAY).getTime()]]);
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

describe("an archived link and a focus entry written after it", () => {
  it("is not on Worth a look, and nothing is marked surfaced", async () => {
    const archived = await link(A, { state: "archived", lastSurfacedAt: null });
    await focus("fits", at(-DAY), [archived.id]);

    expect(await ids()).not.toContain(archived.id);
    expect((await get(archived.id)).lastSurfacedAt).toBeNull();
  });
});

describe("Explore: the cards stay until decided (#340)", () => {
  /** Six To explore links saved 6..1 days ago, never surfaced, in that order (oldest first). */
  async function six(): Promise<string[]> {
    const made: string[] = [];
    for (let day = 6; day >= 1; day--) made.push((await link(A, { savedAt: at(-day * DAY) })).id);
    return made;
  }

  it("shows the same three on every day with no action", async () => {
    await six();
    const first = await ids();
    for (const day of [1, 2, 3, 9]) {
      clock = at(day * DAY);
      expect(await ids()).toEqual(first);
    }
  });

  it("shows the oldest saved first; deciding one brings the next up", async () => {
    const all = await six();
    const first = await ids();
    expect(first).toEqual(all.slice(0, 3));
    await archiveLink(deps(), A, all[0] as string);
    expect(await ids()).toEqual(all.slice(1, 4));
  });

  it("picks a link with a why saved yesterday that was never surfaced or opened, with no reason", async () => {
    const l = await link(A, { why: { text: "w", source: "stated" }, savedAt: at(-DAY) });
    expect(await ids()).toEqual([l.id]);
    expect((await picked()).links[0]?.reasons).toEqual([]);
  });

  it("gives its one focus slot to the oldest focus match, then the rest oldest first", async () => {
    const all = await six();
    await focus("rust", at(-DAY), [all[5] as string, all[3] as string]);
    expect(await ids()).toEqual([all[3], all[0], all[1]]);
  });

  it("brings a skipped link back to its old place when its two weeks run out", async () => {
    const all = await six();
    await snoozeLink(deps(), A, all[0] as string);
    expect(await ids()).toEqual(all.slice(1, 4));
    clock = at(SNOOZE_MS);
    expect(await ids()).toEqual(all.slice(0, 3));
  });

  it("leaves out a kept tool even if its link reads as explore (the store refuses to write that pair)", async () => {
    const tool = await link(A, { savedAt: at(-30 * DAY) });
    const plain = await link(A, { savedAt: at(-DAY) });
    const kept = { status: "kept", source: "stated", since: NOW, answeredAt: null } as never;
    const tools = Object.assign(Object.create(store), {
      listTools: async () => new Map([[tool.id, kept]]),
    });
    const got = await worthALook({ ...deps(), tools }, A, []);
    expect(got.links.map((d) => d.link.id)).toEqual([plain.id]);
  });

  it("Skip writes no surfacing and records not_now; Undo clears the snooze and the event", async () => {
    const l = await link(A, { lastSurfacedAt: at(-3 * DAY) });
    const snooze = await snoozeLink(deps(), A, l.id);
    expect(Object.keys(snooze)).toEqual(["until", "previous"]);
    expect(snooze.previous).toBeNull();
    expect(await get(l.id)).toMatchObject({
      lastSurfacedAt: at(-3 * DAY),
      snoozedUntil: snooze.until,
    });
    expect(store.eventsOf(A, l.id).map((e) => e.kind)).toEqual(["not_now"]);
    await unsnoozeLink(deps(), A, l.id, snooze);
    expect(await get(l.id)).toMatchObject({ lastSurfacedAt: at(-3 * DAY), snoozedUntil: null });
    expect(store.eventsOf(A, l.id)).toEqual([]);
  });

  it("Skip on a link an agent snoozed far ahead sets now + SNOOZE_MS, and Undo restores the agent's date exactly", async () => {
    const far = new Date("2099-01-01T00:00:00Z");
    const l = await link(A, { snoozedUntil: far });
    const snooze = await snoozeLink(deps(), A, l.id);
    expect(snooze).toEqual({ until: new Date(NOW.getTime() + SNOOZE_MS), previous: far });
    expect((await get(l.id))?.snoozedUntil).toEqual(snooze.until);
    expect(store.eventsOf(A, l.id).map((e) => e.kind)).toEqual(["not_now"]);
    await unsnoozeLink(deps(), A, l.id, snooze);
    expect((await get(l.id))?.snoozedUntil).toEqual(far);
    expect(store.eventsOf(A, l.id)).toEqual([]);
  });

  it("Skip on a link already skipped within SNOOZE_MS is still refused, changing nothing", async () => {
    const soon = at(SNOOZE_MS - DAY);
    const l = await link(A, { snoozedUntil: soon });
    await expect(snoozeLink(deps(), A, l.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await get(l.id))?.snoozedUntil).toEqual(soon);
    expect(store.eventsOf(A, l.id)).toEqual([]);
  });
});
