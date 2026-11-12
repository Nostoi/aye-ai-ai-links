import type { Space } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { Link } from "../core/types.js";
import { copyHref } from "./copy-page.js";
import { hostOf } from "./host.js";
import { escapeHtml } from "./page.js";

/**
 * A card's grey line: its space (color dot and name), its site, when it was saved (`saved`, a
 * date already in words) or `reason` (which wins, in the same place), Saved copy, a link to its saved copy in the same tab, and `marker`
 * (Put away or Done, for a link done or put away), in that order. A missing part drops out, and
 * no part draws no line. The dots between parts are the theme's,
 * drawn only before a part that shows, so Remove saved copy (`removeCopyScript`, which hides
 * `[data-act=read-copy]`) takes the link's dot with it.
 */
export function cardLine(
  link: Link,
  {
    space,
    copy,
    saved,
    reason,
    marker,
    from,
  }: {
    space?: Space | null;
    copy?: CopyInfo | undefined;
    saved?: string;
    /** Why the card is shown, in lower case. It takes `saved`'s place and wins over it. */
    reason?: string;
    marker?: string | null | undefined;
    /** The address of the list page this line is on, so the saved copy's Back returns to it. */
    from?: string | undefined;
  } = {},
): string {
  const host = hostOf(link.url);
  // A card whose page passes `space: null` holds an empty hidden slot where its space goes, so a
  // Save that gives the link a space can show it (the edit dialog's `showCard`). It is no part: a
  // line with only the slot draws nothing. A page that passes no `space` (Home's cards) has none.
  const slot =
    space === undefined
      ? ""
      : `<span class="line-space"${space ? "" : " hidden"}><span class="dot" aria-hidden="true"></span><span data-space-name>${space ? escapeHtml(space.name) : ""}</span></span>`;
  // The line's text is lower case after a space or site, and starts with a capital without them.
  const sentence = (text: string) =>
    space || host ? text : text.charAt(0).toUpperCase() + text.slice(1);
  const parts = [
    host ? `<span>${escapeHtml(host)}</span>` : "",
    saved || reason ? `<span>${escapeHtml(sentence(reason ?? `saved ${saved}`))}</span>` : "",
    copy
      ? `<a class="saved-copy" href="${escapeHtml(copyHref(link.id, from))}" data-act="read-copy">Saved copy</a>`
      : "",
    marker ? `<span>${escapeHtml(marker)}</span>` : "",
  ].filter(Boolean);
  return parts.length === 0 && !space ? "" : `<p class="card-line">${slot}${parts.join("")}</p>\n`;
}
