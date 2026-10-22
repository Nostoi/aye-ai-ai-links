import { describe, expect, it } from "vitest";
import { bookmarksHtml } from "./bookmarks-html.js";
import type { Link, LinkTag, Tag } from "./types.js";

const T = new Date(Date.UTC(2026, 9, 1));
const BREAKS = /\r\n|\r|\n|\u0085|\u2028|\u2029/;
const space = (name: string, pinned = true): Tag => ({
  key: name.toLowerCase(),
  name,
  kind: "project",
  kindSource: "stated",
  color: "teal",
  pinned,
  description: null,
  projectStatus: "active",
});
const L = (n: number, over: Partial<Link> = {}): Link => ({
  id: String(n),
  url: `https://ex.com/${n}`,
  urlKey: `ex.com/${n}`,
  title: `Title ${n}`,
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt: new Date(Date.UTC(2026, 9, 1) + n * 1000),
  savedBy: "claude-code",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});
const cabin = space("Cabin");
const garden = space("Garden");
const tagOf = (t: Tag): LinkTag => ({
  key: t.key,
  name: t.name,
  source: "stated",
  kind: t.kind,
  kindSource: t.kindSource,
});
const nasty = "A\r\nB\rC\nD\tE\u2028F\u2029G\u0085H";

describe("bookmarksHtml", () => {
  it("the nasty string holds every break the spec names", () => {
    for (const ch of ["\r", "\n", "\t", "\u0085", "\u2028", "\u2029"]) {
      expect(nasty).toContain(ch);
    }
  });

  it("one <A> per physical line, whatever breaks the title, why or tags hold", () => {
    const html = bookmarksHtml(
      [
        L(1, {
          title: nasty,
          why: { text: nasty, source: "stated" },
          tags: [{ ...tagOf(cabin), name: `Ca,${nasty}` }],
        }),
      ],
      [cabin],
      T,
    );
    const lines = html.split(BREAKS);
    const anchors = lines.filter((l) => l.includes("<A "));
    expect(anchors).toHaveLength(1);
    for (const l of anchors) expect(l).toContain("</A>");
    expect(lines.filter((l) => l.startsWith("<DD>"))).toEqual(["<DD>A B C D E F G H"]);
    expect(anchors[0]).toContain('TAGS="CaA B C D E F G H"');
    expect(anchors[0]).toContain(">A B C D E F G H</A>");
  });

  it("a link in two spaces is in both folders; an archived one only in Out of your lists; a loose one after the spaces", () => {
    const html = bookmarksHtml(
      [
        L(1, { tags: [tagOf(cabin), tagOf(garden)] }),
        L(2, { state: "archived", tags: [tagOf(cabin)] }),
        L(3),
      ],
      [cabin, garden],
      T,
    );
    const folders = html
      .split("\n")
      .filter((l) => /<H3|<A |<\/DL>/.test(l))
      .map((l) => l.replace(/ ADD_DATE="\d+"/, "").replace(/ HREF="([^"]+)".*/, " $1"));
    expect(folders).toEqual([
      "<DT><H3>Aye-AI-AI Links</H3>",
      "<DT><H3>Cabin</H3>",
      "<DT><A https://ex.com/1",
      "</DL><p>",
      "<DT><H3>Garden</H3>",
      "<DT><A https://ex.com/1",
      "</DL><p>",
      "<DT><A https://ex.com/3",
      "<DT><H3>Out of your lists</H3>",
      "<DT><A https://ex.com/2",
      "</DL><p>",
      "</DL><p>",
      "</DL><p>",
    ]);
  });

  it("escapes text and attributes", () => {
    const html = bookmarksHtml(
      [L(1, { title: "<script>x</script>", url: 'https://ex.com/?q="a"&b' })],
      [],
      T,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('HREF="https://ex.com/?q=%22a%22&amp;b"');
  });

  it("writes the WHATWG href and refuses any other scheme", () => {
    expect(bookmarksHtml([L(1, { url: "https:example.com/p" })], [], T)).toContain(
      'HREF="https://example.com/p"',
    );
    expect(() => bookmarksHtml([L(1, { url: "javascript:alert(1)" })], [], T)).toThrow();
  });

  it("ADD_DATE is savedAt in Unix seconds; the title falls back to the page's, then the URL", () => {
    const page = {
      status: "ok" as const,
      fetchedAt: null,
      title: "Page",
      description: null,
      imageUrl: null,
    };
    const html = bookmarksHtml(
      [L(1, { title: null, snapshot: page }), L(2, { title: null })],
      [],
      T,
    );
    const t1 = Math.floor(L(1).savedAt.getTime() / 1000);
    expect(html).toContain(`<DT><A HREF="https://ex.com/1" ADD_DATE="${t1}">Page</A>`);
    expect(html).toContain(`ADD_DATE="${t1 + 1}">https://ex.com/2</A>`);
  });

  it("matches the spec's sample exactly", () => {
    const energy: Tag = { ...space("energy", false), kind: "topic" };
    const sample = [
      "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      "<TITLE>Bookmarks</TITLE>",
      "<H1>Bookmarks</H1>",
      "<DL><p>",
      '<DT><H3 ADD_DATE="1760796131">Aye-AI-AI Links</H3>',
      "<DL><p>",
      "<DT><H3>Cabin</H3>",
      "<DL><p>",
      '<DT><A HREF="https://example.com/home-batteries" ADD_DATE="1759311000" TAGS="Cabin,energy">Home batteries, compared</A>',
      "<DD>Sizing the battery for the cabin",
      "</DL><p>",
      '<DT><A HREF="https://tools.example.org/regex" ADD_DATE="1758355200">Regex tester</A>',
      "<DT><H3>Out of your lists</H3>",
      "<DL><p>",
      "</DL><p>",
      "</DL><p>",
      "</DL><p>",
    ].join("\n");
    const html = bookmarksHtml(
      [
        L(1, {
          url: "https://example.com/home-batteries",
          title: "Home batteries, compared",
          why: { text: "Sizing the battery for the cabin", source: "stated" },
          tags: [tagOf(cabin), tagOf(energy)],
          savedAt: new Date(1759311000 * 1000),
        }),
        L(2, {
          url: "https://tools.example.org/regex",
          title: "Regex tester",
          savedAt: new Date(1758355200 * 1000),
        }),
      ],
      [cabin, energy],
      new Date(1760796131 * 1000),
    );
    expect(html).toBe(`${sample}\n`);
  });
});
