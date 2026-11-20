import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { renderCard } from "./ai-card.js";
import { editData } from "./edit-link.js";

const link = (over: Partial<Link> = {}): Link => ({
  id: "7",
  url: "https://site.example/page",
  urlKey: "site.example/page",
  title: "A page",
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-10-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
  intent: "explore",
  intentSource: null,
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
  it("shows a stated or asked why as plain text and marks an inferred one as a guess", () => {
    const said = renderCard(
      link({ why: { text: "x", source: "stated" } }),
      undefined,
      undefined,
      [],
    );
    expect(said).toContain('<p class="ask-why">x</p>');
    expect(said).not.toContain("(a guess)");
    const asked = renderCard(
      link({ why: { text: "x", source: "asked" } }),
      undefined,
      undefined,
      [],
    );
    expect(asked).toContain('<p class="ask-why">x</p>');
    expect(
      renderCard(link({ why: { text: "x", source: "inferred" } }), undefined, undefined, []),
    ).toContain('<p class="ask-why">Why (a guess): x</p>');
  });

  const tagline = (tags: Link["tags"], catalog: Tag[] = []) =>
    /<p class="small ask-tagline">(.*)<\/p>/.exec(
      renderCard(link({ tags }), undefined, undefined, catalog),
    )?.[1] ?? null;

  it("says a lone inferred tag is a guess, once", () => {
    expect(tagline([tag("shelving", "inferred")])).toBe("shelving (a guess)");
  });

  it("says several inferred tags are guesses, once, after the inferred group", () => {
    expect(tagline([tag("shelving", "inferred"), tag("wood", "inferred")])).toBe(
      "shelving · wood (guesses)",
    );
  });

  it("lists stated tags first in their order, then the inferred ones", () => {
    expect(
      tagline([
        tag("shelving", "inferred"),
        tag("kitchen", "stated"),
        tag("wood", "inferred"),
        tag("baking", "stated"),
      ]),
    ).toBe("kitchen · baking · shelving · wood (guesses)");
    expect(tagline([tag("kitchen", "stated"), tag("shelving", "inferred")])).toBe(
      "kitchen · shelving (a guess)",
    );
  });

  it("draws stated tags alone with no guess words, and no line at all without tags", () => {
    expect(tagline([tag("kitchen", "stated"), tag("baking", "stated")])).toBe("kitchen · baking");
    expect(renderCard(link(), undefined, undefined, [])).not.toContain("ask-tagline");
  });

  it("escapes a tag's name", () => {
    expect(tagline([tag("<b>", "stated")])).toBe("&lt;b&gt;");
  });

  it("carries a pinned space's class and the link's id", () => {
    const html = renderCard(link({ tags: [tag("kitchen", "stated")] }), undefined, undefined, [
      KITCHEN,
    ]);
    expect(html).toContain('class="ask-card space-clay" data-id="7"');
    expect(renderCard(link(), undefined, undefined, [])).toContain('class="ask-card" data-id="7"');
  });

  it("puts a dot on the space's own tag only, stated or inferred", () => {
    const DOT = '<span class="ask-dot" aria-hidden="true"></span>';
    expect(tagline([tag("kitchen", "stated"), tag("baking", "stated")], [KITCHEN])).toBe(
      `${DOT}kitchen · baking`,
    );
    expect(tagline([tag("baking", "stated"), tag("kitchen", "inferred")], [KITCHEN])).toBe(
      `baking · ${DOT}kitchen (a guess)`,
    );
    expect(tagline([tag("baking", "stated")], [KITCHEN])).not.toContain("ask-dot");
  });

  it("escapes the title", () => {
    const html = renderCard(link({ title: "<script>alert(1)</script>" }), undefined, undefined, []);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("carries the edit dialog's data, the same as editData gives for the same input", () => {
    const item = link({
      title: "Quokka habitat",
      snapshot: {
        status: "ok",
        fetchedAt: new Date("2026-10-01T00:00:00Z"),
        title: "Quokkas: a field guide",
        description: null,
        imageUrl: null,
      },
    });
    const picture = { version: "abc123", fit: "cover" as const };
    const info = { own: true, pageVersion: "def456", pageFit: "contain" as const };
    const open = renderCard(item, picture, info, []).match(/<article[^>]*>/)?.[0] ?? "";
    const data = editData(item, picture, info);
    expect(data).toContain('data-own="1"');
    expect(data).toContain('data-page-version="def456"');
    expect(data).toContain('data-page-fit="contain"');
    expect(data).toContain('data-title="Quokka habitat"');
    expect(open).toContain(data);
  });

  it("escapes a hostile title in data-title", () => {
    const html = renderCard(
      link({ title: '"><img src=x onerror=alert(1)>' }),
      undefined,
      undefined,
      [],
    );
    const open = html.match(/<article[^>]*>/)?.[0] ?? "";
    expect(open).toContain('data-title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });
});
