import TurndownService from "turndown";
import { describe, expect, it } from "vitest";
import { finishedMarkdown } from "../core/saved-copy.js";
import { copyHtml } from "../web/copy-markdown.js";
import { parsePage } from "./extract.ts";
import { articleMarkdown, copyBase } from "./extract-copy.ts";
import { readArticle } from "./extract-text.ts";

const NONCE = "0123456789abcdef0123456789abcdef";
const FINAL = "https://ex.com/post/page";
const FILLER =
  "<p>Some long paragraph text here, with words, commas, and more words to read. </p>".repeat(5);

const article = (body: string): { el: Element; base: string } => {
  const doc = parsePage(
    `<html><head><title>T</title></head><body><article>${FILLER}${body}${FILLER}</article></body></html>`,
  );
  const el = readArticle(doc);
  if (!el) throw new Error("no article");
  return { el, base: copyBase(doc, FINAL) };
};
const markdown = (body: string): string => {
  const { el, base } = article(body);
  return articleMarkdown(el, base, NONCE).markdown;
};
// Turndown with none of the copy rules: what a table came out as before tables were kept.
const before = (body: string): string =>
  new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(
    article(body).el as HTMLElement,
  );
const refs = (n: number) => ({
  linkId: "7",
  nonce: NONCE,
  images: new Map([[n, { contentType: "image/png" as const, version: "v1" }]]),
});
const rows = (n: number, cells: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => `<tr>${cells(i)}</tr>`).join("");
const count = (html: string, tag: string): number => html.split(`<${tag}>`).length - 1;

describe("a table in a copy", () => {
  const TABLE =
    "<table><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>3</td></tr><tr><td>Bo</td><td>4</td></tr></table>";

  it("becomes a header, a delimiter and one line per row, and renders as a table", () => {
    const md = markdown(TABLE);
    expect(md).toContain("| Name | Age |\n| --- | --- |\n| Ann | 3 |\n| Bo | 4 |");
    const html = copyHtml(md, refs(1));
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<td>Bo</td>");
  });

  it("takes the first row as the header when no cell is a th", () => {
    const md = markdown(
      "<table><tr><td>K</td><td>V</td></tr><tr><td>a</td><td>b</td></tr></table>",
    );
    expect(md).toContain("| K | V |\n| --- | --- |\n| a | b |");
  });

  it("keeps columns lined up around a colspan and pads a short row", () => {
    const md = markdown(
      '<table><tr><th colspan="2">Both</th><th>C</th></tr><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>x</td></tr></table>',
    );
    expect(md).toContain("| Both |  | C |\n| --- | --- | --- |\n| a | b | c |\n| x |  |  |");
  });

  it("writes a pipe in a cell so it stays in the cell", () => {
    const md = markdown(
      "<table><tr><th>A</th><th>B</th></tr><tr><td>x | y</td><td><code>a|b</code></td></tr></table>",
    );
    expect(md).toContain("| x \\| y | `a\\|b` |");
    const html = copyHtml(md, refs(1));
    expect(count(html, "td")).toBe(2);
    expect(html).toContain("<td>x | y</td>");
  });

  it("keeps a link and a picture in a cell working", () => {
    const { el, base } = article(
      '<table><tr><th>A</th><th>B</th></tr><tr><td><a href="https://e.example/p">go</a></td><td><img src="https://ex.com/i.png" alt="pic"></td></tr></table>',
    );
    const d = articleMarkdown(el, base, NONCE);
    const html = copyHtml(finishedMarkdown(d.markdown, NONCE, [{ n: 1, ext: "png" }]), refs(1));
    expect(html).toContain('<a href="https://e.example/p"');
    expect(html).toContain('<img src="/links/7/copy/images/1"');
    expect(count(html, "td")).toBe(2);
  });

  it("joins a cell's paragraphs and line breaks into one line", () => {
    const md = markdown(
      "<table><tr><th>A</th><th>B</th></tr><tr><td><p>one</p><p>two</p></td><td>x<br>y</td></tr></table>",
    );
    expect(md).toContain("| one two | x y |");
  });

  it("puts a caption in a paragraph just before the table", () => {
    const md = markdown(`<table><caption>Ages</caption>${TABLE.slice("<table>".length)}`);
    expect(md).toContain("Ages\n\n| Name | Age |");
  });

  it("counts a bad colspan as 1", () => {
    for (const span of ["abc", "0", "-3"]) {
      const md = markdown(
        `<table><tr><th colspan="${span}">A</th><th>B</th></tr><tr><td>a</td><td>b</td></tr></table>`,
      );
      expect(md, span).toContain("| A | B |\n| --- | --- |\n| a | b |");
    }
  });

  it("keeps a pipe in a picture's alt text in its cell, saved or not", () => {
    const { el, base } = article(
      '<table><tr><th>A</th><th>B</th></tr><tr><td><img src="https://ex.com/i.png" alt="a|b"></td><td>z</td></tr></table>',
    );
    const d = articleMarkdown(el, base, NONCE);
    for (const ext of ["png", null] as const) {
      const md = finishedMarkdown(d.markdown, NONCE, [{ n: 1, ext }]);
      expect(count(copyHtml(md, refs(1)), "td"), String(ext)).toBe(2);
    }
  });

  it("keeps a pipe in the alt text of a picture past the 30th in its cell", () => {
    const pics = Array.from(
      { length: 31 },
      (_, i) => `<img src="https://ex.com/i${i}.png" alt="${i === 30 ? "a|b" : `p${i}`}">`,
    ).join("");
    const md = markdown(
      `<table><tr><th>A</th><th>B</th></tr><tr><td>${pics}</td><td>z</td></tr></table>`,
    );
    const html = copyHtml(md, refs(1));
    expect(count(html, "td")).toBe(2);
    expect(html).toContain("<td>z</td>");
  });

  it("puts a header written after its footer first, and the footer last", () => {
    const md = markdown(
      "<table><tfoot><tr><td>f1</td><td>f2</td></tr></tfoot><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
    expect(md).toContain("| h1 | h2 |\n| --- | --- |\n| 1 | 2 |\n| f1 | f2 |");
  });
});

describe("a table part outside any table", () => {
  it.each([
    ["a cell", "<td>x</td>"],
    ["a cell in a div", "<div><td>x</td></div>"],
    ["a caption", "<caption>c</caption>"],
    ["a row", "<tr><td>a</td><td>b</td></tr>"],
  ])("%s keeps its text, as before", (_name, body) => {
    expect(markdown(body)).toBe(before(body));
  });
});

describe("a table that stays as its text", () => {
  const head = "<tr><th>A</th><th>B</th></tr>";
  const cell = (inner: string) => `<table>${head}<tr><td>${inner}</td><td>z</td></tr></table>`;
  const cases: Record<string, string> = {
    "a nested table":
      "<table><tr><td><table><tr><td>in</td></tr><tr><td>x</td></tr></table></td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
    "one column": "<table><tr><th>A</th></tr><tr><td>a</td></tr></table>",
    "one row": `<table>${head}</table>`,
    "a rowspan of 2": `<table>${head}<tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>`,
    "a rowspan of 0": `<table>${head}<tr><td rowspan="0">a</td><td>b</td></tr><tr><td>c</td></tr></table>`,
    "a list in a cell": cell("<ul><li>one</li><li>two</li></ul>"),
    "a heading in a cell": cell("<h3>head</h3>"),
    "a pre in a cell": cell("<pre>code</pre>"),
    "a quote in a cell": cell("<blockquote>said</blockquote>"),
    "a row inside a cell": `<table>${head}<tr><td>a<tr><td>q</td><td>r</td></tr></td><td>d</td></tr></table>`,
    "a colspan of 1000 over 1,000 rows": `<table><tr><th colspan="1000">Wide</th></tr>${rows(1000, (i) => `<td>${i}</td><td>x</td>`)}</table>`,
  };
  it.each(Object.entries(cases))("%s", (_name, body) => {
    const md = markdown(body);
    expect(md).toBe(before(body));
    expect(md).not.toContain("| --- |");
  });

  it("still makes a grid of a table inside a layout table", () => {
    const md = markdown(
      "<table><tr><td><table><tr><th>A</th><th>B</th></tr><tr><td>a</td><td>b</td></tr></table></td><td>side</td></tr></table>",
    );
    expect(md).toContain("| A | B |\n| --- | --- |\n| a | b |");
  });
});
