import { linkSpace } from "../core/link-space.js";
import type { ShelfItem, ToolItem } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { linkTitle } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { siteLine, spaceClass } from "./pages.js";

/** Tiles the shelf shows before Show all (#125). */
export const SHELF_SIZE = 8;
/** Suggestion tiles shown at most, newest first, after the kept tools (owner ruling 2026-10-16). */
export const SUGGESTION_SIZE = 2;

/** The shelf's kept tools in shelf order, its suggestions, and the owner's tags for each tile's space. */
export type Shelf = { items: ShelfItem[]; suggestions: ToolItem[]; catalog: Tag[] };

/** Add: search results each carry Keep handy, so picking one there keeps it. */
const ADD = `<a class="button" href="/search?q=">Add</a>`;

const STILL_USING = `<div class="ask">
<p class="small">Still using?</p>
<div class="actions small-actions">
<button type="button" data-act="still-using">Yes</button>
<button type="button" data-act="done">Done</button>
</div>
</div>`;

const menu = (link: Link) => `<details class="tile-menu">
<summary><span aria-hidden="true">⋯</span><span class="visually-hidden">More for ${escapeHtml(link.title ?? link.url)}</span></summary>
<div class="actions small-actions"><button type="button" data-act="not-handy">Not handy anymore</button></div>
</details>`;

/** The title, opening the link and recorded by `openedScript`, then its space and site. */
function head(link: Link, catalog: Tag[]): { space: string; html: string } {
  const space = linkSpace(link, catalog);
  return {
    space: spaceClass(space),
    html: `<h3>${linkTitle(link)}</h3>\n${siteLine(link, space)}`,
  };
}

/** A kept tool. Past the first SHELF_SIZE it is hidden until Show all. A due one needs you. */
function tile({ link, due }: ShelfItem, catalog: Tag[], more: boolean): string {
  const { space, html } = head(link, catalog);
  return `<article class="handy-tile${due ? " needs-you" : ""}${space}" data-id="${escapeHtml(link.id)}"${more ? " data-more hidden" : ""}>
${html}${due ? `${STILL_USING}\n` : ""}${menu(link)}
</article>`;
}

/** An agent's guess: a faded tile asking the owner, at the end of the row. */
function suggestion({ link }: ToolItem, catalog: Tag[]): string {
  const { space, html } = head(link, catalog);
  return `<article class="handy-tile guess${space}" data-id="${escapeHtml(link.id)}">
${html}<p class="small">Keep handy?</p>
<div class="actions small-actions">
<button type="button" data-act="suggest-yes">Yes</button>
<button type="button" data-act="suggest-no">No</button>
</div>
</article>`;
}

/**
 * The Handy shelf on home: kept tools in core's order (due first), the first SHELF_SIZE shown and
 * Show all for the rest, then up to SUGGESTION_SIZE suggestions; Add; or one line when it holds
 * nothing. The script swaps `#handy-shelf`'s contents for a fresh copy after each action.
 */
export function handyShelf({ items, suggestions, catalog }: Shelf): string {
  const empty = items.length === 0 && suggestions.length === 0;
  const body = empty
    ? `<div class="actions handy-empty"><p class="small">Keep links you use often here</p>${ADD}</div>`
    : `<div class="handy-row">
${[
  ...items.map((item, i) => tile(item, catalog, i >= SHELF_SIZE)),
  ...suggestions.slice(0, SUGGESTION_SIZE).map((s) => suggestion(s, catalog)),
].join("\n")}
</div>
<div class="actions handy-foot">${items.length > SHELF_SIZE ? '<button type="button" data-act="show-all">Show all</button>' : ""}${ADD}</div>`;
  return `<section class="handy" id="handy" aria-labelledby="handy-title">
<h2 id="handy-title" tabindex="-1">Handy</h2>
<p id="handy-error" role="alert"></p>
<div id="handy-shelf">
${body}
</div>
</section>`;
}
