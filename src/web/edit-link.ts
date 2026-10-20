import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import { titleFits } from "../core/links.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { Link } from "../core/types.js";
import { cardMenu, type MenuItem } from "./card-menu.js";
import { removeCopyItem } from "./copy-menu.js";
import { copyHref } from "./copy-page.js";
import { deleteLinkItem } from "./delete-link.js";
import { initialsText } from "./initials.js";
import { escapeHtml } from "./page.js";

export const PENCIL = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>`;

/** The cards' one menu row, which opens the edit dialog. */
export const EDIT_ITEM: MenuItem = { act: "edit", icon: PENCIL, text: "Edit title and picture…" };

const BOOK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4.5 5.5a2 2 0 0 1 2-2H19v14H6.5a2 2 0 0 0-2 2z"/><path d="M4.5 19.5a2 2 0 0 0 2 2H19v-4"/></svg>`;

/** The menu row that opens a link's saved copy, in the same tab. */
export const readCopyItem = (linkId: string): MenuItem => ({
  act: "read-copy",
  icon: BOOK,
  text: "Read saved copy",
  href: copyHref(linkId),
});

/** A card's ⋯ menu on the pages with the edit dialog; `copy` is the link's saved copy, if it has one. */
export const editMenu = (link: Link, copy?: CopyInfo) =>
  cardMenu(`More for ${link.title ?? link.url}`, [
    EDIT_ITEM,
    ...(copy ? [readCopyItem(link.id), removeCopyItem] : []),
    deleteLinkItem,
  ]);

/**
 * What the edit dialog reads from a card, as data attributes: the title ("" for none), the page's
 * own title, the version of the picture that shows, whether it is the owner's, the fetched
 * picture's version, and the initials a picture-less preview shows. The one helper for every
 * card builder.
 */
export function editData(
  link: Link,
  picture: ShownPicture | undefined,
  info: PictureInfo | undefined,
): string {
  const page = link.snapshot?.title ?? "";
  const data: [string, string][] = [
    ["title", link.title ?? ""],
    ["page-title", titleFits(page) ? page : ""],
    ["version", picture?.version ?? ""],
    ["fit", picture?.fit ?? ""],
    ["own", info?.own ? "1" : "0"],
    ["page-version", info?.pageVersion ?? ""],
    ["page-fit", info?.pageFit ?? ""],
    ["initials", initialsText(link)],
  ];
  return data.map(([name, value]) => ` data-${name}="${escapeHtml(value)}"`).join("");
}

export { editDialog, editLinkScript, SHRINK_SIDE } from "./edit-dialog.js";
