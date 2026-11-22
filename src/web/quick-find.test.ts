import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { quickFind } from "./quick-find.js";

const link = (n: number, over: Partial<Link> = {}): Link => ({
  id: String(n),
  url: `https://www.example.com/${n}`,
  urlKey: `example.com/${n}`,
  title: `Title ${n}`,
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-03-12T10:00:00Z"),
  savedBy: "claude",
  lastOpenedAt: null,
  intent: "explore",
  intentSource: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});

const input = (over: Partial<Parameters<typeof quickFind>[0]> = {}) => ({
  query: "solar",
  links: [link(1), link(2)],
  images: new Map(),
  catalog: [] as Tag[],
  ask: false,
  ...over,
});

const doc = (html: string) => parseHTML(html).document;

describe("quickFind", () => {
  it("is empty for a blank query", () => {
    expect(quickFind(input({ query: "  " }))).toBe("");
  });

  it("shows no more than five rows, the first one highlighted", () => {
    const links = [1, 2, 3, 4, 5, 6, 7].map((n) => link(n));
    const options = [...doc(quickFind(input({ links }))).querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.closest("li")?.getAttribute("data-id"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
  });

  it("drops the www from a row's site and leaves out a why a link lacks", () => {
    const row = doc(quickFind(input())).querySelector("li");
    expect(row?.querySelector(".card-line")?.textContent).toBe("example.com");
    expect(row?.querySelector(".find-why")).toBeNull();
  });

  it("escapes the words, titles and whys it shows", () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const html = quickFind(
      input({
        query: hostile,
        links: [link(1, { title: hostile, why: { text: hostile, source: "stated" } })],
        receipt: hostile,
      }),
    );
    expect(html).not.toContain("<img");
    expect(doc(html).querySelector(".find-title")?.textContent).toBe(hostile);
  });

  it("shows a link that is not a web address as text, with no link to open", () => {
    const html = quickFind(input({ links: [link(1, { url: "mailto:a@example.com" })] }));
    const option = doc(html).querySelector('[role="option"]');
    expect(option?.tagName).toBe("SPAN");
    expect(option?.hasAttribute("href")).toBe(false);
  });

  it("marks the answer with its receipt, and only when it has one", () => {
    expect(
      doc(quickFind(input({ receipt: "r1" })))
        .querySelector("[data-receipt]")
        ?.getAttribute("data-receipt"),
    ).toBe("r1");
    expect(quickFind(input())).not.toContain("data-receipt");
    expect(quickFind(input({ links: [], receipt: "r2" }))).toContain('data-receipt="r2"');
  });

  describe("when nothing matched", () => {
    it("says so, with no list and no See all", () => {
      const html = quickFind(input({ links: [] }));
      expect(html).toContain("Nothing matched.");
      expect(html).toContain("Try different words");
      expect(html).not.toContain("listbox");
      expect(html).not.toContain("find-all");
      expect(html).not.toContain("data-ask-text");
    });

    it("offers Ask AI about the words only while the AI is on", () => {
      const html = quickFind(input({ links: [], query: "a & b", ask: true }));
      expect(doc(html).querySelector("button[data-ask-text]")?.getAttribute("data-ask-text")).toBe(
        "a & b",
      );
      expect(doc(html).querySelector("button[data-ask-text]")?.textContent).toBe(
        "Ask AI about “a & b”",
      );
    });
  });
});
