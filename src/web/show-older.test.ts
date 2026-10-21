import { describe, expect, it } from "vitest";
import type { Link } from "../core/types.js";
import { allPage } from "./all-page.js";
import { runPage } from "./opened-test-kit.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const link = (id: string): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  why: null,
  tags: [],
  savedAt: NOW,
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});

describe("Show older links", () => {
  // The answer is a page of cards, so only `redirected` sends it to navigation.
  it("a redirected Show older answer navigates to the link instead of appending", async () => {
    const html = allPage({
      order: "newest",
      links: [link("7")],
      older: "cursor",
      catalog: [],
      images: new Map(),
      handy: new Map(),
      now: NOW,
      done: false,
    });
    const p = runPage(html, () => ({ status: 200, redirected: true, text: html }));
    const older = p.$("#older");
    const href = older.getAttribute("href");
    const cards = () => p.document.querySelectorAll("#all-links li").length;
    const before = cards();
    p.dispatch(older, "click");
    await p.settle();
    expect(p.location.href).toBe(href);
    expect(cards()).toBe(before);
  });
});
