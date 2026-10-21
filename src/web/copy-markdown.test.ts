import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { CopyImageInfo } from "../core/saved-copy.js";
import { type CopyRefs, copyHtml, copyImageSrc } from "./copy-markdown.js";

const NONCE = "a".repeat(32);
const OTHER = "b".repeat(32);
const png: CopyImageInfo = { contentType: "image/png", version: "v1" };
const refs = (over: Partial<CopyRefs> = {}): CopyRefs => ({
  linkId: "7",
  nonce: NONCE,
  images: new Map([[1, png]]),
  ...over,
});

const parse = (html: string) =>
  parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
const all = (html: string) => [...parse(html).querySelectorAll("*")];
const attrs = (html: string, name: string) =>
  all(html).flatMap((e) => (e.hasAttribute(name) ? [e.getAttribute(name) as string] : []));
const text = (html: string) => parse(html).body.textContent ?? "";

describe("copyImageSrc", () => {
  it("names the copy's image route", () => {
    expect(copyImageSrc("7", 3)).toBe("/links/7/copy/images/3");
  });
});

describe("copyHtml safety", () => {
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "[js](javascript:alert(1))",
    "[data](data:text/html,<b>x</b>)",
    "![remote](https://e.example/a.png)",
    "![gone](images/31)",
    "[rel](/foo)",
  ].join("\n\n");

  it("emits only safe elements and attributes for the spec's hostile input", () => {
    const html = copyHtml(hostile, refs());
    expect(all(html).filter((e) => e.tagName === "SCRIPT")).toHaveLength(0);
    for (const e of all(html)) {
      expect(
        [...e.attributes].filter((a) => a.name.startsWith("on") || a.name === "style"),
      ).toEqual([]);
    }
    for (const href of attrs(html, "href")) expect(href).toMatch(/^(https?:|mailto:)/);
    for (const src of attrs(html, "src"))
      expect(src.startsWith("/links/7/copy/images/")).toBe(true);
    expect(all(html).filter((e) => e.tagName === "IMG")).toHaveLength(0);
    expect(html).not.toContain("](");
  });

  it("keeps the labels of dropped links and images as text", () => {
    const t = text(copyHtml(hostile, refs()));
    for (const label of ["js", "data", "remote", "gone", "rel"]) expect(t).toContain(label);
  });

  it.each([
    "[x](&#106;avascript:alert(1))",
    "[x](JAVASCRIPT:alert(1))",
    "<javascript:alert(1)>",
    "![a](data:image/png;base64,AAAA)",
    "[x](  javascript:alert(1))",
    "[x](vbscript:msgbox(1))",
  ])("never lets %s reach an href or src", (md) => {
    const html = copyHtml(md, refs());
    for (const v of [...attrs(html, "href"), ...attrs(html, "src")]) {
      expect(v).not.toMatch(/javascript|data:|vbscript/i);
    }
    expect(all(html).filter((e) => e.tagName === "A" || e.tagName === "IMG")).toHaveLength(0);
  });

  it("keeps a mailto link", () => {
    expect(attrs(copyHtml("[mail](mailto:a@b.example)", refs()), "href")).toEqual([
      "mailto:a@b.example",
    ]);
  });

  it("opens links safely in a new tab", () => {
    const a = parse(copyHtml("[x](https://e.example/p)", refs())).querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://e.example/p");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });

  it("shows escaped markup as readable text", () => {
    const html = copyHtml("`<img src=x onerror=alert(1)>`", refs());
    expect(all(html).filter((e) => e.tagName === "IMG")).toHaveLength(0);
    expect(parse(html).querySelector("code")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("removes a link's pair but keeps an image inside a kept link", () => {
    const html = copyHtml(`[![one](images/01-${NONCE})](https://e.example)`, refs());
    expect(parse(html).querySelector("a img")?.getAttribute("src")).toBe("/links/7/copy/images/1");
  });
});

describe("copyHtml images (F5)", () => {
  it("resolves a nonce reference to the copy's image route", () => {
    const html = copyHtml(`![one](images/01-${NONCE})`, refs());
    expect(html).toContain('<img src="/links/7/copy/images/1" alt="one" loading="lazy"');
  });

  it("shows an image missing from the ledger as its alt text", () => {
    const html = copyHtml(`![two](images/02-${NONCE})`, refs());
    expect(all(html).filter((e) => e.tagName === "IMG")).toHaveLength(0);
    expect(text(html)).toContain("two");
  });

  it("shows another copy's nonce as alt text, without printing the nonce", () => {
    const html = copyHtml(`![three](images/01-${OTHER})`, refs());
    expect(all(html).filter((e) => e.tagName === "IMG")).toHaveLength(0);
    expect(text(html)).toContain("three");
    expect(html).not.toMatch(/[0-9a-f]{32}/);
  });

  it("matches nothing when the nonce is null or invalid", () => {
    for (const nonce of [null, "n1"]) {
      const html = copyHtml(`![four](images/01-${nonce})`, refs({ nonce }));
      expect(all(html).filter((e) => e.tagName === "IMG")).toHaveLength(0);
      expect(text(html)).toContain("four");
    }
  });

  it("resolves a finished reference whose extension matches the ledger", () => {
    const html = copyHtml("![a](images/01.png)", refs());
    expect(parse(html).querySelector("img")?.getAttribute("src")).toBe("/links/7/copy/images/1");
  });

  it("shows a finished reference with the wrong extension as alt text", () => {
    const html = copyHtml("![a](images/01.jpg)", refs());
    expect(all(html).filter((e) => e.tagName === "IMG")).toHaveLength(0);
    expect(text(html)).toContain("a");
  });

  it("shows a local image path used as a link as its label", () => {
    const html = copyHtml("[x](images/01.png)", refs());
    expect(attrs(html, "href")).toEqual([]);
    expect(text(html)).toContain("x");
  });

  it("escapes the alt text of a dropped image", () => {
    const html = copyHtml("![<b>x</b> *y*](https://e.example/a.png)", refs());
    expect(all(html).filter((e) => e.tagName === "B")).toHaveLength(0);
    expect(text(html)).toContain("<b>x</b> y");
  });
});

describe("copyHtml tables and references", () => {
  it("renders no table and no style attribute", () => {
    const html = copyHtml("| a | b |\n|:-:|--:|\n| 1 | 2 |", refs());
    expect(html).not.toContain("<table");
    expect(html).not.toContain("style=");
  });

  it("does not resolve a reference link, and leaks neither definition syntax nor nonce", () => {
    const html = copyHtml(`[x][r]\n\n[r]: https://e.example\n\n![i](images/01-${NONCE})`, refs());
    expect(attrs(html, "href")).toEqual([]);
    expect(html).not.toContain("](");
    expect(html).not.toContain(NONCE);
  });
});

describe("copyHtml rendering budget", () => {
  const TWO_MIB = 2 * 1024 * 1024;
  const pad = (unit: string, prefix = "") =>
    prefix + unit.repeat(Math.ceil((TWO_MIB - prefix.length) / unit.length));
  const article = Array.from(
    { length: Math.ceil(TWO_MIB / 90) },
    (_, i) => `Paragraph ${i} with *emphasis*, a [link](https://e.example/${i}) and \`code\`.\n`,
  ).join("\n");
  const inputs: Record<string, string> = {
    "multiline reference definition": pad("x\n", '[a]: /u "'),
    "unclosed multiline link label": pad("a\n", "["),
    "unclosed html comment": pad("a ", "<!--"),
    "open brackets": pad("["),
    "unclosed emphasis": pad("*a"),
    "realistic article": article,
  };
  // Alone the slowest takes ~1.3 s and the full suite's load triples that; a quadratic rule takes minutes.
  const BUDGET_MS = 10_000;

  it.each(Object.entries(inputs))(
    "renders %s within the budget",
    (_name, md) => {
      const start = performance.now();
      copyHtml(md, refs());
      expect(performance.now() - start).toBeLessThan(BUDGET_MS);
    },
    30_000,
  );
});

describe("copyHtml repairs a link that was saved around blocks (#220)", () => {
  const A = "https://e.example/a";
  const B = "https://e.example/b";
  const hrefs = (html: string) => attrs(html, "href");
  const noStray = (html: string) => {
    expect(text(html)).not.toContain("](");
    expect(text(html)).not.toMatch(/(^|\s)\[(\s|$)/);
  };

  it("shows the card, then one link to its address, with no stray brackets", () => {
    const html = copyHtml(
      `before\n\n[![](images/01.png)\n\n### Title\n\nAbout.\n\n](${A})\n\nafter`,
      refs(),
    );
    expect(hrefs(html)).toEqual([A]);
    expect(parse(html).querySelector("img")?.getAttribute("src")).toBe("/links/7/copy/images/1");
    expect(text(html)).toContain("Title");
    expect(text(html)).toContain("About.");
    noStray(html);
  });

  it("keeps two adjacent cards apart, each with its own address", () => {
    const html = copyHtml(`[\n\n### One\n\n](${A})[\n\n### Two\n\n](${B})`, refs());
    expect(hrefs(html)).toEqual([A, B]);
    noStray(html);
  });

  it("repairs a card inside a blockquote and inside a list item, keeping the container", () => {
    const quote = copyHtml(`> [\n>\n> ### T\n>\n> ](${A})\n\nout`, refs());
    expect(parse(quote).querySelector("blockquote h3")?.textContent).toBe("T");
    expect(hrefs(quote)).toEqual([A]);
    noStray(quote);
    const list = copyHtml(`- [\n\n  item\n\n  ](${A})\n- plain`, refs());
    expect(parse(list).querySelectorAll("li")).toHaveLength(2);
    expect(hrefs(list)).toEqual([A]);
    noStray(list);
  });

  it("never pairs across a quote or list boundary", () => {
    for (const md of [`[\n\n> ](${A})`, `> [\n\n](${A})`, `- [\n- ](${A})`]) {
      const html = copyHtml(md, refs());
      expect(hrefs(html)).toEqual([]);
      expect(text(html)).toContain("](");
    }
  });

  it("leaves a fenced code block holding the same text unchanged", () => {
    const html = copyHtml(`\`\`\`\n[\n\n](${A})\n\`\`\``, refs());
    expect(hrefs(html)).toEqual([]);
    expect(parse(html).querySelector("pre code")?.textContent).toBe(`[\n\n](${A})\n`);
  });

  it("leaves a real link, and a closer with no opener, as they are", () => {
    const real = copyHtml(`[\n\nstray\n\n[a](${A}) and more`, refs());
    expect(hrefs(real)).toEqual([A]);
    expect(parse(real).querySelector("a")?.textContent).toBe("a");
    expect(text(real)).toContain("[");
    const orphan = copyHtml(`](${A})`, refs());
    expect(hrefs(orphan)).toEqual([]);
    expect(text(orphan)).toContain(`](${A})`);
  });

  it("still refuses an unsafe repaired address", () => {
    const html = copyHtml("[\n\ncard\n\n](javascript:alert(1))", refs());
    expect(all(html).filter((e) => e.tagName === "A")).toHaveLength(0);
    expect(html).not.toContain("javascript:");
    expect(text(html)).toContain("card");
  });

  it("reads escaped parentheses in the address", () => {
    const html = copyHtml("[\n\ncard\n\n](https://e.example/a\\(1\\))", refs());
    expect(hrefs(html)).toEqual(["https://e.example/a(1)"]);
  });

  it("repairs a picture in a finished copy and in an unfinished one", () => {
    for (const src of ["images/01.png", `images/01-${NONCE}`]) {
      const html = copyHtml(`[![x](${src})\n\n](${A})`, refs());
      expect(hrefs(html)).toEqual([A]);
      expect(parse(html).querySelector("img")?.getAttribute("src")).toBe("/links/7/copy/images/1");
    }
  });

  it("drops the title of a titled card address", () => {
    for (const title of [`"t"`, "'t'", "(t)"]) {
      const html = copyHtml(`[\n\nT\n\n](${A} ${title})`, refs());
      expect(hrefs(html)).toEqual([A]);
      expect(text(html)).not.toContain('"t"');
      noStray(html);
    }
    const open = copyHtml(`[\n\nT\n\n](${A} "t)`, refs());
    expect(hrefs(open)).toEqual([]);
    expect(text(open)).toContain("](");
  });

  it("keeps text before the closer, then the address on its own line", () => {
    const html = copyHtml(`[\n\nTitle\n\nRead more](${A})`, refs());
    expect(hrefs(html)).toEqual([A]);
    expect(
      all(html)
        .filter((e) => e.tagName === "P")
        .map((p) => p.textContent),
    ).toEqual(["Title", "Read more", "e.example/a"]);
    noStray(html);
    const quote = copyHtml(`> [\n>\n> Title\n>\n> Read more](${A})`, refs());
    expect(parse(quote).querySelector("blockquote a")?.getAttribute("href")).toBe(A);
    noStray(quote);
  });

  it("keeps text after a closer's address as the next card's start", () => {
    const html = copyHtml(`[\n\nOne\n\nmore](${A})[\n\nTwo\n\n](${B})`, refs());
    expect(hrefs(html)).toEqual([A, B]);
    noStray(html);
  });

  it("does not take a balanced link or an escaped bracket for a closer", () => {
    const real = copyHtml(`[\n\nx\n\n[a](${B}) y`, refs());
    expect(hrefs(real)).toEqual([B]);
    expect(parse(real).querySelector("a")?.textContent).toBe("a");
    expect(text(real)).toContain("[");
    const escaped = copyHtml(`[\n\nTitle\n\nRead more\\](${A})`, refs());
    expect(hrefs(escaped)).toEqual([]);
    expect(text(escaped)).toContain("](");
  });

  it("leaves a closer that is not a whole address-and-paren as it is", () => {
    for (const closer of [`](${A} oops)`, `](${A}`, "]()", "](<>)"]) {
      const html = copyHtml(`[\n\nT\n\n${closer}`, refs());
      expect(hrefs(html)).toEqual([]);
      expect(text(html)).toContain(closer);
    }
  });

  it("does not let a closed link make the paragraph an opener", () => {
    const html = copyHtml(`[a](${B}) y\n\n](${A})`, refs());
    expect(hrefs(html)).toEqual([B]);
    expect(parse(html).querySelector("p")?.textContent).toBe("a y");
    expect(text(html)).toContain(`](${A})`);
  });

  it("reads an escaped closing bracket as part of an opener's text", () => {
    const html = copyHtml(`[\\]\n\ntext\n\n](${A})`, refs());
    expect(hrefs(html)).toEqual([A]);
    expect(parse(html).querySelector("p")?.textContent).toBe("]");
  });

  it("normalizes a repaired address", () => {
    const html = copyHtml("[\n\nT\n\n](https://e.example/é)", refs());
    expect(hrefs(html)).toEqual(["https://e.example/%C3%A9"]);
  });

  it("closes the most recent opener, leaving the earlier one open", () => {
    const html = copyHtml(`[\n\none\n\n[\n\ntwo\n\n](${A})`, refs());
    expect(hrefs(html)).toEqual([A]);
    expect(text(html).replace(/\s+/g, "")).toMatch(/^\[onetwo/);
  });

  it("pairs many openers with one paragraph of many closers in linear time", () => {
    const n = 40_000;
    const start = performance.now();
    const html = copyHtml(`${"[\n\n".repeat(n)}${`x](${A})`.repeat(n)}`, refs());
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(html.match(/<a /g)).toHaveLength(n);
  });

  it("does not take a closer inside a code span for one", () => {
    const html = copyHtml("[\n\nT\n\nsee `a](https://e.example/a)` ok", refs());
    expect(hrefs(html)).toEqual([]);
    expect(parse(html).querySelector("code")?.textContent).toBe("a](https://e.example/a)");
    const unmatched = copyHtml(`[\n\nT\n\nsee \`\`a\` ](${A})`, refs());
    expect(hrefs(unmatched)).toEqual([A]);
  });

  it.each(["](", '](a "', "](a '", "](a ("])(
    "renders 256 KiB of %s in one paragraph after an opener within the budget",
    (unit) => {
      const start = performance.now();
      copyHtml(`[\n\n${unit.repeat(Math.ceil((256 * 1024) / unit.length))}`, refs());
      expect(performance.now() - start).toBeLessThan(2_000);
    },
    10_000,
  );

  it.each([
    ["orphan closers", "](x)\n\n", 256],
    ["orphan openers", "[\n\n", 256],
    ["cards in quotes", "> [\n>\n> ](x)\n\n", 256],
    ["pairs", "[\n\n](https://e.example/a)\n\n", 1024],
  ])(
    "renders a long run of %s within the budget",
    (_name, unit, kib) => {
      const md = unit.repeat(Math.ceil((kib * 1024) / unit.length));
      const start = performance.now();
      copyHtml(md, refs());
      expect(performance.now() - start).toBeLessThan(2_000);
    },
    10_000,
  );
});
