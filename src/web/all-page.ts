import type { CopyNotice } from "../core/copy-usage.js";
import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import type { GoneView } from "../core/link-check.js";
import { linkSpace } from "../core/link-space.js";
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
import { orderNav } from "./link-orders.js";
import { linkRow, monthSections, type View, viewScript, viewSwitch } from "./link-rows.js";
import { openedScript } from "./open-link.js";
import { escapeHtml, page } from "./page.js";
import { olderScript } from "./show-older.js";
import { CARD_FETCH } from "./tell-why.js";

/**
 * The URL of All links in `order`, or with `done` the links out of your lists; `before` is a
 * page's `older` cursor. Newest, the default order, is the plain address.
 */
export const allHref = (
  order: LinkOrder,
  { done = false, before }: { done?: boolean; before?: string } = {},
) => {
  const query = new URLSearchParams();
  if (order !== "newest") query.set("order", order);
  if (before !== undefined) query.set("before", before);
  const search = query.toString();
  return `/all${done ? "/done" : ""}${search ? `?${search}` : ""}`;
};

/** What `?order=` and `?before=` restart from when they were changed by hand. */
export const ALL_RESTART = `Open <a href="/all">All links</a> again and page from the start.`;

type Input = {
  order: LinkOrder;
  links: Link[];
  older: string | null;
  catalog: Tag[];
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
  /** What to say about saved copies at the foot; shown on the first page of active links only. */
  notice?: CopyNotice | null;
  ask?: Ask | undefined;
  /** The view the owner chose in this browser (`VIEW_COOKIE`); the list without one. */
  view?: View;
};

/** GiB rounded down to `places` decimals; the tolerance keeps a configured tenth from reading one lower. */
const gib = (bytes: number, places: number) =>
  String(Math.floor((bytes * 10 ** places) / 1024 ** 3 + 1e-6) / 10 ** places);

const limitPlaces = (limitBytes: number) => (gib(limitBytes, 1) === gib(limitBytes, 2) ? 1 : 2);

const usageText = (usedBytes: number, limitBytes: number) => {
  const places = limitPlaces(limitBytes);
  return `Saved copies use ${gib(usedBytes, places)} of ${gib(limitBytes, places)} GiB.`;
};

const noticeText = (n: CopyNotice): string =>
  n.kind === "high"
    ? usageText(n.usedBytes, n.limitBytes)
    : n.kind === "full"
      ? "Saved copies are almost full, so new links may not get one. Raise AYE_SAVED_COPY_LIMIT_GB or remove some copies."
      : "Saved copies are paused: the server can't write to its folder.";

const noticeLine = ({ notice, done, later }: Input): string =>
  notice && !done && !later
    ? `<p class="copy-notice${notice.kind === "high" ? "" : " needs-you"}">${escapeHtml(noticeText(notice))}</p>`
    : "";

/** One row: the picture, the title, the why, the space and site, and the ⋯ menu. */
function row(
  link: Link,
  {
    catalog,
    images,
    handy,
    gone = new Map(),
    done,
    pictures = new Map(),
    copies = new Map(),
  }: Input,
): string {
  const space = linkSpace(link, catalog);
  return linkRow(link, {
    space,
    lineSpace: space,
    picture: images.get(link.id),
    info: pictures.get(link.id),
    copy: copies.get(link.id),
    handy: handy.get(link.id),
    gone: gone.get(link.id),
    faded: done,
  });
}

function empty({ order, done, later }: Input): string {
  if (later) return order === "newest" ? "No older links." : "No more links.";
  if (done && order === "opened") return "You haven't opened any of the links out of your lists.";
  if (done) return "Nothing here is out of your lists yet.";
  if (order === "opened") {
    return "Nothing opened yet. Links you open from this site show here.";
  }
  return "No links yet.";
}

/**
 * All links, or with `done` the links out of your lists, in one of the orders, grouped by month.
 * It shows no count. Each page has at most the links given; `older` is the cursor of the next
 * page, or null.
 */
export function allPage(input: Input): string {
  const { order, links, older, done, view = "list" } = input;
  const list =
    links.length === 0
      ? `<p>${empty(input)}</p>`
      : `<div id="all-links">\n${monthSections(links, input, (l) => row(l, input))}\n</div>`;
  const more = older
    ? `<a class="show-older" id="older" href="${escapeHtml(allHref(order, { done, before: older }))}">${order === "newest" ? "Show older links" : "Show more links"}</a>`
    : "";
  const other = done
    ? `<a class="back-link" href="${escapeHtml(allHref(order))}">Back to All links</a>`
    : `<a class="done-link" href="${escapeHtml(allHref(order, { done: true }))}">${OUT_OF_LISTS}</a>`;
  return page(
    `${done ? `${OUT_OF_LISTS} · ` : ""}All links · Aye-AI-AI Links`,
    `<main class="all" data-view="${view}">
<div class="all-head">
<h1>${done ? OUT_OF_LISTS : "All links"}</h1>
<div class="all-tools">${viewSwitch(view)}<a class="search-instead" href="/search">Search instead</a></div>
</div>
${orderNav(order, (o) => allHref(o, { done }))}
<p id="all-error" role="alert"></p>
${list}
<div class="all-foot">${noticeLine(input)}${more}${other}</div>
</main>
${input.ask ? "" : `${editDialog()}\n`}<script>
${CARD_FETCH}
${viewScript}
${done ? "" : `${keepHandyScript("all-links", "all-error")}\n${goneScript("all-links", "all-error")}\n`}${input.ask ? "" : `${editLinkScript("all-links", "all-error")}\n`}${removeCopyScript("all-links", "all-error")}
${deleteLinkScript("all-links", "all-error")}
${doneLinkScript("all-links", "all-error")}
</script>
${openedScript("all-links", "/links/opened", done ? PUT_AWAY_MARKER : undefined)}${older ? olderScript("all-links") : ""}`,
    {
      menu: true,
      undo: true,
      ask: input.ask,
      edits: { root: "all-links", error: "all-error" },
    },
  );
}
