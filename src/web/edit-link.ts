import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import { titleFits } from "../core/links.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { HandyView } from "../core/tools.js";
import type { Link, LinkTag } from "../core/types.js";
import { cardMenu, DIVIDER, type MenuItem } from "./card-menu.js";
import { removeCopyItem } from "./copy-menu.js";
import { deleteLinkItem } from "./delete-link.js";
import { displayTitle } from "./display-title.js";
import { ARCHIVE_ITEM, BRING_BACK_ITEM } from "./done-link.js";
import { initialsText } from "./initials.js";
import { EXPLORE_IT_ITEM, KEEP_IT_ITEM } from "./intent.js";
import { KEEP_ITEM, NOT_HANDY } from "./keep-handy.js";
import { escapeHtml } from "./page.js";
import { SKIP_ITEM } from "./skip.js";

export const PENCIL = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>`;

/** The cards' one menu row, which opens the edit dialog. */
export const EDIT_ITEM: MenuItem = { act: "edit", icon: PENCIL, text: "Edit link…" };

/**
 * A card's ⋯ menu on the pages with the edit dialog, mildest first (#284). An active link's menu
 * opens with Keep it (Explore it once the link is To keep), then Archive and Keep handy, which
 * reads Not handy anymore once `handy` is kept; both rows of each pair are rendered and the
 * scripts swap them. A link kept handy is To keep for good, so it shows neither intent row. An archived link starts
 * at Edit and offers Bring it back after it. Then Remove saved copy when `copy` is there, and
 * Delete link last. The copy itself opens from the card's grey line (`cardLine`). Home's rows put
 * Skip first (`skip`); Home's featured card shows Keep, Skip and Archive as buttons, so its menu
 * leaves out those three and the two intent rows (`onCard`), and starts at Keep handy.
 */
export const editMenu = (
  link: Link,
  {
    copy,
    handy,
    skip = false,
    onCard = false,
  }: {
    copy?: CopyInfo | undefined;
    handy?: HandyView | null | undefined;
    skip?: boolean;
    onCard?: boolean;
  } = {},
) => {
  const kept = handy?.status === "kept";
  const active = link.state === "active";
  const first = active
    ? [
        ...(skip && !onCard ? [SKIP_ITEM] : []),
        ...(onCard
          ? []
          : [
              { ...KEEP_IT_ITEM, hidden: kept || link.intent === "keep" },
              { ...EXPLORE_IT_ITEM, hidden: kept || link.intent === "explore" },
              ARCHIVE_ITEM,
            ]),
        { ...KEEP_ITEM, hidden: kept },
        { ...NOT_HANDY, hidden: !kept },
        DIVIDER,
      ]
    : [];
  return cardMenu(`More for ${displayTitle(link)}`, [
    ...first,
    EDIT_ITEM,
    ...(active ? [] : [BRING_BACK_ITEM]),
    ...(copy ? [removeCopyItem] : []),
    DIVIDER,
    deleteLinkItem,
  ]);
};

/** A link's tags as the edit dialog reads and the edit routes answer them: key, name and source, in order. */
export const shownTags = (tags: LinkTag[]) =>
  tags.map(({ key, name, source }) => ({ key, name, source }));

/**
 * What the edit dialog reads from a card, as data attributes: the title ("" for none), the page's
 * own title, the version of the picture that shows, whether it is the owner's, the fetched
 * picture's version, the initials a picture-less preview shows, and the tags as JSON
 * (`shownTags`), and the link's intent and who said so ("" for nobody), and its why and who said so ("" for none).
 * The one helper for
 * every card builder.
 */
export function editData(
  link: Link,
  picture: ShownPicture | undefined,
  info: PictureInfo | undefined,
): string {
  return editDataPairs(link, picture, info)
    .map(([name, value]) => ` data-${name}="${escapeHtml(value)}"`)
    .join("");
}

/** `editData`'s attributes as name and value pairs, the name without its `data-`. */
export function editDataPairs(
  link: Link,
  picture: ShownPicture | undefined,
  info: PictureInfo | undefined,
): [string, string][] {
  const page = link.snapshot?.title ?? "";
  return [
    ["title", link.title ?? ""],
    ["page-title", titleFits(page) ? page : ""],
    ["version", picture?.version ?? ""],
    ["fit", picture?.fit ?? ""],
    ["own", info?.own ? "1" : "0"],
    ["page-version", info?.pageVersion ?? ""],
    ["page-fit", info?.pageFit ?? ""],
    ["initials", initialsText(link)],
    ["tags", JSON.stringify(shownTags(link.tags))],
    ["intent", link.intent],
    ["intent-source", link.intentSource ?? ""],
    ["why", link.why?.text ?? ""],
    ["why-source", link.why?.source ?? ""],
  ];
}

export {
  editDialog,
  editLinkScript,
  SHRINK_SIDE,
} from "./edit-dialog.js";
