import type { LinkImageReader, PictureInfo, ShownPicture } from "../core/image-store.js";
import { linkSpace } from "../core/link-space.js";
import type { LinkStore } from "../core/store.js";
import type { Link, OwnerId, Tag } from "../core/types.js";
import { editData } from "./edit-link.js";
import { linkTitle } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { spaceClass, tile } from "./pages.js";

/**
 * One link as a card in the Ask AI panel: picture, title, why and tags (#159). It carries the
 * edit dialog's data attributes, as a page's cards do.
 */
export function renderCard(
  link: Link,
  picture: ShownPicture | undefined,
  info: PictureInfo | undefined,
  catalog: Tag[],
): string {
  const why = link.why
    ? `<p class="ask-why">"${escapeHtml(link.why.text)}"${link.why.source === "inferred" ? " (a guess)" : ""}</p>\n`
    : "";
  const space = linkSpace(link, catalog);
  const tags = link.tags
    .map((t) =>
      t.source === "inferred"
        ? `<span class="ask-tag guess">${escapeHtml(t.name)} (a guess)</span>`
        : `<span class="ask-tag${t.key === space?.key ? " ask-space" : ""}">${escapeHtml(t.name)}</span>`,
    )
    .join("");
  return `<article class="ask-card${spaceClass(space)}" data-id="${escapeHtml(link.id)}"${editData(link, picture, info)}>
${tile(link, picture, "ask-tile")}
<div class="ask-card-body">
<h3>${linkTitle(link)}</h3>
${why}${tags ? `<div class="ask-tags">${tags}</div>\n` : ""}</div>
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
