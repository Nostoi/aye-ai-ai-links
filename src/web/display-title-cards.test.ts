import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { renderCard } from "./ai-card.js";
import { allPage } from "./all-page.js";
import { handyShelf } from "./handy-shelf.js";
import { homePage } from "./home-page.js";
import { searchPage } from "./pages.js";
import { spacePage } from "./space-page.js";
import { spacesSection } from "./spaces-section.js";

/** A link with no title shows a readable one on every card; the address stays the link's target (#197). */

const NOW = new Date("2026-10-14T12:00:00Z");
const POST = "https://x.com/alice/status/2105819303471976479?s=46";
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

const link = (over: Partial<Link> = {}): Link => ({
  id: "1",
  url: POST,
  urlKey: "x.com/alice/status/2105819303471976479",
  title: null,
  summary: null,
  why: { text: "to read", source: "stated" },
  tags: [],
  savedAt: new Date("2026-03-12T10:00:00Z"),
  savedBy: "claude",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});

const list = {
  order: "newest" as const,
  older: null,
  catalog: [KITCHEN],
  images: new Map(),
  handy: new Map(),
  now: NOW,
  done: false,
};
const worth = (links: Link[], gone: Link | null = null) => ({
  links: links.map((l) => ({ link: l, reasons: [] as [] })),
  images: new Map(),
  now: NOW,
  catalog: [KITCHEN],
  gone,
  goneCopy: null,
});
const tool = (l: Link) => ({
  link: l,
  tool: {
    status: "kept" as const,
    source: "stated" as const,
    since: NOW,
    answeredAt: null,
    waitDays: 30 as const,
  },
  due: false,
  gone: false,
});

type Case = { name: string; heading: string; html: (links: Link[]) => string };
const CASES: Case[] = [
  { name: "All links", heading: "h3", html: (ls) => allPage({ ...list, links: ls }) },
  {
    name: "a space page",
    heading: "h3",
    html: (ls) =>
      spacePage({
        tag: KITCHEN,
        catalog: [KITCHEN],
        older: null,
        images: new Map(),
        handy: new Map(),
        now: NOW,
        done: false,
        links: ls,
      }),
  },
  {
    name: "search results",
    heading: "h2",
    html: (ls) => searchPage({ query: "x", links: ls, now: NOW, catalog: [KITCHEN] }),
  },
  {
    name: "Home's Worth a look",
    heading: "h3",
    html: (ls) => homePage({ worth: worth(ls), shelf: "", spaces: "" }),
  },
  {
    name: "Home's gone card",
    heading: "h3",
    html: (ls) => homePage({ worth: worth([], ls[0] ?? null), shelf: "", spaces: "" }),
  },
  {
    name: "the Handy shelf",
    heading: "h3",
    html: (ls) =>
      handyShelf({ items: ls.map(tool), suggestions: [], catalog: [], images: new Map() }),
  },
  {
    name: "the Ask AI card",
    heading: "h3",
    html: (ls) => ls.map((l) => renderCard(l, undefined, undefined, [KITCHEN])).join(""),
  },
];

describe("a link with no title", () => {
  for (const c of CASES) {
    it(`shows a readable title on ${c.name}, opening the real address`, () => {
      const { document } = parseHTML(c.html([link()]));
      const heading = document.querySelector(`[data-id] ${c.heading}`);
      expect(heading?.textContent?.trim()).toBe("Post by @alice");
      expect(heading?.querySelector("a")?.getAttribute("href")).toBe(POST);
      expect(c.html([link()])).not.toMatch(/>https?:\/\//);
    });

    it(`shows a readable title on ${c.name} when the stored title is the address itself`, () => {
      const { document } = parseHTML(c.html([link({ title: POST })]));
      expect(document.querySelector(`[data-id] ${c.heading}`)?.textContent?.trim()).toBe(
        "Post by @alice",
      );
    });

    it(`leaves a real title alone on ${c.name}`, () => {
      const { document } = parseHTML(c.html([link({ title: "My own title" })]));
      expect(document.querySelector(`[data-id] ${c.heading}`)?.textContent?.trim()).toBe(
        "My own title",
      );
    });
  }

  it("names the card menu by the readable title, and keeps the stored title for the edit dialog", () => {
    for (const c of CASES.filter((x) =>
      ["All links", "a space page", "search results", "the Handy shelf"].includes(x.name),
    )) {
      const { document } = parseHTML(c.html([link()]));
      expect(
        document.querySelector(".card-menu summary .visually-hidden")?.textContent,
        c.name,
      ).toBe("More for Post by @alice");
    }
    const { document } = parseHTML(allPage({ ...list, links: [link()] }));
    expect(document.querySelector("[data-id]")?.getAttribute("data-title")).toBe("");
  });

  it("names a space's recent link on Home by its readable title", () => {
    const html = spacesSection([
      { key: "kitchen", name: "Kitchen", color: null, recent: [link()] },
    ]);
    const { document } = parseHTML(html);
    expect(document.querySelector(".home-space-recent > *")?.textContent).toBe("Post by @alice");
    expect(html).not.toMatch(/>https?:\/\//);
  });

  it("keeps decoded markup in an address as text in the heading and the menu label", () => {
    const hostile = link({ url: "https://example.com/%3Cimg%20src=x%20onerror=alert(1)%3E" });
    const html = allPage({ ...list, links: [hostile] });
    expect(html).not.toContain("<img src=x");
    const { document } = parseHTML(html);
    expect(document.querySelector("[data-id] h3")?.textContent).toBe(
      "<img src=x onerror=alert(1)> — example.com",
    );
    expect(document.querySelector(".card-menu summary .visually-hidden")?.textContent).toBe(
      "More for <img src=x onerror=alert(1)> — example.com",
    );
  });
});
