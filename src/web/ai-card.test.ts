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
    const said = renderCard(
      link({ why: { text: "x", source: "stated" } }),
      undefined,
      undefined,
      [],
    );
    expect(said).toContain('"x"');
    expect(said).not.toContain("(a guess)");
    expect(
      renderCard(link({ why: { text: "x", source: "inferred" } }), undefined, undefined, []),
    ).toContain('"x" (a guess)');
  });

  it("marks an inferred tag as a dashed guess and leaves a stated one plain", () => {
    const html = renderCard(
      link({ tags: [tag("shelving", "inferred"), tag("kitchen", "stated")] }),
      undefined,
      undefined,
      [],
    );
    expect(html).toContain('<span class="ask-tag guess">shelving (a guess)</span>');
    expect(html).toContain('<span class="ask-tag">kitchen</span>');
  });

  it("carries a pinned space's class and the link's id", () => {
    const html = renderCard(link({ tags: [tag("kitchen", "stated")] }), undefined, undefined, [
      KITCHEN,
    ]);
    expect(html).toContain('class="ask-card space-clay" data-id="7"');
    expect(renderCard(link(), undefined, undefined, [])).toContain('class="ask-card" data-id="7"');
  });

  it("colours only the space's own tag; an unpinned tag shows no colour", () => {
    const html = renderCard(
      link({ tags: [tag("kitchen", "stated"), tag("baking", "stated")] }),
      undefined,
      undefined,
      [KITCHEN],
    );
    expect(html).toContain('<span class="ask-tag ask-space">kitchen</span>');
    expect(html).toContain('<span class="ask-tag">baking</span>');
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
