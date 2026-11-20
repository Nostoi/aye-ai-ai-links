import { describe, expect, it } from "vitest";
import type { GoneView } from "../core/link-check.js";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { searchPage } from "./pages.js";
import { spacePage } from "./space-page.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const SEPTEMBER = new Date("2026-09-10T12:00:00Z");
const KITCHEN: Tag = {
  key: "kitchen",
  name: "Kitchen",
  kind: "topic",
  kindSource: "stated",
  color: "clay",
  pinned: true,
  description: null,
  projectStatus: null,
};
const GONE: GoneView = {
  since: new Date("2026-10-10T00:00:00Z"),
  checkedAt: new Date("2026-10-13T00:00:00Z"),
};
const link = (id: string, savedAt = NOW): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  summarySource: null,
  why: { text: `because ${id}`, source: "stated" },
  tags: [
    { key: "kitchen", name: "Kitchen", source: "stated", kind: "topic", kindSource: "stated" },
  ],
  savedAt,
  savedBy: "t",
  lastOpenedAt: null,
  intent: "explore",
  intentSource: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});
const COPIES = new Map(["7", "8", "9"].map((id) => [id, { madeAt: NOW }]));
const common = {
  catalog: [KITCHEN],
  images: new Map(),
  handy: new Map(),
  copies: COPIES,
  now: NOW,
};
const gone = new Map([
  ["7", GONE],
  ["9", GONE],
]);
const PAGES: [string, string, (links: Link[], over?: { older?: string | null }) => string][] = [
  [
    "All links",
    "all-error",
    (links, over = {}) =>
      allPage({ ...common, links, older: over.older ?? null, gone, order: "newest", done: false }),
  ],
  [
    "a space page",
    "space-error",
    (links) => spacePage({ ...common, links, older: null, gone, tag: KITCHEN, done: false }),
  ],
  ["search results", "results-error", (links) => searchPage({ ...common, links, query: "", gone })],
];

type Action = { name: string; select: string; url: string; undo: string; json?: unknown };
const card = (id: string) => `[data-id='${id}']`;
type Key = "archive" | "bring" | "delete" | "keep" | "copy" | "still";
const CHANGE = {
  before: { state: "active", snoozedUntil: null },
  after: { state: "archived" },
};
const ACTIONS: Record<Key, Action> = {
  archive: {
    name: "Archive",
    select: ".card-menu button[data-act=archive]",
    url: "/home/archive",
    undo: "Archived. Off Home, All links and your spaces. Still findable in search.",
    json: CHANGE,
  },
  bring: {
    name: "Bring it back",
    select: ".card-menu button[data-act=bring-back]",
    url: "/home/bring-back",
    undo: "Brought back.",
    json: CHANGE,
  },
  delete: {
    name: "Delete link",
    select: ".card-menu button[data-act=delete-link]",
    url: "/links/delete",
    undo: "Link deleted.",
  },
  keep: {
    name: "Keep handy",
    select: ".card-menu button[data-act=keep]",
    url: "/tools/keep",
    undo: "Kept on your Handy shelf.",
    json: { tool: { status: "kept" }, previous: null },
  },
  copy: {
    name: "Remove saved copy",
    select: ".card-menu button[data-act=remove-copy]",
    url: "/links/copy/remove",
    undo: "Saved copy removed.",
  },
  still: {
    name: "It still works",
    select: "[data-gone] button[data-act=still-works]",
    url: "/links/still-works",
    undo: "Marked as working.",
    json: { check: { at: 1 }, previous: null },
  },
};
const held = () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
};
/** The answers an action gets when nothing is wrong. */
const fine = (s: Post): Answer => {
  const known = Object.values(ACTIONS).find((a) => a.url === s.url);
  return known?.json ? { status: 200, body: known.json } : { status: 204 };
};
const sentUrls = (p: ReturnType<typeof runPage>) =>
  p.sent.filter((s) => s.body !== undefined).map((s) => s.url);
const undoText = (p: ReturnType<typeof runPage>) => p.$("#undo-bar span").textContent?.trim();
const press = async (p: ReturnType<typeof runPage>, id: string, a: Action) => {
  p.dispatch(p.$(`${card(id)} ${a.select}`), "click");
  await p.settle();
};

/** Archive is held against every other action on an active card, in both orders. */
const ARCHIVE_PAIRS: [Key, Key][] = (["delete", "keep", "copy", "still"] as const).flatMap(
  (other) => [
    ["archive", other],
    [other, "archive"],
  ],
);
const PAIRS: [Key, Key][] = [
  ...ARCHIVE_PAIRS,
  ["keep", "delete"],
  ["delete", "keep"],
  ["copy", "delete"],
  ["delete", "copy"],
  ["still", "delete"],
  ["delete", "still"],
];
const CASES = PAIRS.flatMap(([first, second]) =>
  (ACTIONS[first].json ? ["headers", "body"] : ["headers"]).map(
    (mode) => [first, second, mode] as const,
  ),
);

describe.each(PAGES)("%s: a card takes one action at a time", (_, errorId, html) => {
  const links = [link("7"), link("8")];

  it.each(CASES)(
    "%s then %s sends nothing while the first is out (held at its %s)",
    async (firstKey, secondKey, mode) => {
      const first = ACTIONS[firstKey];
      const second = ACTIONS[secondKey];
      const { gate, release } = held();
      const p = runPage(html(links), (s) => {
        const base = fine(s);
        return s.url === first.url
          ? { ...base, ...(mode === "body" ? { bodyWait: gate } : { wait: gate }) }
          : base;
      });
      await press(p, "7", first);
      await press(p, "7", second);
      expect(sentUrls(p)).toEqual([first.url]);
      release();
      await p.settle();
      expect(sentUrls(p)).toEqual([first.url]);
      expect(undoText(p)).toBe(first.undo);
      expect(p.$(`#${errorId}`).textContent).toBe("");
    },
  );

  it.each(["archive", "keep", "copy", "still"] as const)(
    "Delete link posts once %s has finished, and its Undo is the one offered",
    async (firstKey) => {
      const first = ACTIONS[firstKey];
      const p = runPage(html(links), fine);
      await press(p, "7", first);
      expect(undoText(p)).toBe(first.undo);
      await press(p, "7", ACTIONS.delete);
      expect(sentUrls(p)).toEqual([first.url, "/links/delete"]);
      expect(undoText(p)).toBe("Link deleted.");
    },
  );

  describe.each([
    ["is refused", { status: 409, body: { message: "Changed since." } }, false],
    ["fails on the network", { status: 0, networkFails: true }, false],
    ["answers with a body that is not JSON", { status: 200 }, true],
  ] as [string, Answer, boolean][])("an action that %s", (_title, bad, jsonOnly) => {
    it.each(
      (Object.keys(ACTIONS) as Key[]).filter(
        (k) => k !== "bring" && (!jsonOnly || ACTIONS[k].json),
      ),
    )("leaves the card free for %s to be tried again", async (key) => {
      const a = ACTIONS[key];
      const p = runPage(html(links), (s) => (s.url === a.url ? bad : fine(s)));
      await press(p, "7", a);
      expect(p.$("#undo-bar").hidden).toBe(true);
      await press(p, "7", a);
      expect(sentUrls(p)).toEqual([a.url, a.url]);
    });
  });
});

describe("All links, on a card Show older appended", () => {
  it("takes one action at a time", async () => {
    const first = html([link("7")], "c1");
    const next = html([link("9", SEPTEMBER)]);
    const { gate, release } = held();
    const p = runPage(first, (s) =>
      s.body === undefined
        ? { status: 200, text: next }
        : s.url === "/home/archive"
          ? { status: 200, body: CHANGE, wait: gate }
          : { status: 204 },
    );
    p.dispatch(p.$("#older"), "click");
    await p.settle();
    await press(p, "9", ACTIONS.archive);
    await press(p, "9", ACTIONS.delete);
    expect(sentUrls(p)).toEqual(["/home/archive"]);
    release();
    await p.settle();
    expect(undoText(p)).toBe(
      "Archived. Off Home, All links and your spaces. Still findable in search.",
    );
  });

  function html(links: Link[], older: string | null = null) {
    return allPage({ ...common, links, older, gone, order: "newest", done: false });
  }
});

describe("the edit dialog's Delete link", () => {
  it("sends nothing while another action holds the card, and does once it is free", async () => {
    const { gate, release } = held();
    const p = runPage(
      allPage({
        ...common,
        links: [link("7"), link("8")],
        older: null,
        gone,
        order: "newest",
        done: false,
      }),
      (s) =>
        s.url === "/home/archive" ? { status: 200, body: CHANGE, wait: gate } : { status: 204 },
    );
    const dialog = stubDialog(p);
    await press(p, "7", ACTIONS.archive);
    p.dispatch(p.$(`${card("7")} button[data-act=edit]`), "click");
    await p.settle();
    expect(dialog.open).toBe(true);
    p.dispatch(p.$("[data-edit=delete]"), "click");
    await p.settle();
    expect(sentUrls(p)).toEqual(["/home/archive"]);
    release();
    await p.settle();
    expect(undoText(p)).toBe(
      "Archived. Off Home, All links and your spaces. Still findable in search.",
    );
  });
});

/** Bring it back lives on archived rows: search lists every state, the done pages only archived ones. */
const archived = (id: string): Link => ({ ...link(id), state: "archived" });
const ARCHIVED_PAGES: [string, string, (links: Link[]) => string][] = [
  [
    "Archived on All links",
    "all-error",
    (links) => allPage({ ...common, links, older: null, gone, order: "newest", done: true }),
  ],
  [
    "a space's Archived",
    "space-error",
    (links) => spacePage({ ...common, links, older: null, gone, tag: KITCHEN, done: true }),
  ],
  ["search results", "results-error", (links) => searchPage({ ...common, links, query: "", gone })],
];
const BRING_PAIRS: [Key, Key][] = (["delete", "copy"] as const).flatMap((other) => [
  ["bring", other],
  [other, "bring"],
]);

describe.each(ARCHIVED_PAGES)(
  "%s: Bring it back takes one action at a time",
  (_, errorId, html) => {
    const links = [archived("7"), archived("8")];

    it.each(BRING_PAIRS)("%s then %s sends nothing while the first is out", async (a, b) => {
      const first = ACTIONS[a];
      const { gate, release } = held();
      const p = runPage(html(links), (s) =>
        s.url === first.url ? { ...fine(s), wait: gate } : fine(s),
      );
      await press(p, "7", first);
      await press(p, "7", ACTIONS[b]);
      expect(sentUrls(p)).toEqual([first.url]);
      release();
      await p.settle();
      expect(sentUrls(p)).toEqual([first.url]);
      expect(undoText(p)).toBe(first.undo);
      expect(p.$(`#${errorId}`).textContent).toBe("");
    });

    it.each(["Delete link", "Remove saved copy"])(
      "%s posts once Bring it back has finished, and its Undo is the one offered",
      async (name) => {
        const next = name === "Delete link" ? ACTIONS.delete : ACTIONS.copy;
        const p = runPage(html(links), fine);
        await press(p, "7", ACTIONS.bring);
        expect(undoText(p)).toBe("Brought back.");
        await press(p, "7", next);
        expect(sentUrls(p)).toEqual(["/home/bring-back", next.url]);
        expect(undoText(p)).toBe(next.undo);
      },
    );
  },
);

/** The words a card's visible button shows while its action is out; a ⋯ menu row closes and only dims. */
const GONE_ARCHIVE = {
  name: "Archive (gone band)",
  select: "[data-gone] button[data-act=gone-archive]",
  url: "/home/archive",
  undo: "",
  json: CHANGE,
};
const LOOKS: [string, Action, string | null][] = [
  ["Archive", ACTIONS.archive, null],
  ["Delete link", ACTIONS.delete, null],
  ["Keep handy", ACTIONS.keep, null],
  ["Remove saved copy", ACTIONS.copy, null],
  ["It still works", ACTIONS.still, "Checking…"],
  ["the gone band's Archive", GONE_ARCHIVE, "Archiving…"],
];

describe.each(PAGES)(
  "%s: the busy look of an action that is slow to answer (#314)",
  (_, __, html) => {
    const labelIn = (button: Element) =>
      (button.querySelector(".slide-words > span") ?? button).textContent?.trim();
    const labelOf = (p: ReturnType<typeof runPage>, a: Action) =>
      labelIn(p.$(`${card("7")} ${a.select}`));

    it.each(LOOKS)(
      "%s: nothing before 300ms, then the card dims and the button says its working word; both clear on the answer",
      async (_name, a, word) => {
        const { gate, release } = held();
        const p = runPage(html([link("7"), link("8")]), (s) => {
          const base = fine(s);
          return s.url === a.url ? { ...base, wait: gate } : base;
        });
        const target = p.$(`${card("7")} ${a.select}`);
        const rest = labelIn(target);
        p.dispatch(target, "click");
        await p.settle();
        expect(p.timers.pending(300)).toBe(1);
        expect(p.$(card("7")).hasAttribute("data-busy")).toBe(false);
        expect(labelOf(p, a)).toBe(rest);
        p.timers.fire();
        expect(p.$(card("7")).hasAttribute("data-busy")).toBe(true);
        expect(p.$(card("8")).hasAttribute("data-busy")).toBe(false);
        expect(labelIn(target)).toBe(word ?? rest);
        expect(target.hasAttribute("data-working")).toBe(word !== null);
        release();
        await p.settle();
        expect(p.document.querySelector("[data-busy]")).toBeNull();
        expect(labelIn(target)).toBe(rest);
        expect(target.hasAttribute("data-working")).toBe(false);
      },
    );

    it("a second press on the busy card sends nothing and changes no label", async () => {
      const { gate, release } = held();
      const p = runPage(html([link("7"), link("8")]), (s) =>
        s.url === ACTIONS.still.url ? { ...fine(s), wait: gate } : fine(s),
      );
      p.dispatch(p.$(`${card("7")} ${ACTIONS.still.select}`), "click");
      await p.settle();
      p.dispatch(p.$(`${card("7")} ${GONE_ARCHIVE.select}`), "click");
      await p.settle();
      p.timers.fire();
      expect(labelOf(p, GONE_ARCHIVE)).toBe("Archive");
      expect(sentUrls(p)).toEqual([ACTIONS.still.url]);
      release();
      await p.settle();
    });

    it("shows nothing for a fast answer: no timer is left to fire", async () => {
      const p = runPage(html([link("7"), link("8")]), fine);
      await press(p, "7", ACTIONS.still);
      expect(p.timers.pending(300)).toBe(0);
      p.timers.fire();
      expect(p.document.querySelector("[data-busy]")).toBeNull();
    });

    it("clears the look when the action is refused", async () => {
      const { gate, release } = held();
      const p = runPage(html([link("7"), link("8")]), (s) =>
        s.url === ACTIONS.still.url
          ? { status: 409, body: { message: "no" }, wait: gate }
          : fine(s),
      );
      p.dispatch(p.$(`${card("7")} ${ACTIONS.still.select}`), "click");
      await p.settle();
      p.timers.fire();
      expect(p.$(card("7")).hasAttribute("data-busy")).toBe(true);
      release();
      await p.settle();
      expect(p.document.querySelector("[data-busy]")).toBeNull();
      expect(labelOf(p, ACTIONS.still)).toBe("It still works");
    });
  },
);
