import { randomBytes } from "node:crypto";
import TurndownService from "turndown";
import type { CopyDraft } from "../core/saved-copy.ts";
import { imageRef, linkLabel, MAX_COPY_IMAGES } from "../core/saved-copy.ts";
import { addTableRules } from "./copy-tables.ts";

const webUrl = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";

function resolve(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

/** The page's first `<base href>` when it resolves to http(s), else the final URL. */
export function copyBase(doc: Document, finalUrl: string): string {
  try {
    const href = doc.querySelector("base[href]")?.getAttribute("href");
    const url = href ? resolve(href, finalUrl) : null;
    return url && webUrl(url) ? url.href : finalUrl;
  } catch {
    return finalUrl; // never throws: the child posts the metadata after this call
  }
}

/** null: no article; undefined: making the copy threw (not received, the save goes on without one). */
export function makeCopy(article: Element | null, base: string): CopyDraft | null | undefined {
  if (!article) return null;
  try {
    return articleMarkdown(article, base, randomBytes(16).toString("hex"));
  } catch {
    return undefined;
  }
}

type LinkRule = { replacement: (content: string, node: Node, options: unknown) => string };

// @types/turndown doesn't declare `options.rules`; the built-in inline link rule lives there.
function inlineLinkRule(td: TurndownService): LinkRule {
  const rules = (td.options as { rules?: { inlineLink?: LinkRule } }).rules;
  if (!rules?.inlineLink) throw new Error("turndown has no inlineLink rule");
  return rules.inlineLink;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();
const escapeAlt = (alt: string): string => collapse(alt).replace(/[\\[\]]/g, "\\$&");
/** A picture the copy has no file for: the reader shows its alt text as a "Picture not saved" note. */
const lostPicture = (alt: string): string => `![${alt}]()`;

/**
 * Turns Readability's article element into Markdown, working on the element in place.
 * Images carry provisional ids while turndown runs, because a parent rule (fenced code) can drop
 * a child's output; the final numbers go to what survived.
 */
export function articleMarkdown(article: Element, base: string, nonce: string): CopyDraft {
  for (const a of [...article.querySelectorAll("a[href]")]) {
    const url = resolve(a.getAttribute("href") ?? "", base);
    if (url && (webUrl(url) || url.protocol === "mailto:")) a.setAttribute("href", url.href);
    else a.replaceWith(...a.childNodes);
  }

  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const found: { url: string; text: string }[] = [];
  const provisional = new Map<string, number>();
  const inlineLink = inlineLinkRule(td);
  // A link can't hold blocks: show them unlinked, then the link on a line of its own.
  td.addRule("copyLink", {
    filter: (node) => node.nodeName === "A" && !!node.getAttribute("href"),
    replacement: (content, node, options) => {
      if (!content.includes("\n\n")) return inlineLink.replacement(content, node, options);
      const bare = node.cloneNode(false) as Element;
      bare.removeAttribute("title");
      const label = td.escape(linkLabel(bare.getAttribute("href") ?? ""));
      return `${content.trimEnd()}\n\n${inlineLink.replacement(label, bare, options)}\n\n`;
    },
  });
  td.addRule("copyImage", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = (node as Element).getAttribute("alt") ?? "";
      if ((node as Element).parentElement?.closest("code")) return collapse(alt);
      const src = (node as Element).getAttribute("src");
      const url = src ? resolve(src, base) : null;
      const text = td.escape(collapse(alt));
      if (!url || !webUrl(url)) return lostPicture(text);
      let k = provisional.get(url.href);
      if (k === undefined) {
        k = found.length;
        found.push({ url: url.href, text });
        provisional.set(url.href, k);
      }
      return `![${escapeAlt(alt)}](images/x${k}-${nonce})`;
    },
  });
  addTableRules(td);
  const draft = td.turndown(article as HTMLElement);

  const imageUrls: string[] = [];
  const given = new Map<number, number>();
  const ref = new RegExp(`!\\[((?:\\\\.|[^\\[\\]\\\\])*)\\]\\(images/x([0-9]+)-${nonce}\\)`, "g");
  const markdown = draft.replace(ref, (_all, alt: string, k: string) => {
    const image = found[Number(k)];
    if (!image) return alt;
    let n = given.get(Number(k));
    if (n === undefined) {
      // `\|` shows as `|`, and keeps a picture that lands in a table cell inside it.
      if (imageUrls.length >= MAX_COPY_IMAGES) return lostPicture(image.text.replace(/\|/g, "\\|"));
      imageUrls.push(image.url);
      n = imageUrls.length;
      given.set(Number(k), n);
    }
    return `![${alt}](${imageRef(n, nonce)})`;
  });
  return { markdown, imageUrls, nonce };
}
