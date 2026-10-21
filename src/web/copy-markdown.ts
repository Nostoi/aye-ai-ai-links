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

/** True when `src` has a `[` at `from` that nothing after it closes. */
function opensUnclosed(src: string, from: number): boolean {
  if (src[from] !== "[") return false;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return false;
  }
  return true;
}

type Part = { at: number; token: Token; head: Token[]; pos: number; paired: boolean };

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
      const part: Part = { at: i, token: t, head: [], pos: 0, paired: false };
      while (openers.length && src.startsWith("](", part.pos)) {
        const dest = state.md.helpers.parseLinkDestination(src, part.pos + 2, src.length);
        if (!dest.ok || dest.str === "" || src[dest.pos] !== ")") break;
        (openers.pop() as Part).paired = true;
        const open = new state.Token("link_open", "a", 1);
        open.attrs = [["href", state.md.normalizeLink(dest.str)]];
        const label = new state.Token("text", "", 0);
        label.content = linkLabel(dest.str);
        part.head.push(open, label, new state.Token("link_close", "a", -1));
        part.pos = dest.pos + 1;
      }
      if (opensUnclosed(src, part.pos)) openers.push(part);
      if (part.head.length || openers.at(-1) === part) parts.push(part);
    }
  }

  const dropped = new Set<number>();
  for (const part of parts) {
    if (!part.head.length && !part.paired) continue;
    const src = part.token.content.slice(part.pos + (part.paired ? 1 : 0));
    if (!part.head.length && src === "") {
      dropped
        .add(part.at - 1)
        .add(part.at)
        .add(part.at + 1);
      continue;
    }
    const rest: Token[] = [];
    state.md.inline.parse(src, state.md, state.env, rest);
    part.token.children = [...part.head, ...rest];
  }
  if (dropped.size) state.tokens = tokens.filter((_t, i) => !dropped.has(i));
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

const md = new MarkdownIt("commonmark", { html: false, linkify: false, typographer: false });
// Turndown never writes a reference definition, and 15.0.2's `reference` rule is quadratic.
md.disable("reference");
md.validateLink = () => true;
md.core.ruler.push("copy_safe", safeTokens);
md.core.ruler.before("copy_safe", "copy_repair", repairBlockLinks);

/** The copy's Markdown as safe HTML (R39): only http(s)/mailto links, only this copy's ledger-ok images. */
export function copyHtml(markdown: string, refs: CopyRefs): string {
  return md.render(markdown, refs);
}
