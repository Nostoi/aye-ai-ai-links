import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { HomeSpace } from "../core/spaces.js";
import type { Link } from "../core/types.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { spacesSection } from "./spaces-section.js";

const ORIGIN = "https://links.example";
const HOSTILE = `<img src=x onerror=alert(1)>`;
const ODD_KEY = "c++ & ü/x#y";

const link = (id: string, over: Partial<Link> = {}): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  summarySource: null,
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

const space = (over: Partial<HomeSpace> & { key: string }): HomeSpace => ({
  name: over.key,
  color: null,
  count: 0,
  recent: [],
  ...over,
});

const dom = (html: string) =>
  parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
const hrefs = (html: string, selector: string) =>
  [...dom(html).querySelectorAll(selector)].map((a) => a.getAttribute("href") as string);
const tagOf = (href: string) => new URL(href, ORIGIN).searchParams.get("tag");

describe("the Your spaces section", () => {
  it("says how to make a space when nothing is pinned", () => {
    const html = spacesSection([]);
    expect(html).toContain("Your spaces");
    expect(html).toContain("Pin a tag on the");
    expect(hrefs(html, "a")).toEqual(["/tags"]);
  });

  it("shows each space as a card opening its page, in its color, with its dot and name", () => {
    const html = spacesSection([
      space({ key: "home batteries", name: "Home batteries", color: "teal" }),
      space({ key: "kitchen", name: "Kitchen", color: null }),
    ]);
    const cards = [...dom(html).querySelectorAll(".home-space")];
    expect(cards.map((a) => a.querySelector(".home-space-name")?.textContent?.trim())).toEqual([
      "Home batteries",
      "Kitchen",
    ]);
    const nameHref = (c: Element) => c.querySelector("a.home-space-name")?.getAttribute("href");
    expect(cards.map((a) => tagOf(nameHref(a) as string))).toEqual(["home batteries", "kitchen"]);
    expect(cards[0]?.className).toContain("space-teal");
    expect(cards[1]?.className).not.toMatch(/space-/);
    expect(cards[0]?.querySelector("a.home-space-name .dot")).not.toBeNull();
  });

  it("names the recent links given, in order, each title opening its link in a new tab", () => {
    const html = spacesSection([
      space({
        key: "kitchen",
        recent: [link("7", { title: "Bread" }), link("3", { title: "Soup" })],
      }),
      space({ key: "garden" }),
    ]);
    const [kitchen, garden] = [...dom(html).querySelectorAll(".home-space")];
    const titles = [...(kitchen?.querySelectorAll(".home-space-recent > *") ?? [])];
    expect(titles.map((t) => t.textContent)).toEqual(["Bread", "Soup"]);
    expect(titles.map((t) => t.getAttribute("data-id"))).toEqual(["7", "3"]);
    const anchors = titles.map((t) => t.querySelector("a[data-open]"));
    expect(anchors.map((a) => a?.getAttribute("href"))).toEqual([
      "https://ex.com/7",
      "https://ex.com/3",
    ]);
    expect(anchors.map((a) => a?.getAttribute("target"))).toEqual(["_blank", "_blank"]);
    expect(anchors.map((a) => a?.getAttribute("rel"))).toEqual([
      "noopener noreferrer",
      "noopener noreferrer",
    ]);
    expect(garden?.querySelector(".home-space-recent")).toBeNull();
    expect(dom(html).querySelectorAll("img, .mosaic, .card-menu, a a")).toHaveLength(0);
    expect(outsideRefs(html)).toEqual([]);
  });

  it("puts a versioned favicon image before the title of a link that has one, and an empty square before one that has none", () => {
    const html = spacesSection(
      [space({ key: "k", recent: [link("7", { title: "Bread" }), link("3", { title: "Soup" })] })],
      new Map([["7", 'v"1']]),
    );
    const [bread, soup] = [...dom(html).querySelectorAll(".home-space-recent > [data-id]")];
    const img = bread?.querySelector("img.home-fav");
    expect(img?.getAttribute("src")).toBe("/images/7/favicon?v=v%221");
    expect([
      img?.getAttribute("alt"),
      img?.getAttribute("width"),
      img?.getAttribute("height"),
    ]).toEqual(["", "18", "18"]);
    expect([img?.getAttribute("loading"), img?.getAttribute("decoding")]).toEqual([
      "lazy",
      "async",
    ]);
    // Before the title link, inside the [data-id] span, and not a link itself.
    expect(bread?.firstElementChild).toBe(img);
    expect(img?.closest("a")).toBeNull();
    expect(bread?.querySelector("a[data-open]")?.textContent).toBe("Bread");
    expect(soup?.querySelector("img")).toBeNull();
    const empty = soup?.firstElementChild;
    expect(empty?.className).toBe("home-fav home-fav-none");
    expect(empty?.getAttribute("aria-hidden")).toBe("true");
    expect(soup?.querySelector("a[data-open]")?.textContent).toBe("Soup");
    expect(outsideRefs(html)).toEqual([]);
  });

  it("gives the grid an id for the opening script", () => {
    expect(dom(spacesSection([space({ key: "k" })])).querySelector(".home-spaces")?.id).toBe(
      "home-spaces",
    );
  });

  it("leaves the title of a non-web link as plain text", () => {
    const html = spacesSection([
      space({
        key: "k",
        recent: [link("1", { title: "Mail", url: "mailto:a@b.c" }), link("2", { title: "Web" })],
      }),
    ]);
    const [mail, web] = [...dom(html).querySelectorAll(".home-space-recent > *")];
    expect(mail?.querySelector("a")).toBeNull();
    expect(mail?.textContent).toBe("Mail");
    expect(mail?.getAttribute("data-id")).toBe("1");
    expect(web?.querySelector("a[data-open]")).not.toBeNull();
  });

  it("ends each card with See all N to the space, its accessible name carrying the space's name", () => {
    const html = spacesSection([
      space({ key: "home batteries", name: "Home batteries", count: 12 }),
      space({ key: "kitchen", name: "Kitchen", count: 0 }),
    ]);
    const cards = [...dom(html).querySelectorAll(".home-space")];
    const all = cards.map((c) => c.querySelector("a.home-space-all"));
    expect(all.map((a) => tagOf(a?.getAttribute("href") as string))).toEqual([
      "home batteries",
      "kitchen",
    ]);
    expect(all.map((a) => a?.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "See all 12 Home batteries →",
      "Open Kitchen →",
    ]);
    expect(all[0]?.querySelector(".visually-hidden")?.textContent?.trim()).toBe("Home batteries");
    expect(cards.map((c) => c.querySelectorAll("a").length)).toEqual([2, 2]);
    expect(dom(html).querySelectorAll("a a")).toHaveLength(0);
  });

  it("is a container, not a link, so the name link can cover it", () => {
    const card = dom(spacesSection([space({ key: "k" })])).querySelector(".home-space");
    expect(card?.tagName).toBe("DIV");
    expect(card?.querySelector("a.home-space-name")).not.toBeNull();
  });

  it("cuts the name of any pinned space from the front, longest first, one cut only", () => {
    const shown = (own: string, title: string, others: string[]) =>
      dom(
        spacesSection([
          space({ key: own, name: own, recent: [link("1", { title })] }),
          ...others.map((name) => space({ key: name, name })),
        ]),
      ).querySelector(".home-space-recent > *")?.textContent;
    const arts = ["Art", "Art History"];
    expect(shown("Valor", "Language Arts 8 — Grammar Unit 1", ["Language Arts 8"])).toBe(
      "Grammar Unit 1",
    );
    expect(shown("Valor", "Art History — Rome", arts)).toBe("Rome");
    expect(shown("Art", "Art History — Rome", ["Art History"])).toBe("Rome");
    expect(shown("Valor", "Art — Art History — Rome", arts)).toBe("Art History — Rome");
    expect(shown("Valor", "Artful — Rome", ["Art"])).toBe("Artful — Rome");
  });

  it("shows a spaced dash as one dash and leaves unspaced ones alone", () => {
    const shown = (title: string) =>
      dom(
        spacesSection([space({ key: "k", name: "Zed", recent: [link("1", { title })] })]),
      ).querySelector(".home-space-recent a")?.textContent;
    expect(shown("Part one - two")).toBe("Part one — two");
    expect(shown("Part one – two")).toBe("Part one — two");
    expect(shown("Part one — two")).toBe("Part one — two");
    expect(shown("Go-to-market 2020–2021")).toBe("Go-to-market 2020–2021");
  });

  it("drops the space's name from the front of a title only at a clear label break", () => {
    const shown = (name: string, title: string) =>
      dom(
        spacesSection([space({ key: name, name, recent: [link("1", { title })] })]),
      ).querySelector(".home-space-recent > *")?.textContent;
    expect(shown("Language Arts 8", "Language Arts 8 — Grammar")).toBe("Grammar");
    expect(shown("Language Arts 8", "language arts 8 – Grammar")).toBe("Grammar");
    expect(shown("Language Arts 8", "Language Arts 8 - Grammar")).toBe("Grammar");
    expect(shown("Language Arts 8", "Language Arts 8: Grammar")).toBe("Grammar");
    expect(shown("Go", "Go-to-market strategy")).toBe("Go-to-market strategy");
    expect(shown("Rust", "Rust-based engine")).toBe("Rust-based engine");
    expect(shown("Rust", "Rust")).toBe("Rust");
    expect(shown("Rust", "Rust — ")).toBe("Rust — ");
    expect(shown("Rust", "Rustacean — Grammar")).toBe("Rustacean — Grammar");
  });

  it("keeps a hostile name and title inert and an odd key intact", () => {
    const html = spacesSection([
      space({
        key: ODD_KEY,
        name: HOSTILE,
        color: "clay",
        recent: [link("1", { title: HOSTILE })],
      }),
    ]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(dom(html).querySelector(".home-space-recent > *")?.textContent).toBe(HOSTILE);
    expect(hrefs(html, "a.home-space-name").map(tagOf)).toEqual([ODD_KEY]);
  });
});
