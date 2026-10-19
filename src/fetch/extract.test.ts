import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { Readability } from "@mozilla/readability";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractSnapshot } from "./extract.js";

const URL0 = "https://example.com/post/1";
const PARA = "Home batteries store solar energy for evening use. ";
const BODY = PARA.repeat(20);

function page(body: string, head = "") {
  return `<!doctype html><html><head><title>Plain</title>${head}</head><body>${body}</body></html>`;
}
function article(inner: string) {
  return page(`<article><h1>Heading</h1><p>${BODY}</p>${inner}</article>`);
}
function wellFormed(s: string): boolean {
  try {
    encodeURIComponent(s); // throws on a lone surrogate
    return true;
  } catch {
    return false;
  }
}
function ftsFinds(text: string | null, query: string): boolean {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(body, tokenize='porter unicode61 remove_diacritics 2')",
    );
    db.prepare("INSERT INTO t(body) VALUES (?)").run(text ?? "");
    const row = db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH ?").get(query) as {
      n: number;
    };
    return row.n > 0;
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  const g = globalThis as Record<string, unknown>;
  delete g.scriptRan;
  delete g.onerrorRan;
});

describe("metadata fallbacks", () => {
  it("prefers og over the plain tags", () => {
    const s = extractSnapshot(
      page(
        "",
        `<meta property="og:title" content="OG title"><meta property="og:description" content="OG desc">
         <meta name="description" content="plain desc"><meta property="og:image" content="/og.png">
         <meta name="twitter:image" content="/tw.png">`,
      ),
      URL0,
    );
    expect(s).toMatchObject({
      title: "OG title",
      description: "OG desc",
      imageUrl: "https://example.com/og.png",
    });
  });

  it("falls back to title, name=description and twitter:image", () => {
    const s = extractSnapshot(
      page(
        "",
        `<meta name="description" content="plain desc"><meta name="twitter:image" content="https://cdn.example.com/t.png">`,
      ),
      URL0,
    );
    expect(s).toMatchObject({
      title: "Plain",
      description: "plain desc",
      imageUrl: "https://cdn.example.com/t.png",
    });
  });

  it("skips blank and whitespace-only values and takes the next source", () => {
    const s = extractSnapshot(
      page(
        "",
        `<meta property="og:title" content="   "><meta property="og:description" content="">
         <meta name="description" content="  real  "><meta property="og:image" content=" ">
         <meta name="twitter:image" content="/tw.png">`,
      ),
      URL0,
    );
    expect(s).toMatchObject({
      title: "Plain",
      description: "real",
      imageUrl: "https://example.com/tw.png",
    });
  });

  it.each(["Description", "DESCRIPTION"])("matches meta name=%s without regard to case", (name) => {
    const s = extractSnapshot(page("", `<meta name="${name}" content="d">`), URL0);
    expect(s.description).toBe("d");
  });

  it("matches meta property without regard to case", () => {
    const s = extractSnapshot(page("", `<meta property="OG:Title" content="T">`), URL0);
    expect(s.title).toBe("T");
  });

  it("takes the title from an HTML <title>, never an SVG one", () => {
    const svg = "<svg><title>SVGT</title></svg>";
    expect(extractSnapshot(`<html><body>${svg}</body></html>`, URL0).title).toBeNull();
    const withHtml = `<html><head><title>HTMLT</title></head><body>${svg}</body></html>`;
    expect(extractSnapshot(withHtml, URL0).title).toBe("HTMLT");
  });

  it("returns null for every field that has no usable source", () => {
    const s = extractSnapshot("<html><body></body></html>", URL0);
    expect(s).toMatchObject({ title: null, description: null, imageUrl: null });
  });

  it("collapses whitespace in the title", () => {
    expect(extractSnapshot("<title>  A \n  B </title>", URL0).title).toBe("A B");
  });
});

describe("image urls", () => {
  const withImage = (og: string, tw = "") =>
    page("", `<meta property="og:image" content="${og}">${tw}`);

  it("resolves a relative url against the final url", () => {
    expect(extractSnapshot(withImage("img/a.png"), URL0).imageUrl).toBe(
      "https://example.com/post/img/a.png",
    );
  });

  it("resolves against <base href>, itself resolved against the final url", () => {
    const html = page("", `<base href="/assets/"><meta property="og:image" content="a.png">`);
    expect(extractSnapshot(html, URL0).imageUrl).toBe("https://example.com/assets/a.png");
  });

  it("drops a newline inside a url the way the url parser does", () => {
    expect(extractSnapshot(withImage("https://ex.com/a\nb.png"), URL0).imageUrl).toBe(
      "https://ex.com/ab.png",
    );
    const html = page("", `<base href="/as\nsets/"><meta property="og:image" content="a.png">`);
    expect(extractSnapshot(html, URL0).imageUrl).toBe("https://example.com/assets/a.png");
  });

  it("ignores an unparseable <base href>", () => {
    const html = page("", `<base href="http://[bad"><meta property="og:image" content="a.png">`);
    expect(extractSnapshot(html, URL0).imageUrl).toBe("https://example.com/post/a.png");
  });

  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "ftp://example.com/a.png",
    "file:///etc/passwd",
    "http://user:pw@example.com/a.png",
    "https://user@example.com/a.png",
    "https://:pw@example.com/a.png",
    "http://[bad",
  ])("falls through past %s to the next source", (bad) => {
    const html = withImage(bad, `<meta name="twitter:image" content="/ok.png">`);
    expect(extractSnapshot(html, URL0).imageUrl).toBe("https://example.com/ok.png");
  });

  it("returns null when no source is usable", () => {
    expect(extractSnapshot(withImage("javascript:alert(1)"), URL0).imageUrl).toBeNull();
  });

  it("caps an image url at 2,048 characters and falls through rather than truncating", () => {
    const long = `https://example.com/${"a".repeat(2_040)}`;
    const ok = `https://example.com/${"a".repeat(2_028)}`;
    expect(ok).toHaveLength(2_048);
    expect(extractSnapshot(withImage(ok), URL0).imageUrl).toBe(ok);
    const html = withImage(long, `<meta name="twitter:image" content="/ok.png">`);
    expect(extractSnapshot(html, URL0).imageUrl).toBe("https://example.com/ok.png");
    expect(extractSnapshot(withImage(long), URL0).imageUrl).toBeNull();
  });

  it("measures the resolved url, so a long relative path is capped too", () => {
    expect(extractSnapshot(withImage("a".repeat(5_000)), URL0).imageUrl).toBeNull();
  });

  it("keeps private-address images; the consumer must guard them", () => {
    expect(extractSnapshot(withImage("http://127.0.0.1:3002/a.png"), URL0).imageUrl).toBe(
      "http://127.0.0.1:3002/a.png",
    );
  });
});

describe("icon urls", () => {
  const icons = (head: string, url = URL0) => extractSnapshot(page("", head), url).iconUrls;
  const link = (attrs: string) => `<link ${attrs}>`;

  it("takes Photopea's real head as one candidate: both declarations name the same file", () => {
    const head =
      link('rel="apple-touch-icon" href="promo/icon512.png"') +
      link('rel="icon" sizes="512x512" href="promo/icon512.png"');
    expect(icons(head, "https://www.photopea.com/")).toEqual([
      "https://www.photopea.com/promo/icon512.png",
    ]);
  });

  it("puts a sized declaration before an unsized one", () => {
    const head =
      link('rel="apple-touch-icon" href="/touch.png"') +
      link('rel="icon" sizes="512x512" href="/icon512.png"');
    expect(icons(head)).toEqual([
      "https://example.com/icon512.png",
      "https://example.com/touch.png",
    ]);
  });

  it("★ puts Apple's later 180×180 icon before its earlier unsized one", () => {
    // [An invented default size for an unsized declaration.]
    const head =
      link('rel="apple-touch-icon" href="/iphone.png"') +
      link('rel="apple-touch-icon" sizes="180x180" href="/180.png"');
    expect(icons(head)).toEqual(["https://example.com/180.png", "https://example.com/iphone.png"]);
  });

  it("★ filters before ranking: an SVG declared sizes=any never takes a slot", () => {
    // [Ranking, or keeping the top two, before filtering.]
    const head =
      link('rel="icon" type="image/svg+xml" sizes="any" href="/i.svg"') +
      link('rel="icon" type="image/png" sizes="32x32" href="/32.png"') +
      link('rel="icon" type="image/png" sizes="16x16" href="/16.png"');
    expect(icons(head)).toEqual(["https://example.com/32.png", "https://example.com/16.png"]);
  });

  it("puts the later of two unsized declarations first, and the later of two equal sizes first", () => {
    expect(icons(link('rel="icon" href="/a.png"') + link('rel="icon" href="/b.png"'))).toEqual([
      "https://example.com/b.png",
      "https://example.com/a.png",
    ]);
    expect(
      icons(
        link('rel="icon" sizes="64x64" href="/a.png"') +
          link('rel="icon" sizes="64x64" href="/b.png"'),
      ),
    ).toEqual(["https://example.com/b.png", "https://example.com/a.png"]);
  });

  it("counts icon, shortcut icon, apple-touch-icon-precomposed and any case; not mask-icon", () => {
    expect(icons(link('rel="shortcut icon" href="/s.png"'))).toEqual(["https://example.com/s.png"]);
    expect(icons(link('rel="apple-touch-icon-precomposed" href="/p.png"'))).toEqual([
      "https://example.com/p.png",
    ]);
    expect(icons(link('rel="ICON" href="/u.png"'))).toEqual(["https://example.com/u.png"]);
    expect(icons(link('rel="mask-icon" href="/m.png"'))).toEqual([]);
    expect(icons(link('rel="stylesheet" href="/x.png"'))).toEqual([]);
  });

  it("skips a declaration with a media attribute, even an empty one", () => {
    const head =
      link('rel="icon" media="(prefers-color-scheme: dark)" sizes="512x512" href="/dark.png"') +
      link('rel="icon" media="" href="/empty.png"') +
      link('rel="icon" sizes="32x32" href="/light.png"');
    expect(icons(head)).toEqual(["https://example.com/light.png"]);
  });

  it.each([
    'type="image/x-icon" href="/a.png"',
    'type="image/vnd.microsoft.icon" href="/a.png"',
    'type="image/svg+xml" href="/a.png"',
    'type="" href="/a.png"',
    'href="/favicon.ICO"',
    'href="/logo.svg"',
    'href="/favicon.ico?v=2"',
  ])("refuses %s", (attrs) => {
    expect(icons(link(`rel="icon" ${attrs}`))).toEqual([]);
  });

  it.each([
    ['type="image/PNG; q=1" href="/a.ico"', "https://example.com/a.ico"],
    ['href="/icon"', "https://example.com/icon"],
    ['href="/icon.png?x=.ico"', "https://example.com/icon.png?x=.ico"],
    ['type="image/webp" href="/i.webp"', "https://example.com/i.webp"],
  ])("keeps %s", (attrs, want) => {
    expect(icons(link(`rel="icon" ${attrs}`))).toEqual([want]);
  });

  it("resolves against <base href> and refuses what the image URL rule refuses", () => {
    expect(icons(`<base href="/assets/">${link('rel="icon" href="i.png"')}`)).toEqual([
      "https://example.com/assets/i.png",
    ]);
    const ok = `https://example.com/${"a".repeat(2_048 - "https://example.com/".length)}`;
    expect(icons(link(`rel="icon" href="${ok}"`))).toEqual([ok]);
    for (const href of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "https://u:p@example.com/i.png",
      `${ok}a`,
    ]) {
      expect(icons(link(`rel="icon" href="${href}"`)), href).toEqual([]);
    }
    expect(icons(link('rel="icon"'))).toEqual([]);
  });

  it("counts a repeated URL once, at its best rank, and keeps at most two", () => {
    const head =
      link('rel="icon" href="/a.png"') +
      link('rel="icon" sizes="16x16" href="/b.png"') +
      link('rel="icon" sizes="96x96" href="/a.png"') +
      link('rel="icon" sizes="48x48" href="/c.png"');
    expect(icons(head)).toEqual(["https://example.com/a.png", "https://example.com/c.png"]);
  });

  it("★ treats a data: og:image as no preview and still finds the icon", () => {
    // [Treating a rejected preview as a named one.]
    const head =
      '<meta property="og:image" content="data:image/png;base64,AAAA">' +
      link('rel="icon" type="image/png" href="/i.png"');
    const s = extractSnapshot(page("", head), URL0);
    expect(s.imageUrl).toBeNull();
    expect(s.iconUrls).toEqual(["https://example.com/i.png"]);
  });

  it("returns the icons beside a usable preview: the store decides which is fetched (R6)", () => {
    const head = `<meta property="og:image" content="/og.png">${link('rel="icon" href="/i.png"')}`;
    const s = extractSnapshot(page("", head), URL0);
    expect(s.imageUrl).toBe("https://example.com/og.png");
    expect(s.iconUrls).toEqual(["https://example.com/i.png"]);
  });

  it("reads unusual sizes values (R8)", () => {
    const rank = (sizes: string) =>
      icons(
        link(`rel="icon" sizes="${sizes}" href="/x.png"`) +
          link('rel="icon" sizes="100x100" href="/h.png"'),
      )[0];
    expect(rank("16x16 32x32 64x64 128x128")).toBe("https://example.com/x.png");
    expect(rank("512X512")).toBe("https://example.com/x.png");
    expect(rank("any 32x32")).toBe("https://example.com/h.png");
    expect(rank("99999999999999999999x99999999999999999999")).toBe("https://example.com/x.png");
    for (const unsized of ["0x0", "064x064", "16x", "any", ""]) {
      expect(rank(unsized), unsized).toBe("https://example.com/h.png");
    }
  });

  it("ranks 5,000 declarations into the best two", () => {
    const small = Array.from({ length: 2_500 }, (_, i) =>
      link(`rel="icon" sizes="16x16" href="/s${i}.png"`),
    ).join("");
    const head = `${small}${link('rel="icon" sizes="192x192" href="/big.png"')}${small.replaceAll("/s", "/t")}`;
    const start = performance.now();
    expect(icons(head)).toEqual(["https://example.com/big.png", "https://example.com/t2499.png"]);
    expect(performance.now() - start).toBeLessThan(5_000);
  });
});

describe("text", () => {
  it("returns article text, and null for a page with no article", () => {
    const s = extractSnapshot(article(""), URL0);
    expect(s.text).toContain("Home batteries store solar energy");
    expect(extractSnapshot("<html><body></body></html>", URL0).text).toBeNull();
  });

  it("never returns markup", () => {
    const s = extractSnapshot(article("<p>x <b>bold</b> <a href='/z'>link</a></p>"), URL0);
    expect(s.text).toContain("x bold link");
    expect(s.text).not.toMatch(/[<>]/);
  });

  it("collapses whitespace runs to one space", () => {
    const s = extractSnapshot(article("<p>one \t\n   two</p>"), URL0);
    expect(s.text).toContain("one two");
  });

  it.each([
    ["paragraphs", "<p>Quokka</p><p>Battery</p>"],
    ["divs", "<div>Quokka</div><div>Battery</div>"],
    ["br", "<p>Quokka<br>Battery</p>"],
    ["list items", "<ul><li>Quokka</li><li>Battery</li></ul>"],
    ["headings", "<h2>Quokka</h2><h3>Battery</h3>"],
    ["table cells", "<table><tr><td>Quokka</td><td>Battery</td></tr></table>"],
    ["blockquote and pre", "<blockquote>Quokka</blockquote><pre>Battery</pre>"],
  ])("keeps a word boundary FTS5 can find across %s", (_name, inner) => {
    const text = extractSnapshot(article(inner), URL0).text;
    expect(text).not.toContain("QuokkaBattery");
    expect(ftsFinds(text, "quokka")).toBe(true);
    expect(ftsFinds(text, "battery")).toBe(true);
    expect(ftsFinds(text, '"quokka battery"')).toBe(true);
  });

  it("does not insert a break inside inline markup", () => {
    const text = extractSnapshot(article("<p>Quo<b>kka</b> Battery</p>"), URL0).text;
    expect(text).toContain("Quokka Battery");
  });

  it("turns paragraph breaks into a single newline", () => {
    const text = extractSnapshot(article("<p>Alpha</p><p>Beta</p>"), URL0).text ?? "";
    expect(text).toContain("Alpha\nBeta");
    expect(text).not.toContain("\n\n");
  });
});

describe("templates", () => {
  const SHADOW = `<div><template shadowrootmode="open"><style>CSS_POISON{}</style><script>SCRIPT_POISON</script><h1>Shadow heading</h1><p>${BODY}</p></template></div>`;

  it("keeps a declarative shadow-root article without its CSS or script", () => {
    const s = extractSnapshot(page(SHADOW), URL0);
    expect(s.text).toContain("Home batteries store solar energy");
    expect(s.text).not.toContain("CSS_POISON");
    expect(s.text).not.toContain("SCRIPT_POISON");
  });

  it("drops an ordinary template", () => {
    const s = extractSnapshot(article("<template><p>TEMPLATE_TEXT</p></template>"), URL0);
    expect(s.text).toContain("Home batteries");
    expect(s.text).not.toContain("TEMPLATE_TEXT");
  });

  it("drops an ordinary template nested in a shadow root", () => {
    const html = page(
      `<div><template shadowrootmode="open"><p>${BODY}</p><template><p>INNER_TEMPLATE</p></template></template></div>`,
    );
    const s = extractSnapshot(html, URL0);
    expect(s.text).toContain("Home batteries");
    expect(s.text).not.toContain("INNER_TEMPLATE");
  });
});

describe("caps", () => {
  it("caps text at 100,000 characters", () => {
    const s = extractSnapshot(article(`<p>${"word ".repeat(40_000)}</p>`), URL0);
    expect(Array.from(s.text ?? "")).toHaveLength(100_000);
  });

  it("cuts by code point so an emoji is never split", () => {
    const s = extractSnapshot(article(`<p>${"😀".repeat(120_000)}</p>`), URL0);
    const text = s.text ?? "";
    expect(Array.from(text)).toHaveLength(100_000);
    expect(wellFormed(text)).toBe(true);
  });

  it("caps title at 500 and description at 1,000 code points", () => {
    const s = extractSnapshot(
      page(
        "",
        `<meta property="og:title" content="${"😀".repeat(600)}"><meta property="og:description" content="${"d".repeat(1500)}">`,
      ),
      URL0,
    );
    expect(Array.from(s.title ?? "")).toHaveLength(500);
    expect(Array.from(s.description ?? "")).toHaveLength(1_000);
    expect(wellFormed(s.title ?? "")).toBe(true);
  });

  it("leaves text under the cap untouched", () => {
    const text = extractSnapshot(article(""), URL0).text ?? "";
    expect(text.length).toBeLessThan(100_000);
    expect(text).toContain(PARA.trim());
  });
});

describe("degenerate input", () => {
  it.each(["", "   ", "hello world"])("returns an empty snapshot for %j", (html) => {
    expect(extractSnapshot(html, URL0)).toEqual({
      title: null,
      description: null,
      imageUrl: null,
      iconUrls: [],
      text: null,
    });
  });
});

describe("extraction never throws and keeps the metadata", () => {
  const NULLS = { title: null, description: null, imageUrl: null, iconUrls: [], text: null };

  it.each([
    "<template>x</template>",
    '<template shadowrootmode="open"></template>',
    "<!doctype html><template></template>",
    '<template shadowrootmode="open">hello</template>',
  ])("returns the all-null snapshot for %j", (html) => {
    expect(extractSnapshot(html, URL0)).toEqual(NULLS);
  });

  it("survives <span> nested 5,000 deep and keeps the title", () => {
    const deep = `${"<span>".repeat(5_000)}x${"</span>".repeat(5_000)}`;
    const s = extractSnapshot(
      `<title>t</title><body><article><p>${BODY}</p>${deep}</article></body>`,
      URL0,
    );
    expect(s.title).toBe("t");
    expect(s.text).toContain("Home batteries store solar energy");
  }, 60_000);

  it("survives a shadow root with 100,000 children", () => {
    const html = `<title>t</title><meta property="og:image" content="/og.png"><body><div><template shadowrootmode="open">${"<i></i>".repeat(100_000)}<p>${BODY}</p></template></div></body>`;
    const s = extractSnapshot(html, URL0);
    expect(s.title).toBe("t");
    expect(s.imageUrl).toBe("https://example.com/og.png");
    expect(s.text).toContain("Home batteries store solar energy");
  }, 60_000);

  it("returns text null with the metadata when the text step throws", () => {
    vi.spyOn(Readability.prototype, "parse").mockImplementation(() => {
      throw new Error("readability failed");
    });
    const s = extractSnapshot(
      `<title>t</title><meta property="og:image" content="/og.png"><body><article><p>${BODY}</p></article></body>`,
      URL0,
    );
    expect(s).toEqual({
      title: "t",
      description: null,
      imageUrl: "https://example.com/og.png",
      iconUrls: [],
      text: null,
    });
  });
});

describe("no page code runs and nothing loads", () => {
  const html = (extra: string) =>
    page(
      `<script>globalThis.scriptRan = 1</script>
       <img src="http://127.0.0.1:3002/admin" onerror="globalThis.onerrorRan = 1">
       <iframe src="http://127.0.0.1:3002/frame"></iframe>
       <link rel="stylesheet" href="http://127.0.0.1:3002/x.css">
       <article><p>${BODY}</p><img src="http://127.0.0.1:3002/a.png"></article>`,
      `<meta property="og:image" content="http://127.0.0.1:3002/og.png">${extra}`,
    );

  async function observe(run: () => void) {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      calls.push("fetch");
      return new Response("");
    }) as never);
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket) {
      calls.push("socket.connect");
      return this;
    } as never);
    run();
    await new Promise((r) => setTimeout(r, 50));
    return calls;
  }

  it("opens no socket, calls no fetch, even after timers drain, and runs no script or handler", async () => {
    let snapshot: ReturnType<typeof extractSnapshot> | undefined;
    const calls = await observe(() => {
      snapshot = extractSnapshot(html(""), URL0);
    });

    expect(snapshot?.text).toContain("Home batteries");
    expect(snapshot?.imageUrl).toBe("http://127.0.0.1:3002/og.png");
    expect(calls).toEqual([]);
    const g = globalThis as Record<string, unknown>;
    expect(g.scriptRan).toBeUndefined();
    expect(g.onerrorRan).toBeUndefined();
  });

  it("would notice a request made through http.get", async () => {
    const calls = await observe(() => {
      const req = http.get("http://127.0.0.1:3002/og.png", () => {});
      req.on("error", () => {});
      req.destroy();
    });
    expect(calls).toContain("socket.connect");
  });

  it("would notice a fetch deferred to a timer", async () => {
    const calls = await observe(() => {
      setTimeout(() => void fetch("http://127.0.0.1:3002/og.png"), 0);
    });
    expect(calls).toContain("fetch");
  });
});

describe("a real page", () => {
  it("extracts the Node.js 22 announcement", () => {
    const html = fs.readFileSync(
      new URL("./fixtures/nodejs-22-announcement.html", import.meta.url),
      "utf8",
    );
    const s = extractSnapshot(
      html,
      "https://nodejs.org/en/blog/announcements/v22-release-announce",
    );
    expect(s.title).toBe("Node.js — Node.js 22 is now available!");
    expect(s.description).toMatch(/^Node\.js® is a free, open-source/);
    expect(s.imageUrl).toMatch(/^https:\/\/nodejs\.org\/en\/next-data\/og\//);
    expect(s.text).toContain("WebSocket client");
    expect(ftsFinds(s.text, "websocket")).toBe(true);
    expect(s.text).not.toMatch(/[<>]/);
    expect((s.text ?? "").length).toBeLessThan(100_000);
  });
});
