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
  why: { text: `because ${id}`, source: "stated" },
  tags: [
    { key: "kitchen", name: "Kitchen", source: "stated", kind: "topic", kindSource: "stated" },
  ],
  savedAt,
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
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
type Key = "done" | "delete" | "keep" | "copy" | "still";
const ACTIONS: Record<Key, Action> = {
  done: {
    name: "It's stale",
    select: ".card-menu button[data-act=archive]",
    url: "/home/archive",
    undo: "Let go. You won't see it again unless you search for it.",
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
const undoText = (p: ReturnType<typeof runPage>) => p.$("#undo-bar span").textContent;
const press = async (p: ReturnType<typeof runPage>, id: string, a: Action) => {
  p.dispatch(p.$(`${card(id)} ${a.select}`), "click");
  await p.settle();
};

const PAIRS: [Key, Key][] = [
  ["done", "delete"],
  ["delete", "done"],
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

  it.each(["done", "keep", "copy", "still"] as const)(
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
    it.each((Object.keys(ACTIONS) as Key[]).filter((k) => !jsonOnly || ACTIONS[k].json))(
      "leaves the card free for %s to be tried again",
      async (key) => {
        const a = ACTIONS[key];
        const p = runPage(html(links), (s) => (s.url === a.url ? bad : fine(s)));
        await press(p, "7", a);
        expect(p.$("#undo-bar").hidden).toBe(true);
        await press(p, "7", a);
        expect(sentUrls(p)).toEqual([a.url, a.url]);
      },
    );
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
          ? { status: 204, wait: gate }
          : { status: 204 },
    );
    p.dispatch(p.$("#older"), "click");
    await p.settle();
    await press(p, "9", ACTIONS.done);
    await press(p, "9", ACTIONS.delete);
    expect(sentUrls(p)).toEqual(["/home/archive"]);
    release();
    await p.settle();
    expect(undoText(p)).toBe("Let go. You won't see it again unless you search for it.");
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
      (s) => (s.url === "/home/archive" ? { status: 204, wait: gate } : { status: 204 }),
    );
    const dialog = stubDialog(p);
    await press(p, "7", ACTIONS.done);
    p.dispatch(p.$(`${card("7")} button[data-act=edit]`), "click");
    await p.settle();
    expect(dialog.open).toBe(true);
    p.dispatch(p.$("[data-edit=delete]"), "click");
    await p.settle();
    expect(sentUrls(p)).toEqual(["/home/archive"]);
    release();
    await p.settle();
    expect(undoText(p)).toBe("Let go. You won't see it again unless you search for it.");
  });
});
