import TurndownService from "turndown";
import { describe, expect, it } from "vitest";
import type { CopyDraft } from "../core/saved-copy.js";
import { finishedMarkdown } from "../core/saved-copy.js";
import { copyHtml } from "../web/copy-markdown.js";
import { parsePage } from "./extract.ts";
import { articleMarkdown, copyBase, makeCopy } from "./extract-copy.ts";
import { EXTRACT_DEADLINE_MS } from "./extract-runner.js";
import { readArticle } from "./extract-text.ts";

const NONCE = "0123456789abcdef0123456789abcdef";
const FINAL = "https://ex.com/post/page";
const FILLER =
  "<p>Some long paragraph text here, with words, commas, and more words to read. </p>".repeat(5);

function draft(body: string, opts: { head?: string; finalUrl?: string } = {}): CopyDraft {
  const finalUrl = opts.finalUrl ?? FINAL;
  const doc = parsePage(
    `<html><head><title>T</title>${opts.head ?? ""}</head><body><article>${FILLER}${body}${FILLER}</article></body></html>`,
  );
  const article = readArticle(doc);
  if (!article) throw new Error("no article");
  const result = articleMarkdown(article, copyBase(doc, finalUrl), NONCE);
  const nums = [...result.markdown.matchAll(new RegExp(`images/([0-9]{2})-${NONCE}`, "g"))].map(
    (m) => Number(m[1]),
  );
  expect(new Set(nums)).toEqual(new Set(result.imageUrls.map((_u, i) => i + 1)));
  expect(result.markdown).not.toContain("images/x");
  expect(result.nonce).toBe(NONCE);
  return result;
}

const imgs = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `<p>pic <img src="https://ex.com/i${i + 1}.png" alt="alt${i + 1}"></p>`,
  ).join("");

describe("turndown on an element", () => {
  it("gives the same Markdown as on its serialized string", () => {
    const doc = parsePage(
      `<html><body><article><h1>Hi</h1>${FILLER}<p>a <code>c</code> <a href="https://a.b/c">l</a></p><pre><code>x = 1\ny</code></pre><ul><li>one</li><li>two</li></ul><img src="https://ex.com/a.png" alt="A"></article></body></html>`,
    );
    const el = readArticle(doc);
    if (!el) throw new Error("no article");
    const opts = { headingStyle: "atx", codeBlockStyle: "fenced" } as const;
    expect(new TurndownService(opts).turndown(el as HTMLElement)).toBe(
      new TurndownService(opts).turndown(el.outerHTML),
    );
  });
});

describe("copyBase", () => {
  const base = (head: string) => copyBase(parsePage(`<html><head>${head}</head></html>`), FINAL);
  it("uses a base href resolved against the final URL", () => {
    expect(base('<base href="https://ex.com/dir/">')).toBe("https://ex.com/dir/");
    expect(base('<base href="/sub/">')).toBe("https://ex.com/sub/");
  });
  it("ignores a base that is not http or https, and a missing one", () => {
    expect(base('<base href="javascript:alert(1)">')).toBe(FINAL);
    expect(base("")).toBe(FINAL);
  });
});

describe("articleMarkdown links", () => {
  it("resolves relative links against the base", () => {
    const d = draft('<p>see <a href="rel/page">here</a></p>', {
      head: '<base href="https://ex.com/dir/">',
    });
    expect(d.markdown).toContain("[here](https://ex.com/dir/rel/page)");
  });
  it("resolves against the final URL without a base", () => {
    expect(draft('<p>see <a href="rel/page">here</a></p>').markdown).toContain(
      "[here](https://ex.com/post/rel/page)",
    );
  });
  it("resolves a relative base against the final URL", () => {
    const d = draft('<p>see <a href="rel">here</a></p>', { head: '<base href="/sub/">' });
    expect(d.markdown).toContain("[here](https://ex.com/sub/rel)");
  });
  it("ignores a javascript: base", () => {
    const d = draft('<p>see <a href="rel">here</a></p>', { head: '<base href="javascript:x/">' });
    expect(d.markdown).toContain("[here](https://ex.com/post/rel)");
  });
  it("keeps the text of links with other schemes, and keeps mailto", () => {
    const d = draft(
      '<p>a <a href="javascript:alert(1)">JS</a> b <a href="data:text/html,x">DATA</a> c <a href="ftp://h/f">FTP</a> d <a href="mailto:a@b.c">MAIL</a></p>',
    );
    expect(d.markdown).toContain("a JS b DATA c FTP d [MAIL](mailto:a@b.c)");
    const targets = [...d.markdown.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1] ?? "");
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t).toMatch(/^(https?:|mailto:)/);
  });
});

describe("articleMarkdown images", () => {
  it("numbers the first 30 distinct images, reuses repeats, and turns the rest into alt text", () => {
    const d = draft(`${imgs(32)}<p><img src="https://ex.com/i1.png" alt="again"></p>`);
    expect(d.imageUrls).toHaveLength(30);
    expect(d.imageUrls[0]).toBe("https://ex.com/i1.png");
    expect(d.imageUrls[29]).toBe("https://ex.com/i30.png");
    expect(d.markdown).toContain(`![alt1](images/01-${NONCE})`);
    expect(d.markdown).toContain(`![alt30](images/30-${NONCE})`);
    expect(d.markdown).toContain(`![again](images/01-${NONCE})`);
    expect(d.markdown).not.toContain("images/31-");
    expect(d.markdown).toContain("pic ![alt31]()");
    expect(d.markdown).toContain("pic ![alt32]()");
    expect(d.markdown).not.toContain("![alt31](images");
  });
  it("resolves a protocol-relative source against the final URL", () => {
    const d = draft('<p>x <img src="//cdn.ex/x.png" alt="c"></p>');
    expect(d.imageUrls).toEqual(["https://cdn.ex/x.png"]);
  });
  it("marks data:, blob: and ftp: images as lost pictures with their alt text", () => {
    const d = draft(
      '<p>a <img src="data:image/png;base64,AAAA" alt="D"> b <img src="blob:https://ex.com/1" alt="B"> c <img src="ftp://ex.com/f.png" alt="F"></p>',
    );
    expect(d.imageUrls).toEqual([]);
    expect(d.markdown).toContain("a ![D]() b ![B]() c ![F]()");
  });
  it("marks a source-less image as a lost picture (Readability drops these, so no article)", () => {
    const el = parsePage('<html><body><div><p>c <img alt="N [x]"></p></div></body></html>').body
      .firstElementChild as Element;
    const d = articleMarkdown(el, FINAL, NONCE);
    expect(d.imageUrls).toEqual([]);
    expect(d.markdown).toBe("c ![N \\[x\\]]()");
  });
  it("numbers only images that survive the fenced-code rule", () => {
    const inPre = Array.from(
      { length: 30 },
      (_, i) => `<img src="https://ex.com/p${i}.png" alt="p${i}">`,
    ).join("");
    const d = draft(
      `<pre><code>code ${inPre}</code></pre><p>vis <img src="https://ex.com/v.png" alt="v"></p>`,
    );
    expect(d.imageUrls).toEqual(["https://ex.com/v.png"]);
    expect(d.markdown).toContain(`images/01-${NONCE}`);
  });
  it("gives no number to an image inside inline code, which shows as its alt there", () => {
    const d = draft(
      '<p>x <code>a <img src="https://ex.com/c.png" alt="c"></code> vis <img src="https://ex.com/v.png" alt="v"></p>',
    );
    expect(d.imageUrls).toEqual(["https://ex.com/v.png"]);
    expect(d.markdown).toContain("`a c`");
    expect(d.markdown).toContain(`![v](images/01-${NONCE})`);
  });
  it("reads only the node's src, never a data attribute", () => {
    const d = draft(
      '<p>x <img src="blob:https://ex.com/1" data-copy-src="https://ex.com/injected.png" alt="B"></p>',
    );
    expect(d.imageUrls).toEqual([]);
    expect(JSON.stringify(d)).not.toContain("injected");
  });
  it("escapes the alt text of an image past the cap", () => {
    const d = draft(`${imgs(30)}<p>z <img src="https://ex.com/over.png" alt="*not* _em_"></p>`);
    expect(d.markdown).toContain("z ![\\*not\\* \\_em\\_]()");
  });
  it("escapes brackets and backslashes in an alt and collapses whitespace", () => {
    const d = draft('<p>x <img src="https://ex.com/a.png" alt="A [x] \\ y\n  z"></p>');
    expect(d.markdown).toContain(`![A \\[x\\] \\\\ y z](images/01-${NONCE})`);
  });
});

describe("a link around blocks", () => {
  const CARD = "https://mcpmarket.com/tools/skills/x";
  const LINE = `[mcpmarket.com/tools/skills/x](${CARD})`;
  const card = (inner: string, href = CARD) => `<a href="${href}">${inner}</a>`;
  const show = (markdown: string) =>
    copyHtml(markdown, { linkId: "7", nonce: NONCE, images: new Map() });
  const noStray = (html: string) => {
    expect(html).not.toContain("](");
    expect(html).not.toContain("<p>[");
  };

  it("writes the content, then the link on its own line", () => {
    const d = draft(
      card('<img src="https://ex.com/i1.png" alt=""><h3>Title</h3><p>About the skill.</p>'),
    );
    expect(d.markdown).toContain(
      `![](images/01-${NONCE})\n\n### Title\n\nAbout the skill.\n\n${LINE}`,
    );
    expect(d.markdown).not.toContain("[![");
    const html = show(d.markdown);
    expect(html.match(/<a href="https:\/\/mcpmarket\.com\/tools\/skills\/x"/g)).toHaveLength(1);
    noStray(html);
  });

  it.each([
    ["a list", "<ul><li>one</li><li>two</li></ul>"],
    ["a quote", "<blockquote><p>said</p></blockquote>"],
    ["a div", "<div>boxed</div>"],
    ["a heading", "<h2>Head</h2>"],
    ["a paragraph", "<p>Para</p>"],
  ])("unlinks %s and adds the link line", (_name, inner) => {
    const d = draft(card(inner));
    expect(d.markdown).toContain(`\n\n${LINE}\n\n`);
    const html = show(d.markdown);
    expect(html.match(/<a /g)).toHaveLength(1);
    noStray(html);
  });

  it("keeps two adjacent card anchors apart, each with its own address", () => {
    const d = draft(
      `${card("<h3>One</h3><p>first</p>", "https://e.example/a")}${card("<h3>Two</h3><p>second</p>", "https://e.example/b")}`,
    );
    expect(d.markdown).toContain("[e.example/a](https://e.example/a)");
    expect(d.markdown).toContain("[e.example/b](https://e.example/b)");
    const html = show(d.markdown);
    expect(html).toContain('<a href="https://e.example/a"');
    expect(html).toContain('<a href="https://e.example/b"');
    noStray(html);
  });

  it("drops the card's title from the link line", () => {
    const d = draft(`<a href="${CARD}" title="Hidden words"><h3>Title</h3><p>About.</p></a>`);
    expect(d.markdown).toContain(`About.\n\n${LINE}\n\n`);
    expect(d.markdown).not.toContain("Hidden words");
  });

  it("escapes Markdown in the link line's label", () => {
    const d = draft(card("<h3>Title</h3>", "https://e.example/_a_/*b*"));
    expect(d.markdown).toContain("[e.example/\\_a\\_/\\*b\\*](https://e.example/_a_/*b*)");
    expect(show(d.markdown)).not.toContain("<em>");
  });

  it("leaves an inline link, a picture link and a titled link as before", () => {
    const d = draft(
      '<p>see <a href="https://a.b/c">here</a> now</p><p><a href="https://a.b/d"><img src="https://ex.com/p.png" alt="P"></a></p><p><a href="https://a.b/e" title="T">titled</a></p>',
    );
    expect(d.markdown).toContain("see [here](https://a.b/c) now");
    expect(d.markdown).toContain(`[![P](images/01-${NONCE})](https://a.b/d)`);
    expect(d.markdown).toContain('[titled](https://a.b/e "T")');
  });
});

describe("page text that looks like a reference", () => {
  it("survives finishing, whether images are stored or not", () => {
    const d = draft(
      '<p>text ](images/01) and <code>![a](images/01)</code> and images/01-ffff <img src="https://ex.com/a.png" alt="A"></p>',
    );
    const strings = ["](images/01)", "`![a](images/01)`", "images/01-ffff"];
    for (const s of strings) expect(d.markdown).toContain(s);
    for (const ext of ["png", null] as const) {
      const out = finishedMarkdown(d.markdown, NONCE, [{ n: 1, ext }]);
      expect(out).not.toContain(`-${NONCE}`);
      for (const s of strings) expect(out).toContain(s);
    }
  });
});

describe("budget", () => {
  it("converts 1 MiB of paragraphs with 30 images in well under the extraction deadline", () => {
    const para =
      "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</p>";
    const body = para.repeat(Math.ceil((1024 * 1024) / para.length));
    const t0 = performance.now();
    const d = draft(body + imgs(30));
    expect(performance.now() - t0).toBeLessThan(EXTRACT_DEADLINE_MS / 2);
    expect(d.imageUrls).toHaveLength(30);
  }, 30_000);
});

describe("makeCopy", () => {
  it("gives null when there is no article", () => {
    expect(makeCopy(null, FINAL)).toBeNull();
  });
  it("gives undefined when making the copy throws", () => {
    const broken = {
      querySelectorAll() {
        throw new Error("x");
      },
    } as unknown as Element;
    expect(makeCopy(broken, FINAL)).toBeUndefined();
  });
  it("gives a draft with a fresh 32-hex nonce for a real article", () => {
    const el = readArticle(parsePage(`<html><body><article>${FILLER}</article></body></html>`));
    if (!el) throw new Error("no article");
    const d = makeCopy(el, FINAL);
    expect(d?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(d?.markdown).toContain("Some long paragraph");
  });
});
