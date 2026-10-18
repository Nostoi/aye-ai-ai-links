import type { StateCore, Token } from "markdown-it";
import MarkdownIt from "markdown-it";
import { COPY_NONCE, type CopyImageInfo, IMAGE_EXT } from "../core/saved-copy.js";

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

/** The copy's Markdown as safe HTML (R39): only http(s)/mailto links, only this copy's ledger-ok images. */
export function copyHtml(markdown: string, refs: CopyRefs): string {
  return md.render(markdown, refs);
}
