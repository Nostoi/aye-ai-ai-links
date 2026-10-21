import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import type { GoneView } from "../core/link-check.js";
import { linkSpace, spaceColor } from "../core/link-space.js";
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
import { spaceClass } from "./pages.js";
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

/** What kind of space it is. Only a project an AI guessed is a guess, as on the Tags page. */
function kindLine(t: Tag): string {
  if (t.kind === "topic") return "A topic you save links about";
  if (t.kindSource === "inferred") return "Maybe a project you're working on (a guess)";
  return t.projectStatus === "done" ? "A project you finished" : "A project you're working on now";
}

const header = (t: Tag) => {
  const color = spaceColor(t);
  return `<section class="band${spaceClass(color ? { color } : null)}">
<div class="band-color" aria-hidden="true"></div>
<div class="band-head">
<div class="band-title">
<h1><span class="dot" aria-hidden="true"></span>${escapeHtml(t.name)}</h1>
<p class="band-kind">${kindLine(t)}</p>
${t.description ? `<p class="band-description">${escapeHtml(t.description)}</p>\n` : ""}</div>
<a href="/tags">Change this space</a>
</div>
</section>`;
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
    pictures = new Map(),
    copies = new Map(),
  }: Input,
): string {
  const space = linkSpace(link, catalog, { within: tag.key });
  return linkRow(link, {
    space,
    // The page's own space goes without saying; another one, on an unpinned tag's page, is named.
    lineSpace: space?.key === tag.key ? null : space,
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

/** What an empty list says: the space has none, or no more are left on a later page. */
function emptyText({ order, done, later }: { order: LinkOrder; done: boolean; later?: boolean }) {
  if (later) return order === "newest" ? "No older links." : "No more links.";
  if (done) return "Nothing here is out of your lists yet.";
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
      ? `<p>${emptyText({ order, done, later })}</p>`
      : `<div id="space-links">\n${monthSections(links, { order, now }, (l) => row(l, input))}\n</div>`;
  const more = older
    ? `<p><a class="show-older" id="older" href="${escapeHtml(spaceHref(tag.key, { done, order, before: older }))}">${order === "newest" ? "Show older links" : "Show more links"}</a></p>\n`
    : "";
  const sort = orderNav(order, (o) => spaceHref(tag.key, { order: o }));
  const body = done
    ? `<div class="list-head"><h2>${OUT_OF_LISTS}</h2>${viewSwitch(view)}</div>
<p class="small"><a class="back-link" href="${escapeHtml(spaceHref(tag.key))}">Back to ${escapeHtml(tag.name)}</a></p>
<p id="space-error" role="alert"></p>
${list}
${more}`
    : `<div class="list-head">${sort}${orderSelect(order, { action: "/spaces", hidden: { tag: tag.key } })}${viewSwitch(view)}</div>
<p id="space-error" role="alert"></p>
${list}
${more}<p class="small"><a class="done-link" href="${escapeHtml(spaceHref(tag.key, { done: true }))}">${OUT_OF_LISTS}</a></p>`;
  return page(
    `${done ? `${OUT_OF_LISTS} in ` : ""}${tag.name} · Aye-AI-AI Links`,
    `<main class="space" data-view="${view}">
${header(tag)}
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
