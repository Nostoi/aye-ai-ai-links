import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { renderCard } from "./ai-card.js";

const link = (over: Partial<Link> = {}): Link => ({
  id: "7",
  url: "https://site.example/page",
  urlKey: "site.example/page",
  title: "A page",
  summary: null,
  why: null,
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
const tag = (name: string, source: "stated" | "inferred") => ({
  key: name,
  name,
  source,
  kind: "topic" as const,
  kindSource: "stated" as const,
});
const KITCHEN: Tag = {
  key: "kitchen",
  name: "kitchen",
  kind: "topic",
  kindSource: "stated",
  color: "clay",
  pinned: true,
  description: null,
  projectStatus: null,
};

describe("renderCard", () => {
  it("quotes a stated why and marks an inferred one as a guess", () => {
    const said = renderCard(link({ why: { text: "x", source: "stated" } }), undefined, []);
    expect(said).toContain('"x"');
    expect(said).not.toContain("(a guess)");
    expect(renderCard(link({ why: { text: "x", source: "inferred" } }), undefined, [])).toContain(
      '"x" (a guess)',
    );
  });

  it("marks an inferred tag as a dashed guess and leaves a stated one plain", () => {
    const html = renderCard(
      link({ tags: [tag("shelving", "inferred"), tag("kitchen", "stated")] }),
      undefined,
      [],
    );
    expect(html).toContain('<span class="ask-tag guess">shelving (a guess)</span>');
    expect(html).toContain('<span class="ask-tag">kitchen</span>');
  });

  it("carries a pinned space's class and the link's id", () => {
    const html = renderCard(link({ tags: [tag("kitchen", "stated")] }), undefined, [KITCHEN]);
    expect(html).toContain('class="ask-card space-clay" data-id="7"');
    expect(renderCard(link(), undefined, [])).toContain('class="ask-card" data-id="7"');
  });

  it("escapes the title", () => {
    const html = renderCard(link({ title: "<script>alert(1)</script>" }), undefined, []);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
