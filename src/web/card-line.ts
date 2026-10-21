import type { Space } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { Link } from "../core/types.js";
import { copyHref } from "./copy-page.js";
import { hostOf } from "./host.js";
import { escapeHtml } from "./page.js";

/**
 * A card's grey line: its space (color dot and name), its site, when it was saved (`saved`, a
 * date already in words), and Saved copy, a link to its saved copy in the same tab, in that order.
 * A missing part drops out, and no part draws no line. The dots between parts are the theme's,
 * drawn only before a part that shows, so Remove saved copy (`removeCopyScript`, which hides
 * `[data-act=read-copy]`) takes the link's dot with it.
 */
export function cardLine(
  link: Link,
  {
    space = null,
    copy,
    saved,
  }: { space?: Space | null; copy?: CopyInfo | undefined; saved?: string } = {},
): string {
  const host = hostOf(link.url);
  const parts = [
    space
      ? `<span class="line-space"><span class="dot" aria-hidden="true"></span>${escapeHtml(space.name)}</span>`
      : "",
    host ? `<span>${escapeHtml(host)}</span>` : "",
    saved ? `<span>${space || host ? "saved" : "Saved"} ${escapeHtml(saved)}</span>` : "",
    copy
      ? `<a class="saved-copy" href="${copyHref(link.id)}" data-act="read-copy">Saved copy</a>`
      : "",
  ].filter(Boolean);
  return parts.length === 0 ? "" : `<p class="card-line">${parts.join("")}</p>\n`;
}
