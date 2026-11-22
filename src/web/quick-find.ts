import type { ShownPicture } from "../core/image-store.js";
import { lineSpace, linkSpace } from "../core/link-space.js";
import type { Link, Tag } from "../core/types.js";
import { isWebUrl } from "../core/url-key.js";
import { displayTitle } from "./display-title.js";
import { hostOf } from "./host.js";
import { whyText } from "./link-rows.js";
import { openLink } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { askAbout, searchHref, spaceClass, tile } from "./pages.js";

/** How many matches quick find shows; the rest are one "See all results" away. */
export const QUICK_ROWS = 5;

/** The id of the listbox and of its options, which the field's combobox attributes point at. */
export const FIND_LIST_ID = "find-list";
export const findOptionId = (index: number) => `find-opt-${index}`;

/** The words under a search that matched nothing; the same on the results page's "Not it?" (#360). */
const NOTHING = "Try different words: what it was about, or where you saw it.";

/**
 * One match as a row of the listbox. The row is the option and, for a web link, the link: it opens
 * in a new tab and carries `data-open`, so the dialog's `openedScript` records the opening. The
 * `<li>` holds the link's `data-id`, which the opening names. The first row is the highlighted one,
 * so Enter opens it. `space` is the space the grey line names, none inside that space's own search.
 */
function row(
  link: Link,
  index: number,
  picture: ShownPicture | undefined,
  space: ReturnType<typeof linkSpace>,
): string {
  const host = hostOf(link.url).replace(/^www\./, "");
  const parts = [
    space
      ? `<span class="line-space${spaceClass(space)}"><span class="dot" aria-hidden="true"></span>${escapeHtml(space.name)}</span>`
      : "",
    host ? `<span>${escapeHtml(host)}</span>` : "",
  ].filter(Boolean);
  const inner = `${tile(link, picture, "find-pic")}<span class="find-text"><span class="find-title">${escapeHtml(displayTitle(link))}</span>${link.why ? `<span class="find-why">${whyText(link.why)}</span>` : ""}${parts.length > 0 ? `<span class="card-line">${parts.join("")}</span>` : ""}</span>`;
  const option = ` role="option" id="${findOptionId(index)}" aria-selected="${index === 0}" tabindex="-1"`;
  const body = isWebUrl(link.url)
    ? openLink(link, inner, "find-row", option)
    : `<span class="find-row"${option}>${inner}</span>`;
  return `<li role="presentation" data-id="${escapeHtml(link.id)}">${body}</li>`;
}

/**
 * The answer to `/search/quick`, an HTML fragment for the quick-find dialog: the first
 * `QUICK_ROWS` of the links the results page would show for the same words, then "See all results"
 * to that page with the same words and space (no count: the page shows up to twenty, however many
 * match). Nothing matched is its own state: the try-different-words line, and Ask AI about the
 * words while the AI is set up. `receipt` is the search's, for the dialog to report and to send
 * with an opening. A blank query is the empty fragment.
 */
export function quickFind({
  query,
  space,
  links,
  images,
  catalog,
  receipt,
  ask,
}: {
  query: string;
  space?: Tag | undefined;
  links: Link[];
  images: Map<string, ShownPicture>;
  catalog: Tag[];
  receipt?: string | undefined;
  ask: boolean;
}): string {
  if (query.trim() === "") return "";
  const mark = receipt ? ` data-receipt="${escapeHtml(receipt)}"` : "";
  const shown = links.slice(0, QUICK_ROWS);
  if (shown.length === 0) {
    return `<div class="find-answer find-nothing"${mark}>
<p class="find-nothing-title">Nothing matched.</p>
<p class="find-nothing-hint">${NOTHING}</p>
${ask ? askAbout(query) : ""}</div>`;
  }
  const within = space ? { within: space.key } : {};
  const rows = shown.map((l, i) =>
    row(
      l,
      i,
      images.get(l.id),
      lineSpace(linkSpace(l, catalog, within), { ...within, own: space !== undefined }),
    ),
  );
  return `<div class="find-answer"${mark}>
<ol class="find-list" id="${FIND_LIST_ID}" role="listbox" aria-label="Best matches">
${rows.join("\n")}
</ol>
<div class="find-foot">
<a class="find-all" href="${escapeHtml(searchHref(query, space ? { tag: space.key } : {}))}">See all results</a>
<span class="find-keys"><kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>Enter</kbd> to open</span>
</div>
</div>`;
}
