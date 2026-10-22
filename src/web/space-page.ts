import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import type { GoneView } from "../core/link-check.js";
import { lineSpace, linkSpace } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { LinkOrder } from "../core/search.js";
import type { HandyView } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import type { Ask } from "./ask-panel.js";
import { removeCopyScript } from "./copy-menu.js";
import { deleteLinkScript } from "./delete-link.js";
import { doneLinkScript, OUT_OF_LISTS, PUT_AWAY_MARKER } from "./done-link.js";
import { editDialog, editLinkScript } from "./edit-link.js";
import { goneScript } from "./gone-line.js";
import { keepHandyScript } from "./keep-handy.js";
import { orderNav, orderSelect, orderSelectScript } from "./link-orders.js";
import { linkRow, monthSections, type View, viewScript, viewSwitch } from "./link-rows.js";
import { openedScript } from "./open-link.js";
import { escapeHtml, page } from "./page.js";
import { searchHref, tagSpaceClass } from "./pages.js";
import { olderScript } from "./show-older.js";
import { CARD_FETCH, tellWhyScript } from "./tell-why.js";

/**
 * The URL of a tag's space page in `order` (newest is the plain address), or with `done` its links
 * out of your lists; `before` is a page's `older` cursor. Every part is encoded, so any key comes
 * back as itself.
 */
export const spaceHref = (
  key: string,
  {
    done = false,
    before,
    order = "newest",
  }: { done?: boolean; before?: string; order?: LinkOrder } = {},
) =>
  `/spaces${done ? "/done" : ""}?tag=${encodeURIComponent(key)}${
    order === "newest" ? "" : `&order=${order}`
  }${before === undefined ? "" : `&before=${encodeURIComponent(before)}`}`;

/**
 * What kind of project a space is, or nothing for a topic, which says nothing a space does not
 * already. Only a project an AI guessed is a guess, as on the Tags page.
 */
function kindLine(t: Tag): string | null {
  if (t.kind === "topic") return null;
  if (t.kindSource === "inferred") return "Maybe a project you're working on (a guess)";
  return t.projectStatus === "done" ? "A project you finished" : "A project you're working on now";
}

/** Where Change opens: the Tags page, with this tag's edit panel open. */
const changeHref = (t: Tag) => `/tags#tag=${encodeURIComponent(t.key)}`;

const header = (t: Tag) => {
  const kind = kindLine(t);
  return `<header class="page-head${tagSpaceClass(t)}">
<div class="page-title">
<h1><span class="dot" aria-hidden="true"></span>${escapeHtml(t.name)}</h1>
<a class="change-link" href="${escapeHtml(changeHref(t))}">Change</a>
</div>
${kind ? `<p class="page-kind">${kind}</p>\n` : ""}${t.description ? `<p class="page-description">${escapeHtml(t.description)}</p>\n` : ""}</header>`;
};

type Input = {
  tag: Tag;
  /** How the links are ordered; newest first on Out of your lists, which has no sort. */
  order?: LinkOrder;
  catalog: Tag[];
  links: Link[];
  older: string | null;
  images: Map<string, ShownPicture>;
  handy: Map<string, HandyView | null>;
  gone?: Map<string, GoneView | null>;
  now: Date;
  /** The links out of your lists, rather than the active ones. */
  done: boolean;
  /** A page after the first. */
  later?: boolean;
  /** Each card's picture info, for the edit dialog; read on the active pages only. */
  pictures?: Map<string, PictureInfo>;
  /** The links that have a saved copy. */
  copies?: Map<string, CopyInfo>;
  ask?: Ask | undefined;
  /** The view the owner chose in this browser (`VIEW_COOKIE`); the list without one. */
  view?: View;
};

/**
 * One row. An active link with no why asks Tell me why, in amber, "needs you"; a done one never
 * does, and its picture is faded while its text stays at full contrast.
 */
function row(
  link: Link,
  {
    tag,
    catalog,
    images,
    handy,
    gone = new Map(),
    done,
    order,
    pictures = new Map(),
    copies = new Map(),
  }: Input,
): string {
  const space = linkSpace(link, catalog, { within: tag.key });
  return linkRow(link, {
    from: spaceHref(tag.key, { done, ...(order === undefined ? {} : { order }) }),
    space,
    // The page's own space goes without saying; another one, on an unpinned tag's page, is named.
    lineSpace: lineSpace(space, { within: tag.key, own: true }),
    picture: images.get(link.id),
    info: pictures.get(link.id),
    copy: copies.get(link.id),
    handy: handy.get(link.id),
    gone: gone.get(link.id),
    faded: done,
    ask: !done,
  });
}

/**
 * Tell me why, the ⋯ menu (It's stale, Keep handy, the edit dialog, the saved copy's Remove
 * and Delete link) and the gone line on the active cards, including those Show older links appends.
 */
const cardsScript = (ask: boolean) => `<script>
${CARD_FETCH}
${viewScript}
${orderSelectScript}
${tellWhyScript("space-links", "space-error")}
${keepHandyScript("space-links", "space-error")}
${goneScript("space-links", "space-error")}
${removeCopyScript("space-links", "space-error")}
${ask ? "" : `${editLinkScript("space-links", "space-error")}\n`}${deleteLinkScript("space-links", "space-error")}
${doneLinkScript("space-links", "space-error")}
</script>
`;

/** The edit dialog, Delete link, Bring it back and the saved copy's Remove on the done cards, including those Show older links appends. */
const doneScript = (ask: boolean) => `<script>
${CARD_FETCH}
${viewScript}
${removeCopyScript("space-links", "space-error")}
${ask ? "" : `${editLinkScript("space-links", "space-error")}\n`}${deleteLinkScript("space-links", "space-error")}
${doneLinkScript("space-links", "space-error")}
</script>
`;

const CHEVRON = `<svg class="chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6.5 1L1.5 6l5 5"/></svg>`;

/** The first Out of your lists page's card for when it holds nothing. */
const DONE_EMPTY = `<div class="done-empty">
<p>Nothing here is out of your lists yet.</p>
<p class="small">Links you mark stale or put away from this space wait here. Search still finds them.</p>
</div>
`;

/** What an empty list says: the space has none, or no more are left on a later page. */
function emptyText({ order, later }: { order: LinkOrder; later?: boolean }) {
  if (later) return order === "newest" ? "No older links." : "No more links.";
  if (order === "opened")
    return "Nothing in this space opened yet. Links you open from this site show here.";
  return "No links in this space yet.";
}

/**
 * A tag's space: a header in its color (`spaceColor`: neutral while it is unpinned), then its
 * active links newest first, or with `done` the links out of your lists. Each page has at most
 * the links given; `older` is the cursor of the next page, or null.
 */
export function spacePage(input: Input): string {
  const { tag, links, older, done, later, now, view = "list" } = input;
  const order = done ? "newest" : (input.order ?? "newest");
  const list =
    links.length === 0
      ? `<p>${emptyText({ order, later })}</p>`
      : `<div id="space-links" data-within="${escapeHtml(tag.key)}" data-own="1">\n${monthSections(links, { order, now }, (l) => row(l, input))}\n</div>`;
  const more = older
    ? `<p><a class="show-older" id="older" href="${escapeHtml(spaceHref(tag.key, { done, order, before: older }))}">${order === "newest" ? "Show older links" : "Show more links"}</a></p>\n`
    : "";
  const tools = `<div class="page-top">
<div class="page-main">
${header(tag)}
${orderNav(order, (o) => spaceHref(tag.key, { order: o }))}
</div>
<div class="page-actions">
${orderSelect(order, { action: "/spaces", hidden: { tag: tag.key } })}
${viewSwitch(view)}
<a class="search-instead" href="${escapeHtml(searchHref("", { tag: tag.key }))}">Search this space</a>
</div>
</div>`;
  // The first page always holds the empty card and the switch; the theme shows one and hides the
  // other while the list has no shown row and no Show older link, so a row that leaves the page
  // (and its Undo) needs no script of its own.
  const body = done
    ? `<a class="back-link${tagSpaceClass(tag)}" href="${escapeHtml(spaceHref(tag.key))}">${CHEVRON}<span class="dot" aria-hidden="true"></span>Back to ${escapeHtml(tag.name)}</a>
<div class="list-head done-head"><h1>${OUT_OF_LISTS}</h1>${viewSwitch(view)}</div>
<p id="space-error" role="alert"></p>
${later ? "" : DONE_EMPTY}${links.length === 0 && !later ? "" : `${list}\n`}${more}`
    : `${tools}
<p id="space-error" role="alert"></p>
${list}
${more}<p class="small"><a class="done-link" href="${escapeHtml(spaceHref(tag.key, { done: true }))}">${OUT_OF_LISTS}</a></p>`;
  return page(
    `${done ? `${OUT_OF_LISTS} in ` : ""}${tag.name} · Aye-AI-AI Links`,
    `<main class="space" data-view="${view}">
${body}
</main>
${input.ask ? "" : `${editDialog()}\n`}${(done ? doneScript : cardsScript)(input.ask !== undefined)}${openedScript("space-links", "/links/opened", done ? PUT_AWAY_MARKER : undefined)}${older ? olderScript("space-links") : ""}`,
    {
      menu: true,
      undo: true,
      ask: input.ask,
      edits: { root: "space-links", error: "space-error" },
    },
  );
}

/** Where a changed space page address starts again. */
export const SPACE_RESTART = `Open the space again from the <a href="/">home page</a> and page from its newest links.`;

/** For a tag the owner does not have, whoever else has it. It never names the tag asked for. */
export const spaceMissingPage = (ask?: Ask | undefined) =>
  page(
    "Not found · Aye-AI-AI Links",
    `<main>
<h1>This space is not here</h1>
<p>There is no tag with that name. Your tags are on the <a href="/tags">Tags page</a>.</p>
</main>`,
    { menu: true, ask },
  );
