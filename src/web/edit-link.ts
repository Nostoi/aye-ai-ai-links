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

const CLOSE = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const PICTURE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.75"/><path d="M20.5 16l-5-5-8.5 8.5"/></svg>`;

/**
 * The edit dialog, once per page with the card menu. It is filled from the card it opens on, by
 * `editLinkScript`. On a phone the theme makes it a bottom sheet: Cancel and Save move to the top
 * bar, and the close button and the paste hint are hidden.
 */
export const editDialog =
  () => `<dialog class="edit-link" id="edit-link" aria-labelledby="edit-link-title">
<form class="edit-form" novalidate>
<div class="edit-grabber" aria-hidden="true"></div>
<div class="edit-head">
<button type="button" class="edit-top" data-edit="cancel">Cancel</button>
<h2 id="edit-link-title">Edit link</h2>
<button type="submit" class="edit-top edit-top-save" data-edit="save">Save</button>
<button type="button" class="edit-close" data-edit="cancel">${CLOSE}<span class="visually-hidden">Close</span></button>
</div>
<label for="edit-title">Title</label>
<input id="edit-title" class="edit-title" name="title" autocomplete="off">
<p class="edit-page-title" hidden><span>Page's title: “<span data-page-title></span>”</span><button type="button" class="edit-use" data-edit="use-title">Use it</button></p>
<fieldset class="edit-picture">
<legend>Picture</legend>
<div class="edit-picture-row">
<div class="edit-preview"><span class="edit-chip" hidden></span></div>
<div class="edit-picture-actions">
<button type="button" class="edit-choose" data-edit="choose">${PICTURE}Choose a picture…</button>
<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-edit="file" hidden>
<button type="button" class="edit-remove" data-edit="remove" hidden>Remove picture</button>
<p class="edit-hint">Or paste a screenshot (⌘V), or drop a picture here.</p>
<p class="edit-hint-phone">Opens Photos, Files or the camera.</p>
</div>
</div>
<p class="edit-types">PNG, JPEG, GIF or WebP. Big pictures are shrunk to fit.</p>
</fieldset>
<p class="edit-error" id="edit-error" role="alert"></p>
<div class="edit-foot">
<button type="button" data-edit="cancel">Cancel</button>
<button type="submit" class="primary" data-edit="save">Save</button>
</div>
</form>
</dialog>`;
