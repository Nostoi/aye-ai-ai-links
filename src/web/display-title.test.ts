import { describe, expect, it } from "vitest";
import type { Link } from "../core/types.js";
import { displayTitle } from "./display-title.js";

const link = (url: string, title: string | null = null, page?: string | null): Link => ({
  id: "1",
  url,
  urlKey: url,
  title,
  summary: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-03-12T10:00:00Z"),
  savedBy: "claude",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot:
    page === undefined ? null : ({ title: page } as unknown as NonNullable<Link["snapshot"]>),
});

describe("displayTitle", () => {
  it("keeps a usable stored title exactly, even one that mentions an address", () => {
    expect(displayTitle(link("https://a.com/x", "My title"))).toBe("My title");
    expect(displayTitle(link("https://a.com/x", "See https://b.com for more"))).toBe(
      "See https://b.com for more",
    );
  });

  it("names an x.com or twitter.com post by its user", () => {
    const post = "https://x.com/alice/status/2105819303471976479?s=46";
    expect(displayTitle(link(post))).toBe("Post by @alice");
    expect(displayTitle(link("https://www.twitter.com/Bob_1/status/9"))).toBe("Post by @Bob_1");
    expect(displayTitle(link(post, "   "))).toBe("Post by @alice");
  });

  it("uses a cleaned last path segment and the site for any other address", () => {
    expect(displayTitle(link("https://scenario.com/iso-cycles?x=1#top"))).toBe(
      "Iso cycles — scenario.com",
    );
    expect(displayTitle(link("https://www.example.com/a/b/some_long-name/"))).toBe(
      "Some long name — example.com",
    );
    expect(displayTitle(link("https://example.com/guide.html"))).toBe("Guide — example.com");
    expect(displayTitle(link("https://x.com/alice"))).toBe("Alice — x.com");
  });

  it("does not treat x.com/i/status/<id> as a post by a user called i", () => {
    expect(displayTitle(link("https://x.com/i/status/9"))).toBe("x.com");
  });

  it("gives just the site for a bare domain or a last segment with no letters", () => {
    expect(displayTitle(link("https://scenario.com"))).toBe("scenario.com");
    expect(displayTitle(link("https://www.scenario.com/"))).toBe("scenario.com");
    expect(displayTitle(link("https://example.com/items/2105819303471976479"))).toBe("example.com");
  });

  it("drops only known page extensions", () => {
    expect(displayTitle(link("https://example.com/page.php"))).toBe("Page — example.com");
    expect(displayTitle(link("https://example.com/v1.2"))).toBe("V1.2 — example.com");
  });

  it("never throws on bad percent-encoding, and keeps decoded markup as text", () => {
    expect(displayTitle(link("https://example.com/50%off"))).toBe("50%off — example.com");
    expect(displayTitle(link("https://example.com/%E0%A4%A"))).toBe("%E0%A4%A — example.com");
    expect(displayTitle(link("https://example.com/%3Cimg%20src=x%20onerror=alert(1)%3E"))).toBe(
      "<img src=x onerror=alert(1)> — example.com",
    );
  });

  it("prefers the page's own title, once it passes the same checks", () => {
    const u = "https://x.com/alice/status/1";
    expect(displayTitle(link(u, null, "Alice on X: a post"))).toBe("Alice on X: a post");
    expect(displayTitle(link(u, "Chosen", "Page"))).toBe("Chosen");
    expect(displayTitle(link(u, null, "https://x.com/alice/status/1?s=46"))).toBe("Post by @alice");
    expect(displayTitle(link(u, null, "  "))).toBe("Post by @alice");
    expect(displayTitle(link(u, null, "x".repeat(500)))).toBe("Post by @alice");
    expect(displayTitle(link(u, "https://x.com/alice/status/1", "Page"))).toBe("Page");
  });

  it("returns the stored address for one that is not a web address, or does not parse", () => {
    expect(displayTitle(link("ftp://files.example/a"))).toBe("ftp://files.example/a");
    expect(displayTitle(link("not a url"))).toBe("not a url");
  });

  it("never returns an https:// address for a web link without a usable title", () => {
    for (const u of [
      "https://a.com",
      "https://a.com/%",
      "https://a.com/1234",
      "https://x.com/i/status/1",
      "http://a.com/?q=https://b.com",
    ]) {
      expect(displayTitle(link(u)), u).not.toMatch(/https?:\/\//);
    }
  });

  it("keeps a stored title that only ends in an address", () => {
    expect(displayTitle(link("https://a.com/x", "Read: https://a.com/x"))).toBe(
      "Read: https://a.com/x",
    );
  });

  it("keeps the extension of a file that is not a page", () => {
    expect(displayTitle(link("https://example.com/report.pdf"))).toBe("Report.pdf — example.com");
  });

  it("names a post only for exactly /<user>/status/<id>, and joins a doubled separator into one space", () => {
    expect(displayTitle(link("https://x.com/u/status/1/photo/1"))).toBe("x.com");
    expect(displayTitle(link("https://example.com/a--b"))).toBe("A b — example.com");
  });

  it("falls back to the site when the built title would be longer than a stored title may be", () => {
    expect(displayTitle(link(`https://a.com/${"a".repeat(5000)}`))).toBe("a.com");
    const fits = "a".repeat(150);
    expect(displayTitle(link(`https://a.com/${fits}`))).toBe(`A${fits.slice(1)} — a.com`);
  });

  it("drops control characters from a built title", () => {
    expect(displayTitle(link("https://a.com/one%0Atwo%00three"))).toBe("One two three — a.com");
    expect(displayTitle(link("https://x.com/al%0Aice/status/1"))).toBe("Post by @al ice");
    expect(displayTitle(link("https://a.com/%0A%00"))).toBe("a.com");
  });

  it("falls back to the site for a post whose user name would make the title too long", () => {
    expect(displayTitle(link(`https://x.com/${"a".repeat(5000)}/status/1`))).toBe("x.com");
    const longest = "a".repeat(191);
    expect(displayTitle(link(`https://x.com/${longest}/status/1`))).toBe(`Post by @${longest}`);
    expect(displayTitle(link(`https://x.com/${longest}a/status/1`))).toBe("x.com");
  });

  it("drops format characters from a built title, so none can reorder it or empty a name", () => {
    const flipped = displayTitle(link("https://evil.example/%E2%80%AEmoc.elgoog"));
    expect(flipped).toBe("Moc.elgoog — evil.example");
    expect(flipped).not.toMatch(/\p{Cf}/u);
    expect(displayTitle(link("https://x.com/%E2%80%8B/status/1"))).toBe("x.com");
  });
});
