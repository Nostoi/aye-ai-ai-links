import fs from "node:fs";
import http from "node:http";
import net from "node:net";
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
