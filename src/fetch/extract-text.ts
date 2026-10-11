import { Readability } from "@mozilla/readability";
import { capCodePoints } from "./cap.js";

const TEXT_MAX = 100_000;

const ELEMENT = 1;
const TEXT = 3;
const BLOCKS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "TR",
  "TD",
  "TH",
  "BLOCKQUOTE",
  "PRE",
  "SECTION",
  "ARTICLE",
  "DT",
  "DD",
  "DL",
  "UL",
  "OL",
  "SUMMARY",
  "DETAILS",
  "HR",
  "HEADER",
  "FOOTER",
  "MAIN",
  "NAV",
  "ASIDE",
  "ADDRESS",
  "FIGURE",
  "FIGCAPTION",
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "CAPTION",
  "FORM",
  "FIELDSET",
  "LEGEND",
]);
const SKIPPED = new Set(["SCRIPT", "STYLE"]);

/**
 * A declarative shadow root keeps its content minus style and script; every other template goes.
 * Selectors cannot see inside a template until it is unwrapped, so peel level by level.
 */
export function flattenTemplates(doc: Document): void {
  for (;;) {
    const shadows = [...doc.querySelectorAll("template[shadowrootmode]")];
    if (shadows.length === 0) break;
    for (const t of shadows) {
      for (const bad of [...t.querySelectorAll("style, script")]) bad.remove();
      while (t.firstChild) t.before(t.firstChild);
      t.remove();
    }
  }
  for (const t of [...doc.querySelectorAll("template")]) t.remove();
}

export function flatten(root: Node): string {
  let out = "";
  const stack: (Node | null)[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node === null) {
      out += "\n";
      continue;
    }
    if (node.nodeType === TEXT) {
      out += (node.textContent ?? "").replace(/\s+/g, " ");
      continue;
    }
    if (node.nodeType !== ELEMENT) continue;
    const tag = (node as Element).tagName;
    if (SKIPPED.has(tag)) continue;
    if (tag === "BR") {
      out += "\n";
      continue;
    }
    if (BLOCKS.has(tag)) {
      out += "\n";
      stack.push(null);
    }
    const children = node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Node);
  }
  return out
    .replace(/ {2,}/g, " ")
    .replace(/ ?\n\s*/g, "\n")
    .trim();
}

/** Readability's article text, or null when it finds no article. */
export function articleText(doc: Document): string | null {
  const article = new Readability(doc, {
    serializer: (el) => el as unknown as string,
  }).parse();
  if (!article) return null;
  const text = flatten(article.content as unknown as Node);
  return text ? capCodePoints(text, TEXT_MAX) : null;
}
