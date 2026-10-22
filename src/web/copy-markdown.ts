import type { StateCore, Token } from "markdown-it";
import MarkdownIt from "markdown-it";
import { COPY_NONCE, type CopyImageInfo, IMAGE_EXT, linkLabel } from "../core/saved-copy.js";

/** What a copy's image references can resolve to. */
export type CopyRefs = { linkId: string; nonce: string | null; images: Map<number, CopyImageInfo> };

/** `/links/<id>/copy/images/<n>` */
export const copyImageSrc = (linkId: string, n: number): string =>
  `/links/${linkId}/copy/images/${n}`;

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const EXT_REF = /^images\/([0-9]{2})\.(png|jpg|gif|webp)$/;

const isSafeHref = (href: string): boolean => {
  try {
    return LINK_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
};

/** The number of the ledger-ok image `src` names in this copy, or null. */
function imageNumber(src: string, refs: CopyRefs): number | null {
  const byExt = EXT_REF.exec(src);
  if (byExt) {
    const n = Number(byExt[1]);
    const info = refs.images.get(n);
    return info && IMAGE_EXT[info.contentType] === byExt[2] ? n : null;
  }
  if (refs.nonce === null || !COPY_NONCE.test(refs.nonce)) return null;
  const byNonce = new RegExp(`^images/([0-9]{2})-${refs.nonce}$`).exec(src);
  if (!byNonce) return null;
  const n = Number(byNonce[1]);
  return refs.images.has(n) ? n : null;
}

// A copy saved before #220 holds a link around blocks as a paragraph ending in an unclosed `[`,
// then the blocks, then a paragraph starting `](address)`. Markdown can't link across blocks, so
// this pairs them again, on tokens: code and fences are never paragraphs, and `safeTokens` still
// judges every link made here.
const FRAME_OPEN = new Set(["blockquote_open", "list_item_open"]);
const FRAME_CLOSE = new Set(["blockquote_close", "list_item_close"]);

/** Where each inline code span in `src` starts, mapped to where it ends (CommonMark: a run closes at the next run of its own length). */
function codeSpans(src: string): Map<number, number> {
  const spans = new Map<number, number>();
  if (!src.includes("`")) return spans;
  const runs = [...src.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const byLen = new Map<number, number[]>();
  for (const { at, len } of runs) {
    const same = byLen.get(len) ?? [];
    same.push(at);
    byLen.set(len, same);
  }
  let cursor = 0;
  for (const { at, len } of runs) {
    if (at < cursor) continue;
    let slashes = 0;
    while (src[at - 1 - slashes] === "\\") slashes++;
    const open = slashes % 2 ? at + 1 : at;
    const size = len - (open - at);
    const same = byLen.get(size) ?? [];
    let lo = 0;
    let hi = same.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((same[mid] as number) > at) hi = mid;
      else lo = mid + 1;
    }
    const close = same[lo];
    if (size > 0 && close !== undefined) {
      spans.set(open, close + size);
      cursor = close + size;
    }
  }
  return spans;
}

/** True when `src` has a `[` at `from` that nothing after it closes. */
function opensUnclosed(src: string, from: number, spans: Map<number, number>): boolean {
  if (src[from] !== "[") return false;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    const span = spans.get(i);
    if (span !== undefined) i = span - 1;
    else if (c === "\\") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return false;
  }
  return true;
}

const skipSpace = (s: string, from: number): number => {
  let i = from;
  while (i < s.length && /\s/.test(s[i] as string)) i++;
  return i;
};

/** The address and end of a `](address)` or `](address "title")` at `at`, or null. The title is dropped. */
function closerAt(state: StateCore, src: string, at: number): { href: string; end: number } | null {
  const { parseLinkDestination, parseLinkTitle } = state.md.helpers;
  const dest = parseLinkDestination(src, at + 2, src.length);
  if (!dest.ok || dest.str === "") return null;
  let end = skipSpace(src, dest.pos);
  if (end > dest.pos) {
    const title = parseLinkTitle(src, end, src.length);
    if (title.ok) end = skipSpace(src, title.pos);
  }
  return src[end] === ")" ? { href: dest.str, end: end + 1 } : null;
}

/** A stretch of one paragraph: a closer's link, then text. The first reuses the paragraph's tokens. */
type Part = {
  at: number;
  src: string;
  pos: number;
  end: number;
  head: Token[];
  paired: boolean;
  first: boolean;
};

function repairBlockLinks(state: StateCore): void {
  const { tokens } = state;
  const frames: Part[][] = [[]];
  const parts: Part[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (FRAME_OPEN.has(t.type)) frames.push([]);
    else if (FRAME_CLOSE.has(t.type)) {
      if (frames.length > 1) frames.pop();
    } else if (t.type === "inline" && tokens[i - 1]?.type === "paragraph_open") {
      const openers = frames[frames.length - 1] as Part[];
      const src = t.content;
      const made: Part[] = [];
      const begin = (pos: number, first: boolean): Part => {
        const part: Part = { at: i, src, pos, end: src.length, head: [], paired: false, first };
        made.push(part);
        return part;
      };
      let cur = begin(0, true);
      let depth = 0;
      const spans = codeSpans(src);
      for (let k = 0; k < src.length; k++) {
        const c = src[k];
        const span = spans.get(k);
        if (span !== undefined) k = span - 1;
        else if (c === "\\") k++;
        else if (c === "[") depth++;
        else if (c === "]" && depth > 0) depth--;
        else if (c === "]" && src[k + 1] === "(" && openers.length) {
          const closer = closerAt(state, src, k);
          if (!closer) continue;
          if (k > cur.pos) {
            cur.end = k;
            cur = begin(k, false);
          }
          (openers.pop() as Part).paired = true;
          const open = new state.Token("link_open", "a", 1);
          open.attrs = [["href", state.md.normalizeLink(closer.href)]];
          const label = new state.Token("text", "", 0);
          label.content = linkLabel(closer.href);
          cur.head.push(open, label, new state.Token("link_close", "a", -1));
          cur.pos = closer.end;
          k = closer.end - 1;
        }
      }
      if (opensUnclosed(src, cur.pos, spans)) openers.push(cur);
      if (made.length > 1 || cur.head.length || openers.at(-1) === cur) {
        for (const part of made) parts.push(part);
      }
    }
  }

  const dropped = new Set<number>();
  const after = new Map<number, Token[]>();
  for (const part of parts) {
    const whole = part.first && part.end === part.src.length;
    if (whole && !part.head.length && !part.paired) continue;
    const text = part.src.slice(part.pos + (part.paired ? 1 : 0), part.end);
    if (part.first && !part.head.length && text === "") {
      dropped
        .add(part.at - 1)
        .add(part.at)
        .add(part.at + 1);
      continue;
    }
    const rest: Token[] = [];
    state.md.inline.parse(text, state.md, state.env, rest);
    if (part.first) {
      (tokens[part.at] as Token).children = [...part.head, ...rest];
      continue;
    }
    const opening = tokens[part.at - 1] as Token;
    const paragraph = (
      [
        ["paragraph_open", "p", 1],
        ["inline", "", 0],
        ["paragraph_close", "p", -1],
      ] as const
    ).map(([type, tag, nesting]) => {
      const token = new state.Token(type, tag, nesting);
      token.block = true;
      token.level = opening.level;
      token.hidden = opening.hidden;
      return token;
    }) as [Token, Token, Token];
    paragraph[1].content = text;
    paragraph[1].children = [...part.head, ...rest];
    const queue = after.get(part.at + 1) ?? [];
    queue.push(...paragraph);
    after.set(part.at + 1, queue);
  }
  if (dropped.size || after.size) {
    state.tokens = tokens.flatMap((tk, i) => (dropped.has(i) ? [] : [tk, ...(after.get(i) ?? [])]));
  }
}

// Every link and image decision is taken here, after parsing, so a refused one shows its label.
function safeTokens(state: StateCore): void {
  const refs = state.env as CopyRefs;
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const kept: Token[] = [];
    const linkKept: boolean[] = [];
    for (const t of block.children) {
      if (t.type === "link_open") {
        const ok = isSafeHref(String(t.attrGet("href") ?? ""));
        linkKept.push(ok);
        if (!ok) continue;
        t.attrSet("target", "_blank");
        t.attrSet("rel", "noopener noreferrer nofollow");
      } else if (t.type === "link_close") {
        if (!linkKept.pop()) continue;
      } else if (t.type === "image") {
        const n = imageNumber(String(t.attrGet("src") ?? ""), refs);
        if (n === null) {
          const alt = new state.Token("text", "", 0);
          alt.content = state.md.renderer.renderInlineAsText(
            t.children ?? [],
            state.md.options,
            state.env,
          );
          kept.push(alt);
          continue;
        }
        t.attrSet("src", copyImageSrc(refs.linkId, n));
        t.attrSet("loading", "lazy");
      }
      kept.push(t);
    }
    block.children = kept;
  }
}

// An aligned column would put a `style` attribute on its cells, and the page carries none.
function plainCells(state: StateCore): void {
  for (const t of state.tokens) {
    if (t.type === "th_open" || t.type === "td_open") t.attrs = null;
  }
}

const md = new MarkdownIt("commonmark", { html: false, linkify: false, typographer: false });
md.enable("table");
// A wide table scrolls sideways in its own box.
md.renderer.rules.table_open = (tokens, i, options, _env, self) =>
  `<div class="copy-table">${self.renderToken(tokens, i, options)}`;
md.renderer.rules.table_close = (tokens, i, options, _env, self) =>
  `${self.renderToken(tokens, i, options)}</div>\n`;
// Turndown never writes a reference definition, and 15.0.2's `reference` rule is quadratic.
md.disable("reference");
md.validateLink = () => true;
md.core.ruler.push("copy_safe", safeTokens);
md.core.ruler.push("copy_plain_cells", plainCells);
md.core.ruler.before("text_join", "copy_repair", repairBlockLinks);

/** The copy's Markdown as safe HTML (R39): only http(s)/mailto links, only this copy's ledger-ok images. */
export function copyHtml(markdown: string, refs: CopyRefs): string {
  return md.render(markdown, refs);
}
