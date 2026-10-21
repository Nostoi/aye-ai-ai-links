import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import type { GoneView } from "../core/link-check.js";
import { linkSpace, spaceColor } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { HandyView } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import type { Ask } from "./ask-panel.js";
import { removeCopyScript } from "./copy-menu.js";
import { deleteLinkScript } from "./delete-link.js";
import { doneLinkScript } from "./done-link.js";
import { editDialog, editLinkScript } from "./edit-link.js";
import { goneScript } from "./gone-line.js";
import { keepHandyScript } from "./keep-handy.js";
import { linkRow, monthSections, type View, viewScript, viewSwitch } from "./link-rows.js";
import { openedScript } from "./open-link.js";
import { escapeHtml, page } from "./page.js";
import { spaceClass } from "./pages.js";
import { olderScript } from "./show-older.js";
import { CARD_FETCH, tellWhyScript } from "./tell-why.js";

/**
 * The URL of a tag's space page, or with `done` its links you're done with; `before` is a page's
 * `older` cursor. Every part is encoded, so any key comes back as itself.
 */
export const spaceHref = (
  key: string,
  { done = false, before }: { done?: boolean; before?: string } = {},
) =>
  `/spaces${done ? "/done" : ""}?tag=${encodeURIComponent(key)}${
    before === undefined ? "" : `&before=${encodeURIComponent(before)}`
  }`;

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
  catalog: Tag[];
  links: Link[];
  older: string | null;
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
 * Tell me why, the ⋯ menu (I'm done with it, Keep handy, the edit dialog, the saved copy's Remove
 * and Delete link) and the gone line on the active cards, including those Show older links appends.
 */
const cardsScript = (ask: boolean) => `<script>
${CARD_FETCH}
${viewScript}
${tellWhyScript("space-links", "space-error")}
${keepHandyScript("space-links", "space-error")}
${goneScript("space-links", "space-error")}
${removeCopyScript("space-links", "space-error")}
${ask ? "" : `${editLinkScript("space-links", "space-error")}\n`}${deleteLinkScript("space-links", "space-error")}
${doneLinkScript("space-links", "space-error")}
</script>
`;

/** The edit dialog, Delete link and the saved copy's Remove on the done cards, including those Show older links appends. */
const doneScript = (ask: boolean) => `<script>
${CARD_FETCH}
${viewScript}
${removeCopyScript("space-links", "space-error")}
${ask ? "" : `${editLinkScript("space-links", "space-error")}\n`}${deleteLinkScript("space-links", "space-error")}
</script>
`;

/**
 * A tag's space: a header in its color (`spaceColor`: neutral while it is unpinned), then its
 * active links newest first, or with `done` the links you're done with. Each page has at most
 * the links given; `older` is the cursor of the next page, or null.
 */
export function spacePage(input: Input): string {
  const { tag, links, older, done, later, now, view = "list" } = input;
  const empty = later
    ? "No older links."
    : done
      ? "Nothing here is done yet."
      : "No links in this space yet.";
  const list =
    links.length === 0
      ? `<p>${empty}</p>`
      : `<div id="space-links">\n${monthSections(links, { order: "newest", now }, (l) => row(l, input))}\n</div>`;
  const more = older
    ? `<p><a class="show-older" id="older" href="${escapeHtml(spaceHref(tag.key, { done, before: older }))}">Show older links</a></p>\n`
    : "";
  const body = done
    ? `<div class="list-head"><h2>Links you're done with</h2>${viewSwitch(view)}</div>
<p class="small"><a class="back-link" href="${escapeHtml(spaceHref(tag.key))}">Back to ${escapeHtml(tag.name)}</a></p>
<p id="space-error" role="alert"></p>
${list}
${more}`
    : `<div class="list-head"><h2>Newest first</h2>${viewSwitch(view)}</div>
<p id="space-error" role="alert"></p>
${list}
${more}<p class="small"><a class="done-link" href="${escapeHtml(spaceHref(tag.key, { done: true }))}">Links you're done with</a></p>`;
  return page(
    `${done ? "Done in " : ""}${tag.name} · Aye-AI-AI Links`,
    `<main class="space" data-view="${view}">
${header(tag)}
${body}
</main>
${input.ask ? "" : `${editDialog()}\n`}${(done ? doneScript : cardsScript)(input.ask !== undefined)}${openedScript("space-links", "/links/opened")}${older ? olderScript("space-links") : ""}`,
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
