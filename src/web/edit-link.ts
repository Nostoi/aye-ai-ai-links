import type { PictureInfo } from "../core/image-store.js";
import type { Link } from "../core/types.js";
import { cardMenu, type MenuItem } from "./card-menu.js";
import { initialsText } from "./initials.js";
import { escapeHtml } from "./page.js";

export const PENCIL = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>`;

/** The cards' one menu row, which opens the edit dialog. */
export const EDIT_ITEM: MenuItem = { act: "edit", icon: PENCIL, text: "Edit title and picture…" };

/** A card's ⋯ menu on the pages with the edit dialog. */
export const editMenu = (link: Link) => cardMenu(`More for ${link.title ?? link.url}`, [EDIT_ITEM]);

/**
 * What the edit dialog reads from a card, as data attributes: the title ("" for none), the page's
 * own title, the version of the picture that shows, whether it is the owner's, the fetched
 * picture's version, and the initials a picture-less preview shows. The one helper for every
 * card builder.
 */
export function editData(
  link: Link,
  version: string | undefined,
  info: PictureInfo | undefined,
): string {
  const data: [string, string][] = [
    ["title", link.title ?? ""],
    ["page-title", link.snapshot?.title ?? ""],
    ["version", version ?? ""],
    ["own", info?.own ? "1" : "0"],
    ["page-version", info?.pageVersion ?? ""],
    ["initials", initialsText(link)],
  ];
  return data.map(([name, value]) => ` data-${name}="${escapeHtml(value)}"`).join("");
}
