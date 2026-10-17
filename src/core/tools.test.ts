import { beforeEach, describe, expect, it } from "vitest";
import type { CoreError } from "./errors.js";
import { FakeStore } from "./fake-store.js";
import { A, B, newLink } from "./snapshot-store-contract.js";
import type { ToolRecord, ToolStore } from "./tool-store.js";
import {
  answerSuggestion,
  clockStart,
  currentWaitDays,
  isDue,
  keepHandy,
  notHandy,
} from "./tools.js";
import type { Link } from "./types.js";

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T00:00:00Z");
const day = (d: number) => new Date(T0.getTime() + d * DAY);

const linkWith = (over: Partial<Link> = {}): Link => ({
  id: "1",
  url: "https://ex.com/1",
  urlKey: "ex.com/1",
  title: null,
  summary: null,
  why: null,
  tags: [],
  savedAt: day(-100),
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});

const tool = (over: Partial<ToolRecord> = {}): ToolRecord => ({
  status: "kept",
  source: "stated",
  since: day(0),
  answeredAt: null,
  waitDays: 30,
  ...over,
});

describe("clockStart", () => {
  it("is the latest of the last opening, the last answer and since", () => {
    expect(clockStart(linkWith(), tool())).toEqual(day(0));
    expect(clockStart(linkWith({ lastOpenedAt: day(5) }), tool({ answeredAt: day(3) }))).toEqual(
      day(5),
    );
    expect(clockStart(linkWith({ lastOpenedAt: day(2) }), tool({ answeredAt: day(3) }))).toEqual(
      day(3),
    );
    expect(clockStart(linkWith({ lastOpenedAt: day(-9) }), tool())).toEqual(day(0));
  });
});

describe("isDue", () => {
  it("is due at 30 days and not at 29, nor a millisecond before 30", () => {
    const l = linkWith();
    expect(isDue(l, tool(), day(29))).toBe(false);
    expect(isDue(l, tool(), new Date(day(30).getTime() - 1))).toBe(false);
    expect(isDue(l, tool(), day(30))).toBe(true);
  });

  it("uses the stored wait from the last answer when nothing was opened since", () => {
    const t = tool({ answeredAt: day(30), waitDays: 60 });
    expect(isDue(linkWith({ lastOpenedAt: day(10) }), t, day(89))).toBe(false);
    expect(isDue(linkWith({ lastOpenedAt: day(10) }), t, day(90))).toBe(true);
  });

  it("an opening since the last check brings the wait back to 30 days from that opening", () => {
    const t = tool({ answeredAt: day(90), waitDays: 120 });
    const opened = linkWith({ lastOpenedAt: day(100) });
    expect(currentWaitDays(opened, t)).toBe(30);
    expect(isDue(opened, t, day(129))).toBe(false);
    expect(isDue(opened, t, day(130))).toBe(true);
  });

  it("an opening in the same millisecond as the last answer counts as since", () => {
    const t = tool({ answeredAt: day(30), waitDays: 60 });
    const opened = linkWith({ lastOpenedAt: day(30) });
    expect(currentWaitDays(opened, t)).toBe(30);
    expect(isDue(opened, t, day(60))).toBe(true);
  });

  it("an opening in the same millisecond as a fresh keep leaves the first wait of 30", () => {
    const opened = linkWith({ lastOpenedAt: day(0) });
    expect(currentWaitDays(opened, tool())).toBe(30);
    expect(isDue(opened, tool(), day(29))).toBe(false);
    expect(isDue(opened, tool(), day(30))).toBe(true);
  });

  it("an opening before the last check leaves the stored wait", () => {
    const t = tool({ answeredAt: day(90), waitDays: 120 });
    const opened = linkWith({ lastOpenedAt: day(80) });
    expect(currentWaitDays(opened, t)).toBe(120);
    expect(isDue(opened, t, day(209))).toBe(false);
    expect(isDue(opened, t, day(210))).toBe(true);
  });

  it("is never due for an archived link, a suggestion, a declined link or a link with no row", () => {
    const late = day(1000);
    expect(isDue(linkWith({ state: "archived" }), tool(), late)).toBe(false);
    expect(isDue(linkWith(), tool({ status: "suggested", source: "inferred" }), late)).toBe(false);
    expect(isDue(linkWith(), tool({ status: "declined" }), late)).toBe(false);
    expect(isDue(linkWith(), null, late)).toBe(false);
  });
});

let store: FakeStore;
let clock: Date;
let n = 0;
const deps = () => ({ store, tools: store, now: () => clock });

beforeEach(() => {
  store = new FakeStore();
  clock = day(0);
});

const saved = async (owner = A): Promise<string> =>
  (await store.insertIfAbsent(owner, newLink(++n, day(-100)))).link.id;
/** Puts a row in place directly, for a starting state the rules would take days to reach. */
const put = async (id: string, row: ToolRecord) => {
  await store.updateToolIf(A, id, await store.getTool(A, id), row);
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as CoreError).code;
  }
  return "no error";
}

describe("keepHandy", () => {
  it("keeps a link with no row: the given source, since now, a first wait", async () => {
    const id = await saved();
    const row = tool({ source: "asked", since: day(0) });
    expect((await keepHandy(deps(), A, id, "asked")).tool).toEqual(row);
    expect(await store.getTool(A, id)).toEqual(row);
  });

  it("returns the row it wrote with the row it replaced", async () => {
    const id = await saved();
    expect(await keepHandy(deps(), A, id, "stated")).toEqual({ tool: tool(), previous: null });
    clock = day(2);
    expect(await notHandy(deps(), A, id, "asked")).toEqual({
      tool: tool({ status: "declined", source: "asked", since: day(2) }),
      previous: tool(),
    });
    const suggested = await saved();
    await keepHandy(deps(), A, suggested, "inferred");
    const suggestion = tool({ status: "suggested", source: "inferred", since: day(2) });
    expect(await answerSuggestion(deps(), A, suggested, true)).toEqual({
      tool: tool({ source: "asked", since: day(2) }),
      previous: suggestion,
    });
  });

  it("keeps a suggested or declined link with its clock starting now", async () => {
    const suggested = await saved();
    const declined = await saved();
    await keepHandy(deps(), A, suggested, "inferred");
    await notHandy(deps(), A, declined, "stated");
    clock = day(40);
    expect((await answerSuggestion(deps(), A, suggested, true)).tool).toEqual(
      tool({ source: "asked", since: day(40) }),
    );
    expect((await keepHandy(deps(), A, declined, "stated")).tool).toEqual(tool({ since: day(40) }));
    for (const id of [suggested, declined]) {
      const link = (await store.get(A, id)) as Link;
      expect(isDue(link, await store.getTool(A, id), day(40))).toBe(false);
    }
  });

  it("re-keeping a kept tool keeps its since and answer and sets the wait back to 30", async () => {
    const id = await saved();
    await put(id, tool({ answeredAt: day(90), waitDays: 120 }));
    clock = day(100);
    expect((await keepHandy(deps(), A, id, "asked")).tool).toEqual(
      tool({ source: "asked", answeredAt: day(90), waitDays: 30 }),
    );
  });

  it("an inferred keep suggests a link with no row, and never overrides kept or declined", async () => {
    const fresh = await saved();
    const kept = await saved();
    const declined = await saved();
    await keepHandy(deps(), A, kept, "asked");
    await notHandy(deps(), A, declined, "stated");
    const before = [await store.getTool(A, kept), await store.getTool(A, declined)];
    clock = day(5);
    expect((await keepHandy(deps(), A, fresh, "inferred")).tool).toEqual(
      tool({ status: "suggested", source: "inferred", since: day(5) }),
    );
    expect((await keepHandy(deps(), A, kept, "inferred")).tool).toEqual(before[0]);
    expect((await keepHandy(deps(), A, declined, "inferred")).tool).toEqual(before[1]);
    expect([await store.getTool(A, kept), await store.getTool(A, declined)]).toEqual(before);
  });

  it("an inferred keep that loses a race to the owner's keep leaves the link kept", async () => {
    const id = await saved();
    const racing: ToolStore = Object.assign(Object.create(store) as FakeStore, {
      updateToolIf: async (...args: Parameters<ToolStore["updateToolIf"]>) => {
        await keepHandy(deps(), A, id, "stated");
        return store.updateToolIf(...args);
      },
    });
    expect(await code(keepHandy({ ...deps(), tools: racing }, A, id, "inferred"))).toBe("conflict");
    expect(await store.getTool(A, id)).toEqual(tool());
  });

  it("refuses another owner's link and an unknown id as not found, writing nothing", async () => {
    const id = await saved(A);
    expect(await code(keepHandy(deps(), B, id, "stated"))).toBe("not_found");
    expect(await code(keepHandy(deps(), A, "no-such-id", "stated"))).toBe("not_found");
    expect(await store.getTool(A, id)).toBeNull();
  });
});

describe("answerSuggestion", () => {
  it("yes keeps the link as asked; no declines it as asked", async () => {
    const yes = await saved();
    const no = await saved();
    for (const id of [yes, no]) await keepHandy(deps(), A, id, "inferred");
    clock = day(3);
    expect((await answerSuggestion(deps(), A, yes, true)).tool).toEqual(
      tool({ source: "asked", since: day(3) }),
    );
    expect((await answerSuggestion(deps(), A, no, false)).tool).toEqual(
      tool({ status: "declined", source: "asked", since: day(3) }),
    );
  });

  it("refuses a link with no suggestion, changing nothing", async () => {
    const none = await saved();
    const kept = await saved();
    await keepHandy(deps(), A, kept, "stated");
    expect(await code(answerSuggestion(deps(), A, none, true))).toBe("conflict");
    expect(await code(answerSuggestion(deps(), A, kept, false))).toBe("conflict");
    expect(await store.getTool(A, none)).toBeNull();
    expect(await store.getTool(A, kept)).toEqual(tool());
  });
});

describe("notHandy", () => {
  it("declines a link from no row and from kept, with the given source", async () => {
    const none = await saved();
    const kept = await saved();
    await keepHandy(deps(), A, kept, "stated");
    clock = day(7);
    const declined = tool({ status: "declined", source: "asked", since: day(7) });
    expect((await notHandy(deps(), A, none, "asked")).tool).toEqual(declined);
    expect((await notHandy(deps(), A, kept, "asked")).tool).toEqual(declined);
  });

  it("refuses an inferred source: only the owner says a link is not handy", async () => {
    const id = await saved();
    await keepHandy(deps(), A, id, "stated");
    expect(await code(notHandy(deps(), A, id, "inferred"))).toBe("invalid_input");
    expect(await store.getTool(A, id)).toEqual(tool());
  });
});
