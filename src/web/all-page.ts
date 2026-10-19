import type { CopyNotice } from "../core/copy-usage.js";
import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import type { GoneView } from "../core/link-check.js";
import { linkSpace } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import { LINK_ORDERS, type LinkOrder } from "../core/search.js";
import type { HandyView } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { removeCopyScript } from "./copy-menu.js";
import { deleteLinkScript } from "./delete-link.js";
import { editData, editDialog, editLinkScript, editMenu } from "./edit-link.js";
import { goneLine, goneScript } from "./gone-line.js";
import { handyControl, keepHandyScript } from "./keep-handy.js";
import { linkTitle, openedScript } from "./open-link.js";
import { escapeHtml, page } from "./page.js";
import { siteLine, spaceClass, tile } from "./pages.js";
import { olderScript } from "./show-older.js";
import { CARD_FETCH } from "./tell-why.js";

/**
 * The URL of All links in `order`, or with `done` the links you're done with; `before` is a
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

const ORDER_NAMES: Record<LinkOrder, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  opened: "Recently opened",
};

type Input = {
  order: LinkOrder;
  links: Link[];
  older: string | null;
  catalog: Tag[];
  images: Map<string, ShownPicture>;
  handy: Map<string, HandyView | null>;
  gone?: Map<string, GoneView | null>;
  now: Date;
  /** The links you're done with, rather than the active ones. */
  done: boolean;
  /** A page after the first. */
  later?: boolean;
  /** Each card's picture info, for the edit dialog; read on the active pages only. */
  pictures?: Map<string, PictureInfo>;
  /** The links that have a saved copy. */
  copies?: Map<string, CopyInfo>;
  /** What to say about saved copies at the foot; shown on the first page of active links only. */
  notice?: CopyNotice | null;
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

/** The time a card is grouped by: when it was opened in opened order, else when it was saved. */
const groupTime = (link: Link, order: LinkOrder) =>
  order === "opened" && link.lastOpenedAt ? link.lastOpenedAt : link.savedAt;

/** "YYYY-MM" in UTC: the key a later page's first month joins the last one shown by. */
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** "October"; the year is added when it is not the current one. Always read in UTC. */
const monthName = (d: Date, now: Date) =>
  d.toLocaleDateString("en-US", {
    month: "long",
    ...(d.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });

/** One card: the picture or a tint, the title, the space and site, and Keep handy. No why. */
function card(
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
  const picture = images.get(link.id);
  return `<li class="link-card all-card${spaceClass(space)}${done ? " faded" : ""}" data-id="${escapeHtml(link.id)}"${done ? "" : editData(link, picture, pictures.get(link.id))}>
${tile(link, picture, "card-image")}
${done ? "" : `${editMenu(link, copies.get(link.id))}\n`}<div class="card-body">
<h3>${linkTitle(link)}</h3>
${siteLine(link, space)}${goneLine(link, gone.get(link.id), copies.get(link.id))}${handyControl(link, handy.get(link.id))}</div>
</li>`;
}

/** The links grouped into one section per UTC month, in the order given. */
function months(input: Input): string {
  const groups: { key: string; at: Date; links: Link[] }[] = [];
  for (const link of input.links) {
    const at = groupTime(link, input.order);
    const key = monthKey(at);
    const last = groups.at(-1);
    if (last?.key === key) last.links.push(link);
    else groups.push({ key, at, links: [link] });
  }
  return groups
    .map(({ key, at, links }) => {
      const name = monthName(at, input.now);
      const heading = input.order === "opened" ? `Opened in ${name}` : name;
      return `<section class="month" data-month="${key}">
<h2>${heading}</h2>
<ul class="link-cards">
${links.map((l) => card(l, input)).join("\n")}
</ul>
</section>`;
    })
    .join("\n");
}

function empty({ order, done, later }: Input): string {
  if (later) return order === "newest" ? "No older links." : "No more links.";
  if (done && order === "opened") return "You haven't opened any of the links you're done with.";
  if (done) return "Nothing here is done yet.";
  if (order === "opened") {
    return "Nothing opened yet. Links you open from this site show here.";
  }
  return "No links yet.";
}

/**
 * All links, or with `done` the links you're done with, in one of the orders, grouped by month.
 * It shows no count. Each page has at most the links given; `older` is the cursor of the next
 * page, or null.
 */
export function allPage(input: Input): string {
  const { order, links, older, done } = input;
  const choices = LINK_ORDERS.map(
    (o) =>
      `<a href="${escapeHtml(allHref(o, { done }))}"${o === order ? ' aria-current="true"' : ""}>${ORDER_NAMES[o]}</a>`,
  ).join(`<span aria-hidden="true">·</span>`);
  const list =
    links.length === 0
      ? `<p>${empty(input)}</p>`
      : `<div id="all-links">\n${months(input)}\n</div>`;
  const more = older
    ? `<a class="show-older" id="older" href="${escapeHtml(allHref(order, { done, before: older }))}">${order === "newest" ? "Show older links" : "Show more links"}</a>`
    : "";
  const other = done
    ? `<a class="back-link" href="${escapeHtml(allHref(order))}">Back to All links</a>`
    : `<a class="done-link" href="${escapeHtml(allHref(order, { done: true }))}">Links you're done with</a>`;
  return page(
    `${done ? "Done · " : ""}All links · Aye-AI-AI Links`,
    `<main class="all">
<div class="all-head">
<h1>${done ? "Links you're done with" : "All links"}</h1>
<a class="search-instead" href="/search">Search instead</a>
</div>
<nav class="orders" aria-label="Order">${choices}</nav>
${done ? "" : '<p id="all-error" role="alert"></p>'}
${list}
<div class="all-foot">${noticeLine(input)}${more}${other}</div>
</main>
${done ? "" : `${editDialog()}\n<script>\n${CARD_FETCH}\n${keepHandyScript("all-links", "all-error")}\n${goneScript("all-links", "all-error")}\n${editLinkScript("all-links", "all-error")}\n${removeCopyScript("all-links", "all-error")}\n${deleteLinkScript("all-links", "all-error")}\n</script>\n`}${openedScript("all-links", "/links/opened")}${older ? olderScript("all-links") : ""}`,
    { menu: true, undo: !done },
  );
}
