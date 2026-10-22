import type { StateCore, Token } from "markdown-it";
import { linkLabel } from "../core/saved-copy.js";

// Core rules that give a saved copy its reading look. They run after `safeTokens`, so they see only
// links and pictures it has already judged, and they build blocks from fixed tags and classes.

/** Marks the text `safeTokens` leaves for a picture it refused. */
export const markUnsavedPicture = (token: Token): void => {
  token.meta = { unsavedPicture: true };
};

const isUnsaved = (t: Token): boolean => t.type === "text" && t.meta?.unsavedPicture === true;
const isPicture = (t: Token): boolean => t.type === "image" || isUnsaved(t);
const isGap = (t: Token): boolean =>
  t.type === "softbreak" ||
  t.type === "hardbreak" ||
  (t.type === "text" && !t.meta && t.content.trim() === "");

// The tags below are fixed; nothing from the page picks one.
function block(state: StateCore, type: string, tag: string, nesting: 1 | -1, cls?: string): Token {
  const token = new state.Token(type, tag, nesting);
  token.block = true;
  if (cls && nesting === 1) token.attrSet("class", cls);
  return token;
}

function inlineOf(state: StateCore, children: Token[]): Token {
  const token = new state.Token("inline", "", 0);
  token.block = true;
  token.children = children;
  return token;
}

function textOf(state: StateCore, content: string): Token {
  const token = new state.Token("text", "", 0);
  token.content = content;
  return token;
}

/** `↗` and its spoken form, which every link that opens a new tab ends with. */
function newTabMark(state: StateCore): Token[] {
  const arrow = new state.Token("span_open", "span", 1);
  arrow.attrSet("aria-hidden", "true");
  const spoken = new state.Token("span_open", "span", 1);
  spoken.attrSet("class", "visually-hidden");
  return [
    arrow,
    textOf(state, "↗"),
    new state.Token("span_close", "span", -1),
    spoken,
    textOf(state, " (opens in a new tab)"),
    new state.Token("span_close", "span", -1),
  ];
}

/** The pictures of an inline run that holds nothing else, each with the kept link around it, or null. */
function pictureUnits(children: Token[]): { pic: Token; link: Token | null }[] | null {
  const units: { pic: Token; link: Token | null }[] = [];
  for (let i = 0; i < children.length; i++) {
    const t = children[i] as Token;
    if (isPicture(t)) units.push({ pic: t, link: null });
    else if (
      t.type === "link_open" &&
      isPicture(children[i + 1] as Token) &&
      children[i + 2]?.type === "link_close"
    ) {
      units.push({ pic: children[i + 1] as Token, link: t });
      i += 2;
    } else if (!isGap(t)) return null;
  }
  return units.length ? units : null;
}

function pictureBlocks(state: StateCore, units: { pic: Token; link: Token | null }[]): Token[] {
  const out: Token[] = [];
  for (const { pic, link } of units) {
    if (pic.type === "image") {
      out.push(block(state, "div_open", "div", 1, "copy-band"), inlineOf(state, [pic]));
      out.push(block(state, "div_close", "div", -1));
    } else if (pic.content) {
      out.push(
        block(state, "div_open", "div", 1, "copy-band copy-band-note"),
        block(state, "paragraph_open", "p", 1, "copy-pic-note"),
        inlineOf(state, [textOf(state, `Picture not saved: ${pic.content}`)]),
        block(state, "paragraph_close", "p", -1),
        block(state, "div_close", "div", -1),
      );
    }
    if (link) {
      const href = String(link.attrGet("href") ?? "");
      const open = new state.Token("link_open", "a", 1);
      open.attrs = [...(link.attrs ?? [])];
      out.push(
        block(state, "paragraph_open", "p", 1, "copy-pic-link"),
        inlineOf(state, [
          open,
          textOf(state, `Picture links to ${linkLabel(href)} `),
          ...newTabMark(state),
          new state.Token("link_close", "a", -1),
        ]),
        block(state, "paragraph_close", "p", -1),
      );
    }
  }
  return out;
}

/** A picture standing alone in a paragraph becomes a band; a lost one a note; a link around one a line below it. */
export function bandPictures(state: StateCore): void {
  const out: Token[] = [];
  const { tokens } = state;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i] as Token;
    const inline = tokens[i + 1];
    if (open.type === "paragraph_open" && inline?.type === "inline" && inline.children) {
      const units = pictureUnits(inline.children);
      if (units) {
        for (const block of pictureBlocks(state, units)) out.push(block);
        i += 2;
        continue;
      }
    }
    out.push(open);
  }
  state.tokens = out;
}

/** A paragraph that is only one kept link, and plain text inside it, becomes the grey link line. */
export function lineLinks(state: StateCore): void {
  const { tokens } = state;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const open = tokens[i] as Token;
    const inline = tokens[i + 1] as Token;
    if (open.type !== "paragraph_open" || open.hidden || inline.type !== "inline") continue;
    const kids = inline.children ?? [];
    const last = kids.length - 1;
    if (
      kids.length < 3 ||
      kids[0]?.type !== "link_open" ||
      kids[last]?.type !== "link_close" ||
      !kids.slice(1, last).every((t) => t.type === "text")
    ) {
      continue;
    }
    open.attrSet("class", "copy-link-line");
    kids.splice(last, 0, ...newTabMark(state));
  }
}

/** A heading in a copy sits one level down, so the page's title is the only h1. */
export function shiftHeadings(state: StateCore): void {
  for (const t of state.tokens) {
    if (t.type === "heading_open" || t.type === "heading_close") {
      t.tag = `h${Math.min(Number(t.tag.slice(1)) + 1, 6)}`;
    }
  }
}
