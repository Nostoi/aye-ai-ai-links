import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { MAX_TEXT_CHARS } from "../ai/chat-turn.js";
import { homePage } from "./home-page.js";
import { runAskPage } from "./opened-test-kit.js";
import { page } from "./page.js";
import { SEARCH_PLACEHOLDER, searchPage } from "./pages.js";
import { tagsPage } from "./tags-page.js";
import { themeCss } from "./theme.js";

/** Search from every menu page (#264): the bar's magnifier, the / key, the placeholder and Ask AI's handoff. */

const ASK = { ai: "Fake", place: "Search", owner: "owner-a" };
const NOW = new Date("2026-10-14T10:00:00Z");
const search = (query: string, ask?: typeof ASK) =>
  searchPage({ query, links: [], now: NOW, ...(ask ? { ask } : {}) });
const doc = (html: string) => parseHTML(html).document;
const HOME = {
  worth: { links: [], images: new Map(), now: new Date(0), catalog: [], gone: null },
  shelf: "",
  spaces: "",
};

describe("the magnifier in the bar", () => {
  const magnifier = (html: string) => doc(html).querySelector('nav.menu > a[href="/search"]');

  it("is a link to /search named Search, with its icon hidden from screen readers", () => {
    const a = magnifier(page("t", "<main></main>", { menu: true, here: "all" }));
    expect(a).not.toBeNull();
    expect(a?.getAttribute("aria-label")).toBe("Search");
    expect(a?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is on a menu page that is not Home, and on the search page itself", () => {
    expect(magnifier(tagsPage({ tags: [] }))).not.toBeNull();
    expect(magnifier(search("x"))).not.toBeNull();
    expect(magnifier(page("t", "<main></main>", { menu: true }))).not.toBeNull();
  });

  it("is left out of Home, in the bar and in the phone menu", () => {
    const html = page("t", "<main></main>", { menu: true, here: "home" });
    expect(doc(html).querySelector('a[href="/search"]')).toBeNull();
    expect(doc(homePage(HOME)).querySelector('nav.menu a[href="/search"]')).toBeNull();
  });

  it("sits before Ask AI, in the bar itself: not a link the phone hides", () => {
    const a = magnifier(page("t", "<main></main>", { menu: true, ask: ASK })) as Element;
    expect(a.className).not.toContain("menu-page");
    expect(a.className).not.toContain("menu-phone-only");
    expect(a.nextElementSibling?.id).toBe("ask-open");
    expect(themeCss).toMatch(/\.menu-search\{[^}]*min-height:44px[^}]*min-width:44px/);
  });
});

describe("the search page's field", () => {
  const field = (html: string) => doc(html).getElementById("q") as Element;

  it("takes focus when the query is blank, and not when there is one", () => {
    expect(field(search("")).hasAttribute("autofocus")).toBe(true);
    expect(field(search("   ")).hasAttribute("autofocus")).toBe(true);
    expect(field(search("batteries")).hasAttribute("autofocus")).toBe(false);
  });

  it("shows the same placeholder as Home's field", () => {
    expect(SEARCH_PLACEHOLDER).toBe("That article about batteries and the tax credit");
    expect(field(search("")).getAttribute("placeholder")).toBe(SEARCH_PLACEHOLDER);
    expect(field(homePage(HOME)).getAttribute("placeholder")).toBe(SEARCH_PLACEHOLDER);
  });

  it("colours the placeholder with the soft token, and hides the / badge on touch screens", () => {
    expect(themeCss).toMatch(/\.search-box input::placeholder\{color:var\(--soft\)\}/);
    expect(themeCss).toMatch(/@media \(hover:none\)\{\.search-box kbd\{display:none\}\}/);
  });
});

describe("the Ask AI button under Not it?", () => {
  const button = (html: string) => doc(html).querySelector(".not-it [data-ask-text]");

  it("shows with the AI set up and a query, carrying the query", () => {
    const b = button(search("tax <credit>", ASK));
    expect(b?.tagName).toBe("BUTTON");
    expect(b?.getAttribute("type")).toBe("button");
    expect(b?.getAttribute("data-ask-text")).toBe("tax <credit>");
    expect(b?.textContent).toBe("Ask AI about “tax <credit>”");
  });

  it("shortens a long query in its label, and still carries all of it", () => {
    const long = `${"😀".repeat(59)}${"b".repeat(200)}`;
    const b = button(search(long, ASK));
    expect(b?.getAttribute("data-ask-text")).toBe(long);
    expect(b?.textContent).toBe(`Ask AI about “${"😀".repeat(59)}b…”`);
    expect(button(search("a".repeat(60), ASK))?.textContent).toBe(
      `Ask AI about “${"a".repeat(60)}”`,
    );
  });

  it("escapes the query", () => {
    expect(search('"><b>x</b>', ASK)).not.toContain("<b>x</b>");
  });

  it("is not there without the AI, and the page has no trace of it", () => {
    expect(search("tax")).not.toContain("data-ask-text");
  });

  it("is not there for a blank query", () => {
    expect(button(search("", ASK))).toBeNull();
    expect(button(search("  ", ASK))).toBeNull();
  });

  it("is there at the textarea's longest message and gone one character past it", () => {
    expect(button(search("a".repeat(MAX_TEXT_CHARS), ASK))).not.toBeNull();
    expect(button(search("a".repeat(MAX_TEXT_CHARS + 1), ASK))).toBeNull();
  });
});

describe("the / key", () => {
  const withQ = `<main><input id="q"><button id="other">x</button><div id="edit">e</div><dialog id="d"></dialog></main>`;
  const noQ = `<main><button id="other">x</button><dialog id="d"></dialog></main>`;
  const start = (body: string, ask = false) =>
    runAskPage(
      page("t", body, { menu: true, ...(ask ? { ask: ASK, undo: true } : {}) }),
      undefined,
      { menu: true },
    );
  type P = ReturnType<typeof start>;
  const press = (p: P, init: Record<string, unknown> = {}, on = "#other") =>
    p.dispatch(p.$(on), "keydown", { key: "/", ...init });

  it("focuses the page's search field and keeps the / out of it", () => {
    const p = start(withQ);
    expect(press(p).defaultPrevented).toBe(true);
    expect(p.focused().at(-1)).toBe(p.$("#q"));
    expect(p.location.href).toBe("https://links.example/");
  });

  it("goes to /search on a page with no search field", () => {
    const p = start(noQ);
    expect(press(p).defaultPrevented).toBe(true);
    expect(p.location.href).toBe("/search");
    expect(p.focused()).toEqual([]);
  });

  it.each([["ctrlKey"], ["metaKey"], ["altKey"]])("ignores it with %s held", (mod) => {
    const p = start(withQ);
    expect(press(p, { [mod]: true }).defaultPrevented).toBe(false);
    expect(p.focused()).toEqual([]);
  });

  it("ignores it typed in a field", () => {
    const p = start(withQ);
    expect(press(p, {}, "#q").defaultPrevented).toBe(false);
    expect(p.focused()).toEqual([]);
  });

  it("ignores it typed in an editable element", () => {
    const p = start(withQ);
    Object.defineProperty(p.$("#edit"), "isContentEditable", { value: true });
    expect(press(p, {}, "#edit").defaultPrevented).toBe(false);
    expect(p.focused()).toEqual([]);
  });

  it("ignores it while a dialog is open, and does not leave the page", () => {
    const p = start(noQ);
    p.$("#d").setAttribute("open", "");
    expect(press(p).defaultPrevented).toBe(false);
    expect(p.location.href).toBe("https://links.example/");
  });

  it("ignores it while the Ask AI panel is open, and works again once it is closed", () => {
    const p = start(withQ, true);
    p.dispatch(p.$("#ask-open"), "click");
    const before = p.focused().length;
    expect(press(p).defaultPrevented).toBe(false);
    expect(p.focused().length).toBe(before);
    p.dispatch(p.$("#ask-close"), "click");
    expect(press(p).defaultPrevented).toBe(true);
    expect(p.focused().at(-1)).toBe(p.$("#q"));
  });

  it("ignores other keys", () => {
    expect(press(start(withQ), { key: "a" }).defaultPrevented).toBe(false);
  });

  it("has one handler on every page, Home's own included", () => {
    expect(homePage(HOME).match(/key !== "\/"/g)).toHaveLength(1);
    expect(page("t", "<main></main>", { menu: true }).match(/key !== "\/"/g)).toHaveLength(1);
  });
});

describe("Ask AI about the search", () => {
  const start = (query = "tax credit") => runAskPage(search(query, ASK), undefined, { menu: true });
  type P = ReturnType<typeof start>;
  const box = (p: P) => p.$("#ask-text") as HTMLTextAreaElement;

  it("opens the panel and fills the empty message box, without sending", () => {
    const p = start();
    p.dispatch(p.$("[data-ask-text]"), "click");
    expect(p.$("#ask-panel").hasAttribute("hidden")).toBe(false);
    expect(box(p).value).toBe("tax credit");
    expect(p.focused().at(-1)).toBe(box(p));
    expect(p.sent).toEqual([]);
  });

  it("opens the panel and leaves a draft already there alone", () => {
    const p = start();
    box(p).value = "my draft";
    p.dispatch(p.$("[data-ask-text]"), "click");
    expect(p.$("#ask-panel").hasAttribute("hidden")).toBe(false);
    expect(box(p).value).toBe("my draft");
    expect(p.sent).toEqual([]);
  });

  it("works when the panel is already open", () => {
    const p = start();
    p.dispatch(p.$("#ask-open"), "click");
    p.dispatch(p.$("[data-ask-text]"), "click");
    expect(p.$("#ask-panel").hasAttribute("hidden")).toBe(false);
    expect(box(p).value).toBe("tax credit");
  });
});
