import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { GoneView } from "../core/link-check.js";
import type { ShelfItem } from "../core/tools.js";
import type { Link } from "../core/types.js";
import { allPage } from "./all-page.js";
import { BAND_COLLAPSE } from "./band-collapse.js";
import { DONE_HINT } from "./done-link.js";
import { goneLine } from "./gone-line.js";
import { handyShelf } from "./handy-shelf.js";
import { homePage, type WorthCards } from "./home-page.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { searchPage } from "./pages.js";
import { themeCss } from "./theme.js";

const NOW = new Date("2026-10-14T12:00:00Z");
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
  summarySource: null,
  why: { text: `because ${id}`, source: "stated" },
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
const dom = (html: string) => parseHTML(html).document;
const gone = (...ids: string[]) => new Map(ids.map((id) => [id, GONE]));
const words = (el: Element | null | undefined) =>
  [...(el?.querySelectorAll("button") ?? [])].map((b) => [
    b.getAttribute("data-act"),
    b.querySelector(".slide-words > span")?.textContent,
    b.querySelector(".slide-words small")?.textContent,
  ]);

/** The CSS declarations of the one rule whose selector list is exactly `selector`. */
const rule = (selector: string) => {
  for (const [, sel = "", body = ""] of themeCss.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (sel.trim() === selector) return body;
  }
  return null;
};

describe("the band's markup", () => {
  it("is the warning, then It still works (a link icon) and Done with it (the box), Done last", () => {
    const band = dom(goneLine(link("1"), GONE)).querySelector("[data-gone].gone-band");
    expect(band?.querySelector("p")?.textContent).toBe("This page seems gone");
    expect(words(band)).toEqual([
      ["still-works", "It still works", "Clears this warning"],
      ["gone-done", "Done with it", DONE_HINT],
    ]);
    expect(band?.querySelector("button svg path")?.getAttribute("d")).toBe(
      "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1",
    );
  });

  it("keeps the warning alone, with no buttons, on a link that is done", () => {
    const band = dom(goneLine(link("1", { state: "archived" }), GONE)).querySelector("[data-gone]");
    expect(band?.textContent?.trim()).toBe("This page seems gone");
    expect(band?.querySelector("button")).toBeNull();
  });

  it("can name the act Done with it carries, and carry a link beside the warning", () => {
    const band = dom(goneLine(link("1"), GONE, { done: "done", read: "/copy/1" })).querySelector(
      "[data-gone]",
    );
    expect(words(band).map((w) => w[0])).toEqual(["still-works", "done"]);
    expect(band?.querySelector("p + a[data-act=read-copy]")?.getAttribute("href")).toBe("/copy/1");
  });
});

describe("where the band sits", () => {
  const all = (links: Link[]) =>
    allPage({
      order: "newest",
      links,
      older: null,
      catalog: [],
      images: new Map(),
      handy: new Map(),
      gone: gone("1"),
      now: NOW,
      done: false,
    });

  it("is the last child of a List or Pictures row, outside the row's body", () => {
    const li = dom(all([link("1")])).querySelector("li.link-row");
    expect(li?.lastElementChild?.classList.contains("gone-band")).toBe(true);
    expect(li?.querySelector(".row-body [data-gone]")).toBeNull();
  });

  it("is the last child of an Also today row, with the saved-copy link beside the warning", () => {
    const g = link("1");
    const worth: WorthCards = {
      links: [],
      images: new Map(),
      now: NOW,
      catalog: [],
      gone: g,
      copies: new Map([[g.id, { madeAt: NOW }]]),
      views: new Map([[g.id, { handy: null, gone: GONE }]]),
    };
    const row = dom(homePage({ worth, shelf: "", spaces: "" })).querySelector(".worth-gone");
    const band = row?.lastElementChild;
    expect(band?.classList.contains("gone-band")).toBe(true);
    expect(band?.querySelector("p + a.gone-copy")?.textContent).toBe("Read the saved copy");
    expect(row?.querySelector(".also-body [data-gone], .also-body .gone-copy")).toBeNull();
  });

  it("stays inside a search result's body, last", () => {
    const body = dom(
      searchPage({ query: "", links: [link("1")], now: NOW, gone: gone("1") }),
    ).querySelector(".result-body");
    expect(body?.lastElementChild?.classList.contains("gone-band")).toBe(true);
  });

  it("comes after the Keep handy control on the Add page", () => {
    const body = dom(
      searchPage({ query: "", links: [link("1")], now: NOW, gone: gone("1"), keep: true }),
    ).querySelector(".result-body");
    const kids = [...(body?.children ?? [])];
    expect(kids.at(-1)?.classList.contains("gone-band")).toBe(true);
    expect(kids.at(-2)?.hasAttribute("data-handy")).toBe(true);
  });

  const item = (over: Partial<ShelfItem> = {}): ShelfItem => ({
    link: link("1"),
    tool: {
      status: "kept",
      source: "stated",
      since: new Date("2026-10-01T00:00:00Z"),
      answeredAt: null,
      waitDays: 30,
    },
    due: false,
    gone: true,
    ...over,
  });
  const shelf = (items: ShelfItem[]) =>
    dom(handyShelf({ items, suggestions: [], catalog: [], images: new Map() })).querySelector(
      ".handy-tile",
    );

  it("is a Handy tile's own band, with the page's words, and the tile no longer needs you", () => {
    const tile = shelf([item()]);
    const band = tile?.querySelector(":scope > .gone-band[data-gone]");
    expect(band?.querySelector("p")?.textContent).toBe("This page seems gone");
    expect(words(band)).toEqual([
      ["still-works", "It still works", "Clears this warning"],
      ["done", "Done with it", DONE_HINT],
    ]);
    expect(tile?.classList.contains("needs-you")).toBe(false);
    expect(tile?.textContent).not.toContain("Seems gone");
    expect(tile?.textContent).not.toContain("It works");
  });

  it("leaves a due tile asking Still using?, amber as before", () => {
    const tile = shelf([item({ gone: false, due: true })]);
    expect(tile?.classList.contains("needs-you")).toBe(true);
    expect(tile?.querySelector(".gone-band")).toBeNull();
  });
});

describe("the band's look", () => {
  it("gives a gone link no amber outline", () => {
    expect(themeCss).not.toMatch(/worth-gone:has/);
  });

  it("keeps a Handy tile's band above the whole-tile title link, in the old ask's stacking", () => {
    const body = rule(".handy-tile .gone-band") ?? "";
    expect(body).toMatch(/position:relative/);
    expect(body).toMatch(/z-index:[2-9]/);
    expect(body).toContain("grid-column:1/-1");
  });

  it("lets Handy tiles keep their own height", () => {
    expect(rule(".handy-row")).toContain("align-items:start");
  });

  it("wraps a List row so the band is a full-width last line, and gives Pictures its own margins", () => {
    expect(rule(".link-row")).toMatch(/flex-wrap:wrap/);
    expect(rule(".link-row .gone-band")).toMatch(/flex:0 0 calc\(100% \+ \d+px\)/);
    expect(rule("[data-view=pictures] .link-row .gone-band")).toMatch(/margin:0/);
  });

  it("never clips a card by rule, so an open menu is not cut off; the slide clips it inline, only while it runs", () => {
    for (const sel of [".link-row", ".worth-row", ".handy-tile", ".result", ".result-body"]) {
      expect(rule(sel) ?? "", sel).not.toMatch(/overflow:hidden/);
    }
    expect(rule(".gone-band.collapsing")).not.toMatch(/overflow|margin|padding|height/);
  });

  it("draws the arrow and the shade", () => {
    expect(rule(".gone-band")).toMatch(
      /linear-gradient\(to bottom,var\(--shade\),var\(--amber-bg\) 20px\)/,
    );
    expect(rule(".gone-band::before")).toMatch(/background:var\(--shade\)/);
    expect(rule(".gone-band::after")).toMatch(/clip-path/);
  });

  it("opens a button over the warning without moving the pair: a fixed-size box, the buttons anchored in it", () => {
    expect(rule(".gone-band")).not.toMatch(/flex-wrap/);
    expect(rule(".gone-actions")).toMatch(/position:relative[^}]*width:92px/);
    expect(rule(".gone-band .slide")).toMatch(/position:absolute/);
    expect(rule(".gone-band .slide:hover,.gone-band .slide:focus-visible")).not.toMatch(
      /flex|width:(?!260)/,
    );
    expect(rule(".gone-band>p")).toMatch(/flex:1 1 0;min-width:0/);
  });

  it("draws its slide buttons bare at rest and filled on hover or focus", () => {
    expect(rule(".gone-band .slide")).toMatch(/background:none/);
    expect(rule(".gone-band .slide:hover,.gone-band .slide:focus-visible")).toMatch(
      /background:var\(--surface\)/,
    );
  });
});

/** The wait before the collapse gives up on a transition that never ends. */
const FALLBACK_MS = 600;
const CHECK = { checkedAt: "2026-10-16T10:00:00.000Z", result: "alive", stillWorksAt: null };
const PREVIOUS = { checkedAt: "2026-10-13T00:00:00.000Z", result: "dead", stillWorksAt: null };
const WORKS = { status: 200, body: { check: CHECK, previous: PREVIOUS } } as const;
const CHANGE = {
  before: { state: "active", putAwayAt: null, snoozedUntil: null },
  after: { state: "archived", putAwayAt: null },
};

/** A search page with a gone link "7", animated (reduced motion off) so the collapse is observable. */
function load(answer: (sent: Post) => Answer) {
  const p = runPage(
    searchPage({ query: "", links: [link("7")], now: NOW, gone: gone("7") }),
    answer,
  );
  p.motion.reduced = false;
  return p;
}
const click = async (p: ReturnType<typeof runPage>, selector: string) => {
  p.dispatch(p.$(selector), "click");
  await p.settle();
};
const ended = async (p: ReturnType<typeof runPage>) => {
  p.dispatch(band(p).closest("[data-id]") as Element, "transitionend", { propertyName: "height" });
  await p.settle();
};
const band = (p: ReturnType<typeof runPage>) => p.$("[data-gone]");
const intact = (p: ReturnType<typeof runPage>) => {
  expect(band(p).hidden).toBe(false);
  expect(band(p).classList.contains("collapsing")).toBe(false);
  expect(band(p).style.height).toBe("");
};

describe("the band's slide-away", () => {
  it("It still works collapses the band only after the server agrees, then hides it and offers Undo", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = load(() => ({ ...WORKS, wait }));
    p.dispatch(p.$("button[data-act=still-works]"), "click");
    await p.settle();
    intact(p);
    release();
    await p.settle();
    expect(band(p).classList.contains("collapsing")).toBe(true);
    expect(band(p).hidden).toBe(false);
    expect(p.$("#undo-bar").hidden).toBe(true);
    await ended(p);
    expect(band(p).hidden).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe("Marked as working.");
    expect(p.timers.pending(FALLBACK_MS)).toBe(0);
  });

  it("falls back to a timer when no transition ends", async () => {
    const p = load(() => WORKS);
    await click(p, "button[data-act=still-works]");
    expect(band(p).hidden).toBe(false);
    p.timers.fire();
    await p.settle();
    expect(band(p).hidden).toBe(true);
  });

  it("finishes at once under reduced motion", async () => {
    const p = load(() => WORKS);
    p.motion.reduced = true;
    await click(p, "button[data-act=still-works]");
    expect(band(p).hidden).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe("Marked as working.");
  });

  it("moves focus to the card's menu once the band is hidden", async () => {
    const p = load(() => WORKS);
    await click(p, "button[data-act=still-works]");
    await ended(p);
    expect(p.focused()).toContain(p.$("li[data-id] .card-menu summary"));
  });

  it("Undo brings the band back with its collapse cleared, and a late callback never hides it", async () => {
    const p = load((s) => (s.url === "/links/still-works/undo" ? { status: 204 } : WORKS));
    await click(p, "button[data-act=still-works]");
    await ended(p);
    await click(p, "#undo-bar button");
    intact(p);
    p.timers.fire();
    await ended(p);
    intact(p);
  });

  it("Done with it collapses after the server accepts, hides the card, and Undo shows card and whole band", async () => {
    const p = load((s) =>
      s.url === "/home/archive" ? { status: 200, body: CHANGE } : { status: 204 },
    );
    await click(p, "button[data-act=gone-done]");
    expect(p.$("li[data-id]").hidden).toBe(false);
    expect(band(p).classList.contains("collapsing")).toBe(true);
    await ended(p);
    expect(p.$("li[data-id]").hidden).toBe(true);
    intact(p);
    await click(p, "#undo-bar button");
    expect(p.sent.map((s) => s.url)).toEqual(["/home/archive", "/home/undo-state"]);
    expect(p.$("li[data-id]").hidden).toBe(false);
    intact(p);
    expect(p.timers.pending(FALLBACK_MS)).toBe(0);
    p.timers.fire();
    await ended(p);
    intact(p);
  });

  it.each([
    ["It still works", "still-works", 409],
    ["Done with it", "gone-done", 404],
  ])("a refused %s leaves the band visible and its buttons usable", async (_, act, status) => {
    const p = load(() => ({ status, body: { code: "conflict", message: "Refused." } }));
    await click(p, `button[data-act=${act}]`);
    intact(p);
    expect(p.$("li[data-id]").hidden).toBe(false);
    expect(p.$("#results-error").textContent).toBe("Refused.");
    expect(p.timers.pending(FALLBACK_MS)).toBe(0);
    for (const b of p.document.querySelectorAll("[data-gone] button")) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("sends nothing for a second action while the band is still collapsing", async () => {
    const p = load(() => WORKS);
    await click(p, "button[data-act=still-works]");
    await click(p, "button[data-act=gone-done]");
    await click(p, "button[data-act=still-works]");
    expect(p.sent).toHaveLength(1);
  });
});

describe("the Handy tile's slide-away", () => {
  const tileHome = (items: ShelfItem[]) =>
    homePage({
      worth: { links: [], images: new Map(), now: NOW, catalog: [], gone: null },
      shelf: handyShelf({ items, suggestions: [], catalog: [], images: new Map() }),
      spaces: "",
    });
  const item = (gone: boolean): ShelfItem => ({
    link: link("1"),
    tool: {
      status: "kept",
      source: "stated",
      since: new Date("2026-10-01T00:00:00Z"),
      answeredAt: null,
      waitDays: 30,
    },
    due: false,
    gone,
  });

  it.each([
    ["It still works", "still-works", "/links/still-works", { status: 200, body: WORKS.body }],
    ["Done with it", "done", "/home/archive", { status: 200, body: CHANGE }],
  ])(
    "%s collapses the band after the server agrees, then refreshes the shelf",
    async (_, act, url, ok) => {
      const p = runPage(tileHome([item(true)]), (s) =>
        s.body === undefined
          ? { status: 200, text: tileHome([item(false)]) }
          : ok && s.url === url
            ? ok
            : { status: 204 },
      );
      p.motion.reduced = false;
      await click(p, `[data-gone] button[data-act=${act}]`);
      expect(p.sent.map((s) => s.url)).toEqual([url]);
      expect(band(p).classList.contains("collapsing")).toBe(true);
      await ended(p);
      expect(p.sent.map((s) => s.url)).toEqual([url, "/"]);
      expect(p.document.querySelector("[data-gone]")).toBeNull();
    },
  );

  it.each([
    ["It still works", "still-works"],
    ["Done with it", "done"],
  ])("a refused %s leaves the band as it was", async (_, act) => {
    const p = runPage(tileHome([item(true)]), () => ({
      status: 409,
      body: { code: "conflict", message: "No." },
    }));
    p.motion.reduced = false;
    await click(p, `[data-gone] button[data-act=${act}]`);
    intact(p);
    expect(p.sent).toHaveLength(1);
  });
});

describe("the collapse helper on its own", () => {
  /** The helper's script run against one band, with timers the test fires by hand. */
  function helper(matchMedia: unknown) {
    const { document } = parseHTML('<li data-id="1"><div class="gone-band" data-gone></div></li>');
    const band = document.querySelector("[data-gone]") as HTMLElement;
    const card = document.querySelector("[data-id]") as HTMLElement;
    Object.defineProperty(card, "offsetHeight", { get: () => (band.hidden ? 100 : 140) });
    const timers = new Map<number, () => void>();
    let next = 1;
    const make = new Function(
      "matchMedia",
      "setTimeout",
      "clearTimeout",
      `${BAND_COLLAPSE}\nreturn { collapseBand, resetBand };`,
    );
    const api = make(
      matchMedia,
      (fn: () => void) => {
        timers.set(next, fn);
        return next++;
      },
      (id: number) => timers.delete(id),
    ) as { collapseBand(b: Element): Promise<void>; resetBand(b: Element): void };
    const Event = (document.defaultView as unknown as typeof globalThis).Event;
    const end = (target: Element = card) =>
      target.dispatchEvent(Object.assign(new Event("transitionend"), { propertyName: "height" }));
    return { band, card, api, timers, end };
  }
  const animated = () => ({ matches: false });

  it("finishes at once when matchMedia is missing", async () => {
    const { band, api } = helper(undefined);
    await api.collapseBand(band);
    expect(band.hidden).toBe(true);
  });

  it("never hides a band restored before its transition ended, whichever callback comes late", async () => {
    const { band, api, timers, end } = helper(animated);
    const done = api.collapseBand(band);
    api.resetBand(band);
    await done;
    expect(timers.size).toBe(0);
    end();
    for (const fn of timers.values()) fn();
    expect(band.hidden).toBe(false);
    expect(band.classList.contains("collapsing")).toBe(false);
  });

  it("slides the card to the height it has with the band hidden, then hides the band and frees the card", async () => {
    const { band, card, api, end } = helper(animated);
    const done = api.collapseBand(band);
    expect(card.style.height).toBe("100px");
    expect(card.style.overflow).toBe("hidden");
    expect(card.style.boxSizing).toBe("border-box");
    expect(band.hidden).toBe(false);
    end(band);
    expect(band.hidden).toBe(false);
    end();
    await done;
    expect(band.hidden).toBe(true);
    for (const prop of ["height", "overflow", "boxSizing", "transition"] as const) {
      expect(card.style[prop], prop).toBe("");
    }
  });

  it("frees the card when the band comes back before the slide ended", async () => {
    const { band, card, api } = helper(animated);
    const done = api.collapseBand(band);
    api.resetBand(band);
    await done;
    for (const prop of ["height", "overflow", "boxSizing", "transition"] as const) {
      expect(card.style[prop], prop).toBe("");
    }
  });

  it("resolves once and clears its own timer when the transition ends first", async () => {
    const { band, api, timers, end } = helper(animated);
    const done = api.collapseBand(band);
    expect(timers.size).toBe(1);
    end();
    await done;
    expect(band.hidden).toBe(true);
    expect(timers.size).toBe(0);
  });
});
