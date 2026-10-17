import type { PictureInfo } from "../core/image-store.js";
import { linkSpace, spaceColor } from "../core/link-space.js";
import type { HandyView } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { editData, editDialog, editLinkScript, editMenu } from "./edit-link.js";
import { hostOf } from "./host.js";
import { handyControl, keepHandyScript } from "./keep-handy.js";
import { linkTitle, openedScript } from "./open-link.js";
import { escapeHtml, page, savedOn } from "./page.js";
import { spaceClass, tile, whyLine } from "./pages.js";
import { olderScript } from "./show-older.js";
import { askWhy, CARD_FETCH, tellWhyScript, whyAnswer } from "./tell-why.js";

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
  images: Map<string, string>;
  handy: Map<string, HandyView | null>;
  now: Date;
  /** The links you're done with, rather than the active ones. */
  done: boolean;
  /** A page after the first. */
  later?: boolean;
  /** Each card's picture info, for the edit dialog; read on the active pages only. */
  pictures?: Map<string, PictureInfo>;
};

/**
 * One card. An active link with no why asks Tell me why, in amber, "needs you"; a done one never
 * does, and its picture is faded while its text stays at full contrast.
 */
function card(
  link: Link,
  { tag, catalog, images, handy, now, done, pictures = new Map() }: Input,
): string {
  const host = hostOf(link.url);
  const saved = `${host ? `${escapeHtml(host)}, saved` : "Saved"} ${savedOn(link.savedAt, now)}`;
  const why =
    link.why || done
      ? `<p class="card-why">${whyLine(link.why)}</p>`
      : `${whyAnswer("p", "Why: ", "card-why")}\n${askWhy(link)}`;
  const space = linkSpace(link, catalog, { within: tag.key });
  const version = images.get(link.id);
  return `<li class="link-card${spaceClass(space)}${done ? " faded" : ""}" data-id="${escapeHtml(link.id)}"${done ? "" : editData(link, version, pictures.get(link.id))}>
${tile(link, version, "card-image")}
${done ? "" : `${editMenu(link)}\n`}<div class="card-body">
<h3>${linkTitle(link)}</h3>
<p class="small">${saved}</p>
${why}
${done ? "" : handyControl(link, handy.get(link.id))}</div>
</li>`;
}

/**
 * Tell me why, Keep handy and the edit dialog on the active cards, including those Show older
 * links appends.
 */
const CARDS_SCRIPT = `<script>
${CARD_FETCH}
${tellWhyScript("space-links", "space-error")}
${keepHandyScript("space-links", "space-error")}
${editLinkScript("space-links", "space-error")}
</script>
`;

/**
 * A tag's space: a header in its color (`spaceColor`: neutral while it is unpinned), then its
 * active links newest first, or with `done` the links you're done with. Each page has at most
 * the links given; `older` is the cursor of the next page, or null.
 */
export function spacePage(input: Input): string {
  const { tag, links, older, done, later } = input;
  const empty = later
    ? "No older links."
    : done
      ? "Nothing here is done yet."
      : "No links in this space yet.";
  const list =
    links.length === 0
      ? `<p>${empty}</p>`
      : `<ul class="link-cards" id="space-links">\n${links.map((l) => card(l, input)).join("\n")}\n</ul>`;
  const more = older
    ? `<p><a class="show-older" id="older" href="${escapeHtml(spaceHref(tag.key, { done, before: older }))}">Show older links</a></p>\n`
    : "";
  const body = done
    ? `<h2>Links you're done with</h2>
<p class="small"><a class="back-link" href="${escapeHtml(spaceHref(tag.key))}">Back to ${escapeHtml(tag.name)}</a></p>
${list}
${more}`
    : `<h2>Newest first</h2>
<p id="space-error" role="alert"></p>
${list}
${more}<p class="small"><a class="done-link" href="${escapeHtml(spaceHref(tag.key, { done: true }))}">Links you're done with</a></p>`;
  return page(
    `${done ? "Done in " : ""}${tag.name} · Aye-AI-AI Links`,
    `<main class="space">
${header(tag)}
${body}
</main>
${done ? "" : `${editDialog()}\n${CARDS_SCRIPT}`}${openedScript("space-links", "/links/opened")}${older ? olderScript("space-links") : ""}`,
    { menu: true, undo: !done },
  );
}

/** Where a changed space page address starts again. */
export const SPACE_RESTART = `Open the space again from the <a href="/">home page</a> and page from its newest links.`;

/** For a tag the owner does not have, whoever else has it. It never names the tag asked for. */
export const spaceMissingPage = () =>
  page(
    "Not found · Aye-AI-AI Links",
    `<main>
<h1>This space is not here</h1>
<p>There is no tag with that name. Your tags are on the <a href="/tags">Tags page</a>.</p>
</main>`,
    { menu: true },
  );
