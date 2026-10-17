import { beforeEach, describe, expect, it } from "vitest";
import type { CoreError } from "./errors.js";
import { FakeStore } from "./fake-store.js";
import { recordOpening, updateLink } from "./links.js";
import { A, B, newLink } from "./snapshot-store-contract.js";
import type { ToolRecord, ToolStore } from "./tool-store.js";
import {
  answerSuggestion,
  clockStart,
  currentWaitDays,
  handyOf,
  handyOfLinks,
  isDue,
  keepHandy,
  listShelf,
  listSuggestions,
  notHandy,
  restoreTool,
  stillUsing,
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

  it("re-keeping a kept tool changes only its source, so it is not due at once", async () => {
    const id = await saved();
    await put(id, tool({ answeredAt: day(30), waitDays: 60 }));
    clock = day(70);
    const kept = tool({ source: "asked", answeredAt: day(30), waitDays: 60 });
    expect((await keepHandy(deps(), A, id, "asked")).tool).toEqual(kept);
    expect(await store.getTool(A, id)).toEqual(kept);
    const link = (await store.get(A, id)) as Link;
    expect(isDue(link, await store.getTool(A, id), day(70))).toBe(false);
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

describe("stillUsing", () => {
  const answer = async (id: string, d: number) => {
    clock = day(d);
    return (await stillUsing(deps(), A, id, "stated")).tool;
  };
  const due = async (id: string, d: number) =>
    isDue((await store.get(A, id)) as Link, await store.getTool(A, id), day(d));

  it("doubles the wait 30, 60, 120 and caps it, when nothing was opened", async () => {
    const id = await saved();
    await keepHandy(deps(), A, id, "stated");
    expect(await answer(id, 30)).toEqual(tool({ answeredAt: day(30), waitDays: 60 }));
    expect(await due(id, 89)).toBe(false);
    expect(await due(id, 90)).toBe(true);
    expect(await answer(id, 90)).toEqual(tool({ answeredAt: day(90), waitDays: 120 }));
    expect(await answer(id, 210)).toEqual(tool({ answeredAt: day(210), waitDays: 120 }));
  });

  it("returns the answered row with the row before the answer", async () => {
    const id = await saved();
    await keepHandy(deps(), A, id, "stated");
    clock = day(30);
    expect(await stillUsing(deps(), A, id, "stated")).toEqual({
      tool: tool({ answeredAt: day(30), waitDays: 60 }),
      previous: tool(),
    });
  });

  it("sets the wait back to 30 after an opening since the tool was kept", async () => {
    const id = await saved();
    await keepHandy(deps(), A, id, "stated");
    clock = day(20);
    await recordOpening({ store, now: () => clock }, A, id);
    expect(await answer(id, 50)).toEqual(tool({ answeredAt: day(50), waitDays: 30 }));
  });

  const openers = [
    ["from the web page", (id: string) => recordOpening({ store, now: () => clock }, A, id)],
    [
      "by an AI's update_link",
      (id: string) => updateLink({ store, now: () => clock }, A, id, { opened: true }),
    ],
  ] as const;

  it.each(openers)(
    "an opening recorded %s brings a doubled wait back to 30 days from that opening",
    async (_how, open) => {
      const id = await saved();
      const row = tool({ answeredAt: day(90), waitDays: 120 });
      await put(id, row);
      clock = day(100);
      await open(id);
      expect(await store.getTool(A, id)).toEqual(row);
      expect(await due(id, 129)).toBe(false);
      expect(await due(id, 130)).toBe(true);
      expect(await answer(id, 130)).toEqual({ ...row, answeredAt: day(130), waitDays: 30 });
    },
  );

  it.each(openers)(
    "an opening recorded %s in the same millisecond as the answer counts as since",
    async (_how, open) => {
      const id = await saved();
      await keepHandy(deps(), A, id, "stated");
      expect(await answer(id, 30)).toEqual(tool({ answeredAt: day(30), waitDays: 60 }));
      await open(id);
      expect((await store.get(A, id))?.lastOpenedAt).toEqual(day(30));
      expect(await due(id, 59)).toBe(false);
      expect(await due(id, 60)).toBe(true);
      expect(await answer(id, 60)).toEqual(tool({ answeredAt: day(60), waitDays: 30 }));
    },
  );

  it("two answers from the same reading double the wait once", async () => {
    const id = await saved();
    await keepHandy(deps(), A, id, "stated");
    clock = day(30);
    const racing: ToolStore = Object.assign(Object.create(store) as FakeStore, {
      updateToolIf: async (...args: Parameters<ToolStore["updateToolIf"]>) => {
        await stillUsing(deps(), A, id, "stated");
        return store.updateToolIf(...args);
      },
    });
    expect(await code(stillUsing({ ...deps(), tools: racing }, A, id, "stated"))).toBe("conflict");
    expect(await store.getTool(A, id)).toEqual(tool({ answeredAt: day(30), waitDays: 60 }));
  });

  it("an answer while not due restarts the clock but never doubles the wait", async () => {
    const fresh = await saved();
    await keepHandy(deps(), A, fresh, "stated");
    expect(await answer(fresh, 10)).toEqual(tool({ answeredAt: day(10), waitDays: 30 }));
    const doubled = await saved();
    await put(doubled, tool({ answeredAt: day(30), waitDays: 60 }));
    expect(await answer(doubled, 50)).toEqual(tool({ answeredAt: day(50), waitDays: 60 }));
  });

  it("two answers in a row: the first, while due, doubles; the second, no longer due, does not", async () => {
    const id = await saved();
    await keepHandy(deps(), A, id, "stated");
    expect(await answer(id, 30)).toEqual(tool({ answeredAt: day(30), waitDays: 60 }));
    expect(await answer(id, 30)).toEqual(tool({ answeredAt: day(30), waitDays: 60 }));
    expect(await answer(id, 31)).toEqual(tool({ answeredAt: day(31), waitDays: 60 }));
  });

  it("an answer while not due, after an opening since the last check, sets the wait to 30", async () => {
    const id = await saved();
    await put(id, tool({ answeredAt: day(90), waitDays: 120 }));
    clock = day(100);
    await recordOpening({ store, now: () => clock }, A, id);
    expect(await due(id, 110)).toBe(false);
    expect(await answer(id, 110)).toEqual(tool({ answeredAt: day(110), waitDays: 30 }));
  });

  it("refuses a link that is not kept, and an inferred source, changing nothing", async () => {
    const suggested = await saved();
    const kept = await saved();
    await keepHandy(deps(), A, suggested, "inferred");
    await keepHandy(deps(), A, kept, "stated");
    expect(await code(stillUsing(deps(), A, suggested, "stated"))).toBe("conflict");
    expect(await code(stillUsing(deps(), A, kept, "inferred"))).toBe("invalid_input");
    expect(await store.getTool(A, kept)).toEqual(tool());
  });
});

describe("restoreTool", () => {
  it("undoing a first keep restores exact absence, so the link can be suggested again", async () => {
    const id = await saved();
    const kept = await keepHandy(deps(), A, id, "stated");
    await restoreTool(deps(), A, id, kept.previous, kept.tool);
    expect(await store.getTool(A, id)).toBeNull();
    expect(await store.listTools(A)).toEqual(new Map());
    clock = day(1);
    expect((await keepHandy(deps(), A, id, "inferred")).tool).toEqual(
      tool({ status: "suggested", source: "inferred", since: day(1) }),
    );
  });

  it("undoing not handy, an answer to a suggestion or Still using puts the earlier row back", async () => {
    const declined = await saved();
    const answered = await saved();
    const used = await saved();
    await keepHandy(deps(), A, declined, "stated");
    await keepHandy(deps(), A, answered, "inferred");
    await keepHandy(deps(), A, used, "stated");
    clock = day(30);
    const changes = [
      [declined, await notHandy(deps(), A, declined, "stated")],
      [answered, await answerSuggestion(deps(), A, answered, false)],
      [used, await stillUsing(deps(), A, used, "stated")],
    ] as const;
    for (const [id, change] of changes) {
      await restoreTool(deps(), A, id, change.previous, change.tool);
      expect(await store.getTool(A, id)).toEqual(change.previous);
    }
  });

  it("refuses an undo once the row has changed since, and changes nothing", async () => {
    const id = await saved();
    const kept = await keepHandy(deps(), A, id, "stated");
    clock = day(30);
    const used = await stillUsing(deps(), A, id, "stated");
    expect(await code(restoreTool(deps(), A, id, kept.previous, kept.tool))).toBe("conflict");
    expect(await store.getTool(A, id)).toEqual(used.tool);
  });

  it("refuses another owner's link as not found, changing nothing", async () => {
    const id = await saved();
    const kept = await keepHandy(deps(), A, id, "stated");
    expect(await code(restoreTool(deps(), B, id, kept.previous, kept.tool))).toBe("not_found");
    expect(await store.getTool(A, id)).toEqual(kept.tool);
  });

  it.each([
    ["kept by inference", { status: "kept", source: "inferred" }],
    ["suggested by the owner", { status: "suggested", source: "stated" }],
    ["declined by inference", { status: "declined", source: "inferred" }],
    ["a wait of 45 days", { waitDays: 45 }],
    ["a start in the future", { since: day(5) }],
    ["an answer in the future", { answeredAt: day(5) }],
    ["an answer before the start", { since: day(0), answeredAt: day(-1) }],
  ] as const)("refuses to restore a row core can't produce: %s", async (_name, over) => {
    const id = await saved();
    const kept = await keepHandy(deps(), A, id, "stated");
    clock = day(1);
    const bad = tool(over as unknown as Partial<ToolRecord>);
    expect(await code(restoreTool(deps(), A, id, bad, kept.tool))).toBe("invalid_input");
    expect(await store.getTool(A, id)).toEqual(kept.tool);
  });
});

describe("handy views", () => {
  /** The store, recording which reads reach it. */
  const counted = () => {
    const calls: string[] = [];
    const tools: ToolStore = Object.assign(Object.create(store) as FakeStore, {
      getTool: async (...a: Parameters<ToolStore["getTool"]>) => {
        calls.push("getTool");
        return store.getTool(...a);
      },
      listTools: async (...a: Parameters<ToolStore["listTools"]>) => {
        calls.push("listTools");
        return store.listTools(...a);
      },
    });
    return { tools, calls };
  };
  const linkOf = async (id: string) => (await store.get(A, id)) as Link;

  it("gives each link its status, source and due flag in one read, and null without a row", async () => {
    const due = await saved();
    const fresh = await saved();
    const suggested = await saved();
    const declined = await saved();
    const archived = await saved();
    const none = await saved();
    await keepHandy(deps(), A, due, "stated");
    await keepHandy(deps(), A, archived, "asked");
    await store.update(A, archived, { state: "archived" });
    clock = day(30);
    await keepHandy(deps(), A, fresh, "asked");
    await keepHandy(deps(), A, suggested, "inferred");
    await notHandy(deps(), A, declined, "stated");
    const links = await Promise.all([due, fresh, suggested, declined, archived, none].map(linkOf));
    const { tools, calls } = counted();
    expect(await handyOfLinks({ tools, now: () => clock }, A, links)).toEqual(
      new Map([
        [due, { status: "kept", source: "stated", due: true }],
        [fresh, { status: "kept", source: "asked", due: false }],
        [suggested, { status: "suggested", source: "inferred", due: false }],
        [declined, { status: "declined", source: "stated", due: false }],
        [archived, { status: "kept", source: "asked", due: false }],
        [none, null],
      ]),
    );
    expect(calls).toEqual(["listTools"]);
  });

  it("gives one link's view, and null for another owner's link", async () => {
    const id = await saved();
    await keepHandy(deps(), A, id, "stated");
    clock = day(30);
    const link = await linkOf(id);
    expect(await handyOf(deps(), A, link)).toEqual({ status: "kept", source: "stated", due: true });
    expect(await handyOf(deps(), B, link)).toBeNull();
  });
});

describe("listShelf", () => {
  it("lists kept tools on active links: opened newest first, then never-opened by since, newest first", async () => {
    const [opened5, opened9, never2, never7, archived, suggested, declined] = [
      await saved(),
      await saved(),
      await saved(),
      await saved(),
      await saved(),
      await saved(),
      await saved(),
    ];
    await saved();
    const theirs = await saved(B);
    const keptOn = [
      [opened5, 0],
      [opened9, 0],
      [never2, 2],
      [never7, 7],
      [archived, 0],
    ] as const;
    for (const [id, d] of keptOn) {
      clock = day(d);
      await keepHandy(deps(), A, id, "stated");
    }
    await keepHandy(deps(), A, suggested, "inferred");
    await notHandy(deps(), A, declined, "stated");
    await keepHandy(deps(), B, theirs, "stated");
    await store.update(A, opened5, { lastOpenedAt: day(5) });
    await store.update(A, opened9, { lastOpenedAt: day(9) });
    await store.update(A, archived, { state: "archived" });
    clock = day(36);
    const shelf = await listShelf(deps(), A);
    expect(shelf.map((s) => s.link.id)).toEqual([opened9, opened5, never7, never2]);
    expect(shelf.map((s) => s.due)).toEqual([false, true, false, true]);
  });

  it("returns every kept tool with its row, ties in the store's order", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await saved();
      await keepHandy(deps(), A, id, "stated");
      ids.push(id);
    }
    const shelf = await listShelf(deps(), A);
    expect(shelf.map((s) => s.link.id)).toEqual(ids);
    expect(shelf[0]?.tool).toEqual(tool());
  });
});

describe("listSuggestions", () => {
  it("lists suggested tools on active links, newest suggestion first", async () => {
    const older = await saved();
    const newer = await saved();
    const archived = await saved();
    const kept = await saved();
    clock = day(1);
    await keepHandy(deps(), A, older, "inferred");
    clock = day(4);
    await keepHandy(deps(), A, newer, "inferred");
    await keepHandy(deps(), A, archived, "inferred");
    await keepHandy(deps(), A, kept, "stated");
    await store.update(A, archived, { state: "archived" });
    expect((await listSuggestions(deps(), A)).map((s) => [s.link.id, s.tool.status])).toEqual([
      [newer, "suggested"],
      [older, "suggested"],
    ]);
  });
});
