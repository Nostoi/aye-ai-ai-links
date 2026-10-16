import { linkSpace } from "../core/link-space.js";
import { LINK_ORDERS, type LinkOrder } from "../core/search.js";
import type { Link, Tag } from "../core/types.js";
import { linkTitle, openedScript } from "./open-link.js";
import { escapeHtml, page } from "./page.js";
import { hostOf, spaceClass, tile } from "./pages.js";
import { olderScript } from "./show-older.js";

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
  images: Map<string, string>;
  now: Date;
  /** The links you're done with, rather than the active ones. */
  done: boolean;
  /** A page after the first. */
  later?: boolean;
};

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

/** One card: the picture or a tint, the title, and the space and site. No why and no actions. */
function card(link: Link, { catalog, images, done }: Input): string {
  const space = linkSpace(link, catalog);
  const site = [space?.name, hostOf(link.url)].filter(Boolean).join(", ");
  const dot = space ? `<span class="dot" aria-hidden="true"></span>` : "";
  return `<li class="link-card all-card${spaceClass(space)}${done ? " faded" : ""}" data-id="${escapeHtml(link.id)}">
${tile(link, images.get(link.id), "card-image")}
<div class="card-body">
<h3>${linkTitle(link)}</h3>
${site ? `<p class="card-site">${dot}${escapeHtml(site)}</p>\n` : ""}</div>
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
${list}
<div class="all-foot">${more}${other}</div>
</main>
${openedScript("all-links", "/links/opened")}${older ? olderScript("all-links") : ""}`,
    { menu: true },
  );
}
