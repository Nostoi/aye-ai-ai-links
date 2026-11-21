import type { LinkImageReader, PictureInfo, ShownPicture } from "../core/image-store.js";
import { linkSpace } from "../core/link-space.js";
import type { LinkStore } from "../core/store.js";
import type { Link, OwnerId, Tag } from "../core/types.js";
import { editData } from "./edit-link.js";
import { whyText } from "./link-rows.js";
import { linkTitle } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { spaceClass, tile } from "./pages.js";

/** The space's colour dot, which only the card's space tag carries. */
const DOT = `<span class="ask-dot" aria-hidden="true"></span>`;

/**
 * One link as a card in the Ask AI panel: picture, title, why and one line of tags, stated first,
 * then the inferred ones with "(a guess)" said once (#159, #334). It carries the edit dialog's
 * data attributes, as a page's cards do.
 */
export function renderCard(
  link: Link,
  picture: ShownPicture | undefined,
  info: PictureInfo | undefined,
  catalog: Tag[],
): string {
  const why = `<p class="ask-why" data-card-why="text"${link.why ? "" : " hidden"}>${link.why ? whyText(link.why) : ""}</p>\n`;
  const space = linkSpace(link, catalog);
  const name = (t: Link["tags"][number]) =>
    `${t.key === space?.key ? DOT : ""}${escapeHtml(t.name)}`;
  const stated = link.tags.filter((t) => t.source !== "inferred").map(name);
  const guesses = link.tags.filter((t) => t.source === "inferred").map(name);
  const guessed =
    guesses.length === 0
      ? []
      : [`${guesses.join(" · ")} ${guesses.length === 1 ? "(a guess)" : "(guesses)"}`];
  const tags = [...stated, ...guessed].join(" · ");
  return `<article class="ask-card${spaceClass(space)}" data-id="${escapeHtml(link.id)}"${editData(link, picture, info)}>
${tile(link, picture, "ask-tile")}
<div class="ask-card-body">
<h3>${linkTitle(link)}</h3>
${why}${tags ? `<p class="small ask-tagline">${tags}</p>\n` : ""}</div>
</article>`;
}

export type AskCardDeps = { store: Pick<LinkStore, "get" | "listTags">; images: LinkImageReader };

/** The owner's visible link and its card, or null for a missing, gone or foreign id. */
export async function loadCard(
  deps: AskCardDeps,
  owner: OwnerId,
  id: string,
): Promise<{ link: Link; html: string } | null> {
  const link = await deps.store.get(owner, id);
  if (!link) return null;
  const picture = (await deps.images.imageVersions(owner, [id])).get(id);
  const info = (await deps.images.pictureInfo(owner, [id])).get(id);
  const catalog = await deps.store.listTags(owner);
  return { link, html: renderCard(link, picture, info, catalog) };
}

/** One card's HTML, for the chat answer and `GET /ai/card/:id`; null when the owner has no such visible link. */
export async function askCard(
  deps: AskCardDeps,
  owner: OwnerId,
  id: string,
): Promise<string | null> {
  return (await loadCard(deps, owner, id))?.html ?? null;
}
