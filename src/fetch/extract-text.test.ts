import Database from "better-sqlite3";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { flatten } from "./extract-text.js";

function textOf(bodyHtml: string): string {
  const { document } = parseHTML(`<html><body>${bodyHtml}</body></html>`);
  return flatten(document.body as unknown as Node);
}

function ftsFinds(text: string, query: string): boolean {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(body, tokenize='porter unicode61 remove_diacritics 2')",
    );
    db.prepare("INSERT INTO t(body) VALUES (?)").run(text);
    const row = db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH ?").get(query) as {
      n: number;
    };
    return row.n > 0;
  } finally {
    db.close();
  }
}

const SIBLINGS: [string, string][] = [
  ["p", "<p>Quokka</p><p>Battery</p>"],
  ["div", "<div>Quokka</div><div>Battery</div>"],
  ["h1", "<h1>Quokka</h1><h1>Battery</h1>"],
  ["h2", "<h2>Quokka</h2><h2>Battery</h2>"],
  ["h3", "<h3>Quokka</h3><h3>Battery</h3>"],
  ["h4", "<h4>Quokka</h4><h4>Battery</h4>"],
  ["h5", "<h5>Quokka</h5><h5>Battery</h5>"],
  ["h6", "<h6>Quokka</h6><h6>Battery</h6>"],
  ["li", "<ul><li>Quokka</li><li>Battery</li></ul>"],
  ["td", "<table><tbody><tr><td>Quokka</td><td>Battery</td></tr></tbody></table>"],
  ["tr", "<table><tr>Quokka</tr><tr>Battery</tr></table>"],
  ["thead", "<table><thead>Quokka</thead><thead>Battery</thead></table>"],
  ["tbody", "<table><tbody>Quokka</tbody><tbody>Battery</tbody></table>"],
  ["tfoot", "<table><tfoot>Quokka</tfoot><tfoot>Battery</tfoot></table>"],
  ["th", "<table><tbody><tr><th>Quokka</th><th>Battery</th></tr></tbody></table>"],
  ["blockquote", "<blockquote>Quokka</blockquote><blockquote>Battery</blockquote>"],
  ["pre", "<pre>Quokka</pre><pre>Battery</pre>"],
  ["section", "<section>Quokka</section><section>Battery</section>"],
  ["article", "<article>Quokka</article><article>Battery</article>"],
  ["dt", "<dl><dt>Quokka</dt><dt>Battery</dt></dl>"],
  ["dd", "<dl><dd>Quokka</dd><dd>Battery</dd></dl>"],
  ["summary", "<details><summary>Quokka</summary><summary>Battery</summary></details>"],
  ["header", "<header>Quokka</header><header>Battery</header>"],
  ["footer", "<footer>Quokka</footer><footer>Battery</footer>"],
  ["main", "<main>Quokka</main><main>Battery</main>"],
  ["nav", "<nav>Quokka</nav><nav>Battery</nav>"],
  ["aside", "<aside>Quokka</aside><aside>Battery</aside>"],
  ["address", "<address>Quokka</address><address>Battery</address>"],
  ["figure", "<figure>Quokka</figure><figure>Battery</figure>"],
  [
    "figcaption",
    "<figure><figcaption>Quokka</figcaption><figcaption>Battery</figcaption></figure>",
  ],
  ["form", "<form>Quokka</form><form>Battery</form>"],
  ["fieldset", "<fieldset>Quokka</fieldset><fieldset>Battery</fieldset>"],
  ["legend", "<fieldset><legend>Quokka</legend><legend>Battery</legend></fieldset>"],
  ["caption", "<table><caption>Quokka</caption><caption>Battery</caption></table>"],
  ["details", "<details>Quokka</details><details>Battery</details>"],
];

const SURROUNDED = [
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "section",
  "article",
  "dl",
  "ul",
  "ol",
  "details",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "address",
  "figure",
  "table",
  "form",
  "fieldset",
];

describe("block boundaries", () => {
  it.each(SIBLINGS)("splits sibling <%s> elements into separate words", (_tag, html) => {
    const text = textOf(html);
    expect(text).not.toContain("QuokkaBattery");
    expect(ftsFinds(text, '"quokka battery"')).toBe(true);
  });

  it.each(SURROUNDED)("splits text from either side of a <%s>", (tag) => {
    const text = textOf(`Quokka<${tag}>Middle</${tag}>Battery`);
    expect(text).not.toMatch(/QuokkaMiddle|MiddleBattery/);
    expect(ftsFinds(text, '"quokka middle battery"')).toBe(true);
  });

  it("splits at <hr> and <br>", () => {
    expect(textOf("Quokka<hr>Battery")).not.toContain("QuokkaBattery");
    expect(textOf("Quokka<br>Battery")).not.toContain("QuokkaBattery");
  });

  it("splits table rows", () => {
    const text = textOf("<table><tr><td>Quokka</td></tr><tr><td>Battery</td></tr></table>Tail");
    expect(ftsFinds(text, '"quokka battery tail"')).toBe(true);
  });

  it("does not split inline elements", () => {
    expect(textOf("Quo<b>kka</b><span>Bat</span><a>tery</a>")).toBe("QuokkaBattery");
  });
});
