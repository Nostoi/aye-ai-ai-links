import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { GoneView } from "../core/link-check.js";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { goneLine } from "./gone-line.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { searchPage } from "./pages.js";
import { spacePage } from "./space-page.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const TAG: Tag = {
  key: "home",
  name: "Home",
  kind: "topic",
  kindSource: "stated",
  color: "teal",
  pinned: true,
  description: null,
  projectStatus: null,
};
const GONE: GoneView = {
  since: new Date("2026-10-10T00:00:00Z"),
  checkedAt: new Date("2026-10-13T00:00:00Z"),
};

const link = (id: string, over: Partial<Link> = {}): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  why: { text: `because ${id}`, source: "stated" },
  tags: [],
  savedAt: new Date("2026-10-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});

const dom = (html: string) => parseHTML(html).document;
const gone = (...ids: string[]) => new Map(ids.map((id) => [id, GONE]));
const lines = (html: string) =>
  [...dom(html).querySelectorAll("[data-gone]")].map((e) =>
    e.closest("[data-id]")?.getAttribute("data-id"),
  );
const buttons = (html: string) =>
  [...dom(html).querySelectorAll("[data-gone] button")].map((b) => b.textContent);

type Builder = (links: Link[], map: Map<string, GoneView | null>, done?: boolean) => string;
const BUILDERS: [string, Builder][] = [
  ["search", (links, map) => searchPage({ query: "", links, now: NOW, gone: map })],
  [
    "all links",
    (links, map, done = false) =>
      allPage({
        order: "newest",
        links,
        older: null,
        catalog: [],
        images: new Map(),
        handy: new Map(),
        gone: map,
        now: NOW,
        done,
      }),
  ],
  [
    "a space",
    (links, map, done = false) =>
      spacePage({
        tag: TAG,
        catalog: [TAG],
        links,
        older: null,
        images: new Map(),
        handy: new Map(),
        gone: map,
        now: NOW,
        done,
      }),
  ],
];

describe("goneLine", () => {
  it("is empty without a view", () => {
    expect(goneLine(link("1"), null)).toBe("");
    expect(goneLine(link("1"), undefined)).toBe("");
  });

  it("says the page seems gone, with no date or count, and offers both buttons on an active link", () => {
    const part = dom(goneLine(link("1"), GONE));
    expect(part.querySelector("[data-gone] p")?.textContent).toBe("This page seems gone");
    expect(part.querySelector("[data-gone]")?.textContent).not.toMatch(/\d/);
    expect(buttons(goneLine(link("1"), GONE))).toEqual(["It still works", "I'm done with it"]);
  });

  it("gives an archived link the line alone, and never the needs-you amber", () => {
    const html = goneLine(link("1", { state: "archived" }), GONE);
    expect(html).toContain("data-gone");
    expect(buttons(html)).toEqual([]);
    expect(goneLine(link("1"), GONE)).not.toContain("needs-you");
  });
});

describe.each(BUILDERS)("the gone line on %s", (_, build) => {
  it("shows on a flagged link's card and not on an unflagged one", () => {
    const html = build([link("1"), link("2")], gone("1"));
    expect(lines(html)).toEqual(["1"]);
    expect(lines(build([link("1")], new Map([["1", null]])))).toEqual([]);
  });

  it("puts buttons on the active cards only, and never marks a gone card needs-you", () => {
    const html = build([link("1"), link("2", { state: "archived" })], gone("1", "2"));
    expect(lines(html)).toEqual(["1", "2"]);
    expect(
      [...dom(html).querySelectorAll("[data-gone] button")].map((b) =>
        b.closest("[data-id]")?.getAttribute("data-id"),
      ),
    ).toEqual(["1", "1"]);
    expect(dom(html).querySelector("[data-gone].needs-you, .needs-you [data-gone]")).toBeNull();
  });

  it("carries the script", () => {
    expect(build([link("1")], gone("1"))).toContain("/links/still-works");
  });
});

describe("the gone line's saved-copy link", () => {
  it("carries data-act=read-copy with a copy, and the line is unchanged without one", () => {
    const withCopy = dom(goneLine(link("1"), GONE, { madeAt: new Date(0) }));
    expect(withCopy.querySelector("a")?.getAttribute("data-act")).toBe("read-copy");
    expect(goneLine(link("1"), GONE)).not.toContain("read-copy");
  });
});

describe.each(BUILDERS.slice(1))("the gone line on done pages of %s", (_, build) => {
  it("shows the line only: no buttons and no script", () => {
    const html = build([link("1", { state: "archived" })], gone("1"), true);
    expect(lines(html)).toEqual(["1"]);
    expect(buttons(html)).toEqual([]);
    expect(html).not.toContain("/links/still-works");
  });
});

const CHECK = {
  checkedAt: "2026-10-16T10:00:00.000Z",
  result: "alive",
  stillWorksAt: "2026-10-16T10:00:00.000Z",
};
const PREVIOUS = { checkedAt: "2026-10-13T00:00:00.000Z", result: "dead", stillWorksAt: null };
const WORKS = { status: 200, body: { check: CHECK, previous: PREVIOUS } } as const;

/** A search page with a gone link "7" and an error line. */
function load(answer: (sent: Post) => Answer) {
  const html = searchPage({ query: "", links: [link("7")], now: NOW, gone: gone("7") });
  return runPage(html, answer);
}
const post = (url: string, body: unknown): Post => ({
  url,
  body,
  redirect: "manual",
  keepalive: undefined,
});
const click = async (p: ReturnType<typeof runPage>, selector: string) => {
  p.dispatch(p.$(selector), "click");
  await p.settle();
};

describe("the gone line's buttons", () => {
  it("It still works posts the id, hides the line and offers Undo", async () => {
    const p = load(() => WORKS);
    await click(p, "button[data-act=still-works]");
    expect(p.sent).toEqual([post("/links/still-works", { id: "7" })]);
    expect(p.$("[data-gone]").hidden).toBe(true);
    expect(p.$("li[data-id]").hidden).toBe(false);
    expect(p.$("#undo-bar span").textContent).toBe("Marked as working.");
  });

  it("its Undo sends back the rows it got and shows the line again on 204", async () => {
    const p = load((s) => (s.url === "/links/still-works/undo" ? { status: 204 } : WORKS));
    await click(p, "button[data-act=still-works]");
    await click(p, "#undo-bar button");
    expect(p.sent[1]).toEqual(
      post("/links/still-works/undo", { id: "7", check: CHECK, previous: PREVIOUS }),
    );
    expect(p.$("[data-gone]").hidden).toBe(false);
  });

  it("an Undo answered 409 shows the message and keeps the line hidden", async () => {
    const p = load((s) =>
      s.url === "/links/still-works/undo"
        ? { status: 409, body: { code: "conflict", message: "Checked since." } }
        : WORKS,
    );
    await click(p, "button[data-act=still-works]");
    await click(p, "#undo-bar button");
    expect(p.$("[data-gone]").hidden).toBe(true);
    expect(p.$("#results-error").textContent).toBe("Checked since.");
  });

  it("a 409 on It still works shows the message, changes nothing and offers no Undo", async () => {
    const p = load(() => ({
      status: 409,
      body: { code: "conflict", message: "Not marked as gone." },
    }));
    await click(p, "button[data-act=still-works]");
    expect(p.$("[data-gone]").hidden).toBe(false);
    expect(p.$("#results-error").textContent).toBe("Not marked as gone.");
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect((p.$("button[data-act=still-works]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("I'm done with it posts /home/archive, hides the card, and its Undo restores it", async () => {
    const p = load(() => ({ status: 204 }));
    await click(p, "button[data-act=gone-done]");
    expect(p.sent).toEqual([post("/home/archive", { id: "7" })]);
    expect(p.$("li[data-id]").hidden).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe("Moved out of your list.");
    await click(p, "#undo-bar button");
    expect(p.sent[1]).toEqual(post("/home/unarchive", { id: "7" }));
    expect(p.$("li[data-id]").hidden).toBe(false);
  });

  it("a refused I'm done with it shows the message and leaves the card", async () => {
    const p = load(() => ({ status: 404, body: { code: "not_found", message: "Gone." } }));
    await click(p, "button[data-act=gone-done]");
    expect(p.$("li[data-id]").hidden).toBe(false);
    expect(p.$("#results-error").textContent).toBe("Gone.");
  });

  it("sends nothing for a second click while the first is waiting", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = load(() => ({ ...WORKS, wait }));
    p.dispatch(p.$("button[data-act=still-works]"), "click");
    p.dispatch(p.$("button[data-act=gone-done]"), "click");
    release();
    await p.settle();
    expect(p.sent).toHaveLength(1);
  });

  it("also answers on a card Show older appended", async () => {
    const first = allPage({
      order: "newest",
      links: [link("1")],
      older: "c1",
      catalog: [],
      images: new Map(),
      handy: new Map(),
      gone: new Map(),
      now: NOW,
      done: false,
    });
    const next = allPage({
      order: "newest",
      links: [link("9", { savedAt: new Date("2026-09-01T00:00:00Z") })],
      older: null,
      catalog: [],
      images: new Map(),
      handy: new Map(),
      gone: gone("9"),
      now: NOW,
      done: false,
      later: true,
    });
    const p = runPage(first, (s) => (s.body === undefined ? { status: 200, text: next } : WORKS));
    await click(p, "#older");
    await click(p, "[data-id='9'] button[data-act=still-works]");
    expect(p.sent.at(-1)).toEqual(post("/links/still-works", { id: "9" }));
    expect(p.$("[data-id='9'] [data-gone]").hidden).toBe(true);
  });
});
