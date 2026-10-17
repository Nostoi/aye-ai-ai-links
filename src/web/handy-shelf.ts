import { linkSpace, type Space } from "../core/link-space.js";
import type { ShelfItem, ToolItem } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { cardMenu, type MenuItem } from "./card-menu.js";
import { initialsText } from "./initials.js";
import { linkTitle } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { hostOf, spaceClass, tile } from "./pages.js";

/** Tiles the shelf shows before Show all (#125). */
export const SHELF_SIZE = 8;

/** The shelf's kept tools in shelf order, its suggestions, the owner's tags for each tile's space, and image versions by link id. */
export type Shelf = {
  items: ShelfItem[];
  suggestions: ToolItem[];
  catalog: Tag[];
  images: Map<string, string>;
};

const PLUS = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;

/** Add: search results each carry Keep handy, so picking one there keeps it. */
const ADD = `<a class="handy-add" href="/search?q=&keep=1">${PLUS}Add</a>`;

const STILL_USING = `<div class="ask">
<p class="small">Still using?</p>
<div class="actions small-actions">
<button type="button" data-act="still-using">Yes</button>
<button type="button" data-act="done">Done</button>
</div>
</div>`;

const KEEP_HANDY = `<div class="ask">
<p class="small">Keep handy?</p>
<div class="actions small-actions">
<button type="button" data-act="suggest-yes">Yes</button>
<button type="button" data-act="suggest-no">No</button>
</div>
</div>`;

const MINUS = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M5.25 8h5.5"/></svg>`;

/** The Handy tile's one menu row. */
export const NOT_HANDY: MenuItem = { act: "not-handy", icon: MINUS, text: "Not handy anymore" };

const menu = (link: Link) => cardMenu(`More for ${link.title ?? link.url}`, [NOT_HANDY]);

/** What a tile with no picture shows over its space color: the title's initials, else the host's. */
function initials(link: Link): string {
  const text = initialsText(link);
  return text ? `<span class="handy-initials" aria-hidden="true">${escapeHtml(text)}</span>\n` : "";
}

/** The space's dot and the site's host, without the space's name (All links uses `siteLine`). */
function hostLine(link: Link, space: Space | null): string {
  const host = hostOf(link.url);
  if (!host) return "";
  const dot = space ? `<span class="dot" aria-hidden="true"></span>` : "";
  return `<p class="card-site">${dot}<span class="host">${escapeHtml(host)}</span></p>\n`;
}

/**
 * A postcard: the stored image (or the space color with initials) fills the card, and the title,
 * opening the link and recorded by `openedScript`, sits over a fade with the host under it. `after`
 * holds the tile's panel and menu.
 */
function card(
  { link }: ToolItem,
  { catalog, images }: Shelf,
  classes: string,
  after: string,
  attrs = "",
): string {
  const space = linkSpace(link, catalog);
  const version = images.get(link.id);
  return `<article class="handy-tile${version === undefined ? "" : " photo"}${classes}${spaceClass(space)}" data-id="${escapeHtml(link.id)}"${attrs}>
${tile(link, version, "handy-image")}
${version === undefined ? initials(link) : ""}<div class="handy-caption">
<h3>${linkTitle(link)}</h3>
${hostLine(link, space)}</div>
${after}
</article>`;
}

/** A kept tool. Past the first SHELF_SIZE it is hidden until Show all. A due one needs you. */
const keptTile = (item: ShelfItem, shelf: Shelf, more: boolean) =>
  card(
    item,
    shelf,
    item.due ? " needs-you" : "",
    `${item.due ? `${STILL_USING}\n` : ""}${menu(item.link)}`,
    more ? " data-more hidden" : "",
  );

/** An agent's guess: a faded tile asking the owner, at the end of the row. */
const suggestion = (item: ToolItem, shelf: Shelf) => card(item, shelf, " guess", KEEP_HANDY);

/**
 * The Handy shelf on home: kept tools in core's order (due first), the first SHELF_SIZE shown and
 * Show all for the rest, then up to SUGGESTION_SIZE suggestions; or one line when it holds nothing.
 * The script swaps `#handy-shelf`'s contents for a fresh copy after each action, so Show all and Add
 * sit inside it, in `.handy-head`, which the theme places beside the heading.
 */
export function handyShelf(shelf: Shelf): string {
  const { items, suggestions } = shelf;
  const empty = items.length === 0 && suggestions.length === 0;
  const showAll =
    items.length > SHELF_SIZE
      ? `<button type="button" class="handy-show-all" data-act="show-all">Show all ${items.length}</button>`
      : "";
  const body = empty
    ? `<div class="actions handy-empty"><p class="small">Keep links you use often here</p>${ADD}</div>`
    : `<div class="handy-head">${showAll}${ADD}</div>
<div class="handy-row">
${[
  ...items.map((item, i) => keptTile(item, shelf, i >= SHELF_SIZE)),
  ...suggestions.map((s) => suggestion(s, shelf)),
].join("\n")}
</div>`;
  return `<section class="handy" id="handy" aria-labelledby="handy-title">
<h2 id="handy-title" tabindex="-1">Handy</h2>
<p id="handy-error" role="alert"></p>
<div id="handy-shelf">
${body}
</div>
</section>`;
}

/** What the owner is told when the shelf could not be read again after an action that worked. */
export const SHELF_STALE = "Your Handy shelf may be out of date. Reload the page.";

/**
 * The shelf's script, for home's one script after `CARD_FETCH` (it needs `post`, `failure` and
 * `showUndo`).
 * - `refreshShelf(from)` reads home again and swaps in its `#handy-shelf`, so the server decides the
 *   order, the cut and the due marker after every action. Tiles that were shown stay shown.
 * - A page that is not home (a sign-in redirect) is not swapped in, and the owner is told to reload.
 * - An answer that arrives after a newer refresh began is dropped (`shelfTurn`).
 * - `from` (the clicked button's tile, its act and the next tile, read at the click) puts focus back:
 *   on the same button, else the same tile's first control, else the next tile's, else the heading. * - Each button posts its route; a removal offers Undo, which sends back what the action answered.
 */
export const SHELF_SCRIPT = `const showAll = (shelf) => {
  for (const tile of shelf.querySelectorAll("[data-more]")) tile.hidden = false;
  const button = shelf.querySelector("button[data-act=show-all]");
  if (button) button.remove();
};
const focusAfter = (shelf, from) => {
  const tile = (id) => (id ? shelf.querySelector('[data-id="' + id + '"]') : null);
  const same = tile(from.id);
  const next = tile(from.next);
  const target =
    (same && (same.querySelector('button[data-act="' + from.act + '"]') || same.querySelector("a, button, summary"))) ||
    (next && next.querySelector("a, button, summary")) ||
    document.getElementById("handy-title");
  if (target.closest("[hidden]")) showAll(shelf);
  target.focus();
};
let shelfTurn = 0;
const refreshShelf = async (from) => {
  const shelf = document.getElementById("handy-shelf");
  if (!shelf) return;
  const turn = ++shelfTurn;
  const res = await fetch("/", { headers: { accept: "text/html" }, redirect: "manual" }).catch(() => null);
  const text = res && res.ok ? await res.text().catch(() => null) : null;
  if (turn !== shelfTurn) return true;
  const next = text === null ? null : new DOMParser().parseFromString(text, "text/html").getElementById("handy-shelf");
  if (!next) {
    document.getElementById("handy-error").textContent = ${JSON.stringify(SHELF_STALE)};
    return;
  }
  const shown = [...shelf.querySelectorAll("[data-more]")].some((tile) => !tile.hidden);
  shelf.innerHTML = next.innerHTML;
  if (shown) showAll(shelf);
  if (from) focusAfter(shelf, from);
};
{
const handy = document.getElementById("handy");
const handyError = document.getElementById("handy-error");
// Each tile button: its route and body, and the Undo bar's words when it removes the tile.
const SHELF_ACTS = {
  "still-using": (id) => ["/tools/still-using", { id }, null],
  "not-handy": (id) => ["/tools/not-handy", { id }, "Not handy anymore."],
  "suggest-yes": (id) => ["/tools/suggestion", { id, keep: true }, null],
  "suggest-no": (id) => ["/tools/suggestion", { id, keep: false }, "Not kept handy."],
};
const offerUndo = (message, route, body, from) =>
  showUndo(message, async () => {
    const back = await post(route, body);
    if (back && back.status === 204) await refreshShelf(from);
    else handyError.textContent = await failure(back);
  });
if (handy) {
  handy.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button || button.disabled) return;
    const act = button.dataset.act;
    if (act === "show-all") {
      const shelf = document.getElementById("handy-shelf");
      const first = shelf.querySelector("[data-more]");
      showAll(shelf);
      if (first) first.querySelector("a, button, summary").focus();
      return;
    }
    const make = SHELF_ACTS[act];
    if (!make && act !== "done") return;
    const tile = button.closest("[data-id]");
    const id = tile.dataset.id;
    const after = tile.nextElementSibling;
    const from = { id, act, next: after && after.dataset.id ? after.dataset.id : null };
    handyError.textContent = "";
    button.disabled = true;
    let dropped = false;
    try {
      if (act === "done") {
        const res = await post("/home/archive", { id });
        if (!res || res.status !== 204) {
          handyError.textContent = await failure(res);
          return;
        }
        dropped = await refreshShelf(from);
        offerUndo("Moved out of your list.", "/home/unarchive", { id }, from);
        return;
      }
      const [route, body, undo] = make(id);
      const res = await post(route, body);
      const moved = res && res.status === 200 ? await res.json().catch(() => null) : null;
      if (!moved || !moved.tool) {
        handyError.textContent = await failure(res);
        return;
      }
      dropped = await refreshShelf(from);
      if (undo) offerUndo(undo, "/tools/undo", { id, tool: moved.tool, previous: moved.previous }, from);
    } finally {
      if (!dropped) button.disabled = false;
    }
  });
}
}`;
