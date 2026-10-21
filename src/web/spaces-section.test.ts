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
    const cards = [...dom(html).querySelectorAll("a.home-space")];
    expect(cards.map((a) => a.querySelector(".home-space-name")?.textContent?.trim())).toEqual([
      "Home batteries",
      "Kitchen",
    ]);
    expect(cards.map((a) => tagOf(a.getAttribute("href") as string))).toEqual([
      "home batteries",
      "kitchen",
    ]);
    expect(cards[0]?.className).toContain("space-teal");
    expect(cards[1]?.className).not.toMatch(/space-/);
    expect(cards[0]?.querySelector(".home-space-name .dot")).not.toBeNull();
  });

  it("names the recent links given, in order, as plain words: no pictures, links or menu", () => {
    const html = spacesSection([
      space({
        key: "kitchen",
        recent: [link("7", { title: "Bread" }), link("3", { title: "Soup" })],
      }),
      space({ key: "garden" }),
    ]);
    const [kitchen, garden] = [...dom(html).querySelectorAll("a.home-space")];
    const titles = [...(kitchen?.querySelectorAll(".home-space-recent > *") ?? [])];
    expect(titles.map((t) => t.textContent)).toEqual(["Bread", "Soup"]);
    expect(garden?.querySelector(".home-space-recent")).toBeNull();
    expect(dom(html).querySelectorAll("img, .mosaic, .card-menu, a a")).toHaveLength(0);
    expect(outsideRefs(html)).toEqual([]);
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
    expect(hrefs(html, "a.home-space").map(tagOf)).toEqual([ODD_KEY]);
  });
});
