import { Readability } from "@mozilla/readability";
import { capCodePoints } from "./cap.js";

const TEXT_MAX = 100_000;
const MAX_DEPTH = 200;
const MAX_ELEMENTS = 30_000;

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
]);
const SKIPPED = new Set(["SCRIPT", "STYLE"]);

/** One linear pass, no recursion: false when the tree is too deep or too large to hand to Readability. */
export function isParsable(root: Node): boolean {
  let elements = 0;
  const stack: { node: Node; depth: number }[] = [{ node: root, depth: 0 }];
  for (let item = stack.pop(); item; item = stack.pop()) {
    for (const child of item.node.childNodes) {
      if (child.nodeType !== ELEMENT) continue;
      elements += 1;
      if (elements > MAX_ELEMENTS || item.depth + 1 > MAX_DEPTH) return false;
      stack.push({ node: child, depth: item.depth + 1 });
    }
  }
  return true;
}

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
      t.replaceWith(...t.childNodes);
    }
  }
  for (const t of [...doc.querySelectorAll("template")]) t.remove();
}

function flatten(root: Node): string {
  let out = "";
  const visit = (node: Node) => {
    if (node.nodeType === TEXT) {
      out += (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== ELEMENT) return;
    const tag = (node as Element).tagName;
    if (SKIPPED.has(tag)) return;
    if (tag === "BR") {
      out += "\n";
      return;
    }
    const block = BLOCKS.has(tag);
    if (block) out += "\n";
    for (const child of node.childNodes) visit(child);
    if (block) out += "\n";
  };
  visit(root);
  return out
    .replace(/ {2,}/g, " ")
    .replace(/ ?\n\s*/g, "\n")
    .trim();
}

/** Readability's article text, or null when it finds no article. Callers run isParsable first. */
export function articleText(doc: Document): string | null {
  const article = new Readability(doc, {
    serializer: (el) => el as unknown as string,
  }).parse();
  if (!article) return null;
  const text = flatten(article.content as unknown as Node);
  return text ? capCodePoints(text, TEXT_MAX) : null;
}
