import type { ShownPicture } from "../core/image-store.js";
import { linkSpace, type Space } from "../core/link-space.js";
import type { ShelfItem, ToolItem } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { cardMenu } from "./card-menu.js";
import { displayTitle } from "./display-title.js";
import { DONE_ITEM, DONE_LABEL, DONE_UNDO, DONE_WORKING } from "./done-link.js";
import { goneBand, STILL_WORKS_WORKING } from "./gone-line.js";
import { hostOf } from "./host.js";
import { NOT_HANDY, NOT_HANDY_WORKING } from "./keep-handy.js";
import { linkTitle } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { spaceClass, tile } from "./pages.js";
import { spine } from "./tray-spine.js";

/** Tiles the shelf shows before Show all (#125). */
export const SHELF_SIZE = 8;

/** The shelf's kept tools in shelf order, its suggestions, the owner's tags for each tile's space, and image versions by link id. */
export type Shelf = {
  items: ShelfItem[];
  suggestions: ToolItem[];
  catalog: Tag[];
  images: Map<string, ShownPicture>;
};

/** Add: a dashed tile ending the row (#304). Search results each carry Keep handy, so picking one there keeps it. */
const ADD = `<a class="add-tile" href="/search?q=&keep=1"><span class="add-plus" aria-hidden="true">+</span>Keep a link handy</a>`;

const STILL_USING = `<div class="ask">
<p class="small">Still using?</p>
<div class="actions small-actions">
<button type="button" data-act="still-using">Yes</button>
<button type="button" data-act="done">${DONE_LABEL}</button>
</div>
</div>`;

const KEEP_HANDY = `<div class="ask">
<p class="small">Keep handy?</p>
<div class="actions small-actions">
<button type="button" data-act="suggest-yes">Yes</button>
<button type="button" data-act="suggest-no">No</button>
</div>
</div>`;

/**
 * What each tile button says while its action waits for the answer (#314), by `data-act`. A ⋯ menu
 * row has none: the menu closes, and the tile only dims. The yes and no answers are the shelf's
 * own words; the others are their actions' (`done-link.ts`, `gone-line.ts`, `keep-handy.ts`).
 */
const WORKING = {
  "still-using": "Keeping…",
  "not-handy": NOT_HANDY_WORKING,
  "suggest-yes": "Adding…",
  "suggest-no": "Skipping…",
  done: DONE_WORKING,
  archive: DONE_WORKING,
  "still-works": STILL_WORKS_WORKING,
};

/** A kept tile's ⋯ menu: the link menu's first group (#192), with Keep handy already done. */
const menu = (link: Link) => cardMenu(`More for ${displayTitle(link)}`, [DONE_ITEM, NOT_HANDY]);

/** The space's dot and the site's host, without the space's name or a saved copy (the list cards use `cardLine`). */
function hostLine(link: Link, space: Space | null): string {
  const host = hostOf(link.url);
  if (!host) return "";
  const dot = space ? `<span class="dot" aria-hidden="true"></span>` : "";
  return `<p class="card-site">${dot}<span class="host">${escapeHtml(host)}</span></p>\n`;
}

/**
 * A compact card: the stored image (or the initials) as a small square, and beside it the title,
 * opening the link and recorded by `openedScript`, with the host under it. `after` holds the
 * tile's ask, which the theme puts on its own line, and its menu.
 */
function card(
  { link }: ToolItem,
  { catalog, images }: Shelf,
  classes: string,
  after: string,
  attrs = "",
): string {
  const space = linkSpace(link, catalog);
  return `<article class="handy-tile${classes}${spaceClass(space)}" data-id="${escapeHtml(link.id)}"${attrs}>
${tile(link, images.get(link.id), "handy-image")}
<div class="handy-caption">
<h3>${linkTitle(link)}</h3>
${hostLine(link, space)}</div>
${after}
</article>`;
}

/**
 * A kept tool. Past the first SHELF_SIZE it is hidden until Show all. A due one needs you; a gone
 * one carries the gone band instead (#298), whose Done with it is this shelf's `done`.
 */
const keptTile = (item: ShelfItem, shelf: Shelf, more: boolean) =>
  card(
    item,
    shelf,
    item.due && !item.gone ? " needs-you" : "",
    `${item.gone ? `${goneBand(item.link, { done: "done" })}\n` : item.due ? `${STILL_USING}\n` : ""}${menu(item.link)}`,
    more ? " data-more hidden" : "",
  );

/** An agent's guess: a faded tile asking the owner, at the end of the row. */
const suggestion = (item: ToolItem, shelf: Shelf) => card(item, shelf, " guess", KEEP_HANDY);

/**
 * The Handy shelf on home: kept tools in core's order (gone and due first), the first SHELF_SIZE shown and
 * Show all for the rest, then up to SUGGESTION_SIZE suggestions, then the Add tile; the tile alone
 * when it holds nothing. The script swaps `#handy-shelf`'s contents for a fresh copy after each
 * action, so the Add tile and Show all (a quiet button under the row) sit inside it.
 */
export function handyShelf(shelf: Shelf): string {
  const { items, suggestions } = shelf;
  const showAll =
    items.length > SHELF_SIZE
      ? `\n<button type="button" class="handy-show-all" data-act="show-all">Show all ${items.length}</button>`
      : "";
  const body = `<div class="handy-row">
${[
  ...items.map((item, i) => keptTile(item, shelf, i >= SHELF_SIZE)),
  ...suggestions.map((s) => suggestion(s, shelf)),
  ADD,
].join("\n")}
</div>${showAll}`;
  return `<section class="handy" id="handy" aria-labelledby="handy-title">
${spine("handy")}
<h2 id="handy-title" class="visually-hidden" tabindex="-1">Handy</h2>
<p id="handy-error" role="alert"></p>
<div id="handy-shelf">
${body}
</div>
</section>`;
}

/** What the owner is told when the shelf could not be read again after an action that worked. */
export const SHELF_STALE = "Your Handy shelf may be out of date. Reload the page.";

/**
 * The shelf's script, for home's one script after `CARD_FETCH` (it needs `post`, `failure`,
 * `cardBusy`, `busyLook`, `collapseBand` and `showUndo`). A tile takes one action at a time (`cardBusy`): its mark is held
 * until the action, its shelf refresh and its Undo are done, and kept while the refresh was
 * dropped and the newest refresh is still running: its swap replaces the tile, and if it ends
 * without a swap the mark is released. The busy look is not the mark: it is
 * started with it, around the action and its refresh, and cleared when that work settles, so a
 * tile that keeps its mark never keeps the look. A button says its working word and dims the tile;
 * a ⋯ menu row (which closes) only dims it.
 * - `refreshShelf(from)` reads home again and swaps in its `#handy-shelf`, so the server decides the
 *   order, the cut and the due marker after every action. Tiles that were shown stay shown.
 * - A page that is not home (a sign-in redirect) is not swapped in, and the owner is told to reload.
 * - An answer that arrives after a newer refresh began is dropped (`shelfTurn`). Its tile keeps the
 *   mark only while the newest refresh has not settled (`settledTurn`); the newest releases the kept
 *   tiles when it ends without a swap, and forgets them when it swaps.
 * - `from` (the clicked button's tile, its act and the next tile, read at the click) puts focus back:
 *   on the same button, else the same tile's first control, else the next tile's, else the heading.
 * - Each button posts its route; a removal offers Undo, which sends back what the action answered,
 *   with the Undo ticket the action took with the tile's mark (`showUndo.ticket()`).
 *   It still works posts `/links/still-works` and offers Undo with the answer's `check` and `previous`.
 * - A button on the gone band collapses the band once the server agrees (`collapseBand`), inside
 *   the tile's mark, and only then refreshes the shelf, which draws the tile as the server decides.
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
  const button = same && same.querySelector('button[data-act="' + from.act + '"]');
  const target =
    (button && (button.closest("details") ? button.closest("details").querySelector("summary") : button)) ||
    (same && same.querySelector("a, button, summary")) ||
    (next && next.querySelector("a, button, summary")) ||
    document.getElementById("handy-title");
  if (target.closest("[hidden]")) showAll(shelf);
  target.focus();
};
let shelfTurn = 0;
let settledTurn = 0;
const keptTiles = new Set();
const refreshShelf = async (from, tile) => {
  const shelf = document.getElementById("handy-shelf");
  if (!shelf) return;
  const turn = ++shelfTurn;
  const res = await fetch("/", { headers: { accept: "text/html" }, redirect: "manual" }).catch(() => null);
  const text = res && res.ok ? await res.text().catch(() => null) : null;
  if (turn !== shelfTurn) {
    const newerRuns = settledTurn !== shelfTurn;
    if (newerRuns && tile) keptTiles.add(tile);
    return newerRuns;
  }
  settledTurn = turn;
  const next = text === null ? null : new DOMParser().parseFromString(text, "text/html").getElementById("handy-shelf");
  if (!next) {
    document.getElementById("handy-error").textContent = ${JSON.stringify(SHELF_STALE)};
    for (const kept of keptTiles) cardBusy.delete(kept);
    keptTiles.clear();
    return;
  }
  keptTiles.clear();
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
const working = ${JSON.stringify(WORKING)};
const offerUndo = (ticket, message, route, body, from, title) =>
  showUndo(ticket, message, async () => {
    const back = await post(route, body);
    if (back && back.status === 204) await refreshShelf(from);
    else handyError.textContent = await failure(back);
  }, title);
if (handy) {
  handy.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    if (act === "show-all") {
      const shelf = document.getElementById("handy-shelf");
      const first = shelf.querySelector("[data-more]");
      showAll(shelf);
      if (first) first.querySelector("a, button, summary").focus();
      return;
    }
    const make = SHELF_ACTS[act];
    // Done with it on a tile's ask and the menu's Done with it (archive) are the same action.
    const done = act === "done" || act === "archive";
    if (!make && !done && act !== "still-works") return;
    const tile = button.closest("[data-id]");
    const gone = button.closest("[data-gone]");
    if (cardBusy.has(tile)) return;
    const id = tile.dataset.id;
    const after = tile.nextElementSibling;
    const from = { id, act, next: after && after.dataset.id ? after.dataset.id : null };
    handyError.textContent = "";
    cardBusy.add(tile);
    const ticket = showUndo.ticket();
    const look = busyLook(tile, button.closest("details") ? null : button, working[act]);
    let dropped = false;
    try {
      if (done) {
        const res = await post("/home/archive", { id });
        look.answered();
        const change = res && res.status === 200 ? await res.json().catch(() => null) : null;
        if (!change || !change.before || !change.after) {
          handyError.textContent = await failure(res);
          return;
        }
        if (gone) await collapseBand(gone);
        dropped = await refreshShelf(from, tile);
        offerUndo(ticket, ${JSON.stringify(DONE_UNDO.text)}, "/home/undo-state", { id, change }, from, ${JSON.stringify(DONE_UNDO.title)});
        return;
      }
      if (act === "still-works") {
        const res = await post("/links/still-works", { id });
        look.answered();
        const moved = res && res.status === 200 ? await res.json().catch(() => null) : null;
        if (!moved || !moved.check) {
          handyError.textContent = await failure(res);
          return;
        }
        if (gone) await collapseBand(gone);
        dropped = await refreshShelf(from, tile);
        offerUndo(ticket, "Marked as working.", "/links/still-works/undo", { id, check: moved.check, previous: moved.previous }, from);
        return;
      }
      const [route, body, undo] = make(id);
      const res = await post(route, body);
      look.answered();
      const moved = res && res.status === 200 ? await res.json().catch(() => null) : null;
      if (!moved || !moved.tool) {
        handyError.textContent = await failure(res);
        return;
      }
      dropped = await refreshShelf(from, tile);
      if (undo) offerUndo(ticket, undo, "/tools/undo", { id, tool: moved.tool, previous: moved.previous }, from);
    } finally {
      look.clear();
      if (!dropped) cardBusy.delete(tile);
    }
  });
}
}`;
