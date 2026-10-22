import type TurndownService from "turndown";

// Turndown has no table rule, and its GFM plugins read `table.rows`, which linkedom lacks. A table
// becomes a Markdown grid only when it can be one without losing or misplacing anything; any other
// keeps Turndown's default (its text, block by block).

type Facts = { rows: Element[]; columns: number };

/** Not a heading, list, code block, quote, rule or definition list: a Markdown cell holds one line. */
const BLOCKS = "h1,h2,h3,h4,h5,h6,ul,ol,pre,blockquote,hr,dl,caption";

const cellsOf = (row: Element): Element[] =>
  [...row.children].filter((c) => c.nodeName === "TD" || c.nodeName === "TH");

const spanOf = (cell: Element, name: string): number =>
  Number.parseInt(cell.getAttribute(name) ?? "", 10);

/** The cell's `colspan` as HTML reads it: a whole number from 1, else 1. */
const colspan = (cell: Element): number => {
  const n = spanOf(cell, "colspan");
  return n >= 1 ? n : 1;
};

/** Only a `rowspan` of 1 keeps rows aligned; 0 spans the rest of its group. */
const rowspanOne = (cell: Element): boolean => {
  const n = spanOf(cell, "rowspan");
  return Number.isNaN(n) || n < 0 || n === 1;
};

const blank = (node: Node): boolean =>
  node.nodeType === 8 || (node.nodeType === 3 && !node.textContent?.trim());

const only = (parent: Element, take: (child: Element) => boolean): boolean =>
  [...parent.childNodes].every((n) => (n.nodeType === 1 ? take(n as Element) : blank(n)));

function rowsOf(table: Element): Element[] | null {
  const head: Element[] = [];
  const body: Element[] = [];
  const foot: Element[] = [];
  let captions = 0;
  const row = (into: Element[]) => (child: Element) => {
    if (child.nodeName !== "TR") return false;
    into.push(child);
    return only(child, (c) => c.nodeName === "TD" || c.nodeName === "TH");
  };
  const fits = only(table, (child) => {
    switch (child.nodeName) {
      case "CAPTION":
        return ++captions === 1;
      case "COLGROUP":
        return only(child, (c) => c.nodeName === "COL");
      case "COL":
        return true;
      case "THEAD":
        return only(child, row(head));
      case "TBODY":
        return only(child, row(body));
      case "TFOOT":
        return only(child, row(foot));
      default:
        return row(body)(child);
    }
  });
  return fits ? [...head, ...body, ...foot] : null;
}

/** Worked out from the attributes alone, before anything is built, so a huge `colspan` costs nothing. */
function factsOf(table: Element): Facts | null {
  if (table.querySelector("table")) return null;
  const rows = rowsOf(table);
  if (rows === null) return null;
  let cells = 0;
  let columns = 0;
  for (const row of rows) {
    let width = 0;
    for (const cell of cellsOf(row)) {
      cells++;
      if (!rowspanOne(cell) || cell.querySelector(BLOCKS)) return null;
      width += colspan(cell);
    }
    columns = Math.max(columns, width);
  }
  if (table.querySelectorAll("td,th").length !== cells) return null;
  if (rows.length < 2 || columns < 2 || rows.length * columns > 2 * cells) return null;
  return { rows, columns };
}

const known = new WeakMap<Element, Facts | null>();
function grid(table: Element): Facts | null {
  if (!known.has(table)) known.set(table, factsOf(table));
  return known.get(table) ?? null;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

// Turndown converts a node's children before the node's own rule runs, and its converter is private.
// So the rule for a grid table's cells and caption notes each one's line here, and the table's rule
// reads them back.
const lines = new WeakMap<Element, string>();
const isPart = (node: Node): boolean => {
  if (node.nodeName !== "TD" && node.nodeName !== "TH" && node.nodeName !== "CAPTION") return false;
  const table = (node as Element).closest("table");
  return table !== null && grid(table) !== null;
};

function rowLine(row: Element, columns: number): string {
  const out: string[] = [];
  for (const cell of cellsOf(row)) {
    out.push(lines.get(cell) ?? "");
    for (let k = colspan(cell); k > 1; k--) out.push("");
  }
  while (out.length < columns) out.push("");
  return `| ${out.join(" | ")} |`;
}

/** Adds the rules that write a table as a Markdown grid, with its caption as a paragraph before it. */
export function addTableRules(td: TurndownService): void {
  td.addRule("copyTableCell", {
    filter: isPart,
    replacement: (content, node) => {
      lines.set(node as Element, oneLine(content));
      return "";
    },
  });
  td.addRule("copyTable", {
    filter: (node) => node.nodeName === "TABLE" && grid(node as Element) !== null,
    replacement: (_content, node) => {
      const facts = grid(node as Element) as Facts;
      const out = facts.rows.map((row) => rowLine(row, facts.columns));
      out.splice(1, 0, `| ${Array(facts.columns).fill("---").join(" | ")} |`);
      const caption = lines.get((node as Element).querySelector("caption") as Element);
      return `\n\n${caption ? `${caption}\n\n` : ""}${out.join("\n")}\n\n`;
    },
  });
}
