import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Space } from "../core/link-space.js";
import type { Link } from "../core/types.js";
import { linkRow, VIEW_COOKIE, viewOf, viewScript, viewSwitch } from "./link-rows.js";
import { runPage } from "./opened-test-kit.js";
import { page } from "./page.js";

const KITCHEN: Space = { key: "kitchen", name: "Kitchen", color: "clay" };
const link = (over: Partial<Link> = {}): Link => ({
  id: "7",
  url: "https://ex.com/7",
  urlKey: "ex.com/7",
  title: "Seven",
  summary: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-10-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});
const row = (l: Link, over: Partial<Parameters<typeof linkRow>[1]> = {}) =>
  parseHTML(`<ul>${linkRow(l, { space: null, lineSpace: null, ...over })}</ul>`).document;

describe("viewOf", () => {
  it("reads Pictures only from exactly that cookie value, and List from anything else", () => {
    expect(VIEW_COOKIE).toBe("aye_view");
    expect(viewOf("pictures")).toBe("pictures");
    for (const v of [undefined, "", "list", "Pictures", "pictures;", "grid"]) {
      expect(viewOf(v), String(v)).toBe("list");
    }
  });
});

describe("a link row", () => {
  it("shows the title, then the why, then the grey line, with the menu last", () => {
    const d = row(link({ why: { text: "for <the> shed", source: "stated" } }), {
      lineSpace: KITCHEN,
    });
    const body = d.querySelector(".link-row > .row-body");
    expect([...(body?.children ?? [])].map((e) => e.className || e.tagName)).toEqual([
      "H3",
      "row-why",
      "card-line",
    ]);
    expect(d.querySelector(".row-why")?.textContent).toBe('"for <the> shed"');
    expect(d.querySelector(".link-row")?.lastElementChild?.className).toBe("card-menu");
    expect(d.querySelector(".link-row > [data-pic]")?.className).toContain("row-pic");
    expect(d.querySelector("h3[data-card-title] a")?.getAttribute("target")).toBe("_blank");
  });

  it("labels an AI's why as a guess", () => {
    const d = row(link({ why: { text: "outage backup", source: "inferred" } }));
    expect(d.querySelector(".row-why")?.textContent).toBe("Why (a guess): outage backup");
  });

  it("shows no why line without a why, unless it asks Tell me why with a slot for the answer", () => {
    expect(row(link()).querySelector(".row-why, .ask")).toBeNull();
    const asked = row(link(), { ask: true });
    expect(asked.querySelector("button[data-act=why]")?.textContent).toBe("Tell me why");
    const answer = asked.querySelector("[data-why-answer]");
    expect(answer?.className).toBe("row-why");
    expect(answer?.hasAttribute("hidden")).toBe(true);
    // A link with a why never asks.
    const known = row(link({ why: { text: "x", source: "stated" } }), { ask: true });
    expect(known.querySelector(".ask")).toBeNull();
  });

  it("shows the summary, escaped, in the why's place when there is no why", () => {
    const d = row(link({ summary: "<b>x</b>" }));
    const body = d.querySelector(".link-row > .row-body");
    expect([...(body?.children ?? [])].map((e) => e.className || e.tagName)).toEqual([
      "H3",
      "row-about",
      "card-line",
    ]);
    expect(d.querySelector(".row-about")?.innerHTML).toBe("&lt;b&gt;x&lt;/b&gt;");
    expect(d.querySelector("b")).toBeNull();
  });

  it("shows no summary on a row with a why, and none on a row with neither", () => {
    const withWhy = row(link({ summary: "A summary", why: { text: "w", source: "stated" } }));
    expect(withWhy.querySelector(".row-about")).toBeNull();
    expect(withWhy.querySelector(".row-why")?.textContent).toBe('"w"');
    expect(row(link()).querySelector(".row-about")).toBeNull();
    const guess = row(link({ summary: "A summary", why: { text: "w", source: "inferred" } }));
    expect(guess.querySelector(".row-about")).toBeNull();
    expect(guess.querySelector(".row-why")?.textContent).toBe("Why (a guess): w");
  });

  it("puts the summary before Tell me why, which stays, on a row that asks", () => {
    const d = row(link({ summary: "A summary" }), { ask: true });
    const body = d.querySelector(".link-row > .row-body");
    expect([...(body?.children ?? [])].map((e) => e.className || e.tagName)).toEqual([
      "H3",
      "row-about",
      "row-why",
      "ask",
      "card-line",
    ]);
    expect(d.querySelector("button[data-act=why]")?.textContent).toBe("Tell me why");
  });

  it("takes its color from `space` and names `lineSpace` on its grey line", () => {
    const d = row(link(), { space: KITCHEN, lineSpace: null, faded: true });
    expect(d.querySelector(".link-row")?.className).toBe("link-row space-clay faded");
    expect(d.querySelector(".card-line .line-space:not([hidden])")).toBeNull();
  });
});

describe("the List / Pictures switch", () => {
  it("presses the current view's button, each at least a real button", () => {
    const d = parseHTML(viewSwitch("pictures")).document;
    const buttons = [...d.querySelectorAll(".view-switch button")];
    expect(d.querySelector(".view-switch")?.getAttribute("role")).toBe("group");
    expect(d.querySelector(".view-switch")?.getAttribute("aria-label")).toBe("View");
    expect(
      buttons.map((b) => [b.textContent, b.getAttribute("type"), b.getAttribute("aria-pressed")]),
    ).toEqual([
      ["List", "button", "false"],
      ["Pictures", "button", "true"],
    ]);
  });

  it("switches the page's view at once and remembers it in a cookie for a year", () => {
    const html = page(
      "x",
      `<main data-view="list">${viewSwitch("list")}<ul class="link-rows"></ul></main><script>${viewScript}</script>`,
    );
    const p = runPage(html);
    p.dispatch(p.$(".view-switch button[data-choice=pictures]"), "click");
    expect(p.$("main").getAttribute("data-view")).toBe("pictures");
    expect(p.$("[data-choice=pictures]").getAttribute("aria-pressed")).toBe("true");
    expect(p.$("[data-choice=list]").getAttribute("aria-pressed")).toBe("false");
    expect(p.document.cookie).toBe("aye_view=pictures; path=/; max-age=31536000; samesite=lax");
    p.dispatch(p.$(".view-switch button[data-choice=list]"), "click");
    expect(p.$("main").getAttribute("data-view")).toBe("list");
    expect(p.document.cookie).toContain("aye_view=list;");
  });

  it("works on a page with no links, where there is no list", () => {
    const html = page(
      "x",
      `<main data-view="list">${viewSwitch("list")}<p>No links yet.</p></main><script>${viewScript}</script>`,
    );
    const p = runPage(html);
    p.dispatch(p.$("[data-choice=pictures]"), "click");
    expect(p.$("main").getAttribute("data-view")).toBe("pictures");
    expect(p.document.cookie).toContain("aye_view=pictures;");
  });
});
