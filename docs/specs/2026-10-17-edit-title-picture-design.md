# Edit a link's title and picture: design (2026-10-17)

Issue #145. Owner rulings are from the 2026-10-17 session, recorded in #145 comments 6235920412 (the Handy header) and 6236065873 (design approval and defaults). The approved mockup is the "Edit title & picture" canvas (https://claude.ai/artifact/9jdCBEy3urk539pBSvzaZ8); the owner asked that the implementation follow it, and that it follow DRY and SOLID. This is a dated design record; later ROADMAP.md entries override it.

## Goal

7 of 16 active links on the live library have no picture, and some page titles are long or unclear. From where links are normally shown (search results, All links, space pages; not the Handy shelf) the owner can:
- change a link's title, or go back to the page's own title;
- give a link a picture by choosing, pasting or dropping a screenshot or icon, or go back to the page's picture.

And on the Handy shelf, Add and Show all move into the shelf's header.

## Landing

Two PRs, both closing into #145:
1. **Handy header** (this spec, ROADMAP entry, the header move). Small and mechanical.
2. **Title and picture** (everything else here).

## 1. Handy header (PR 1)

Per the canvas's "Handy" artboard:
- The header is one row: `<h2>Handy</h2>` grows to fill; then **Show all N** (only when more than `SHELF_SIZE` are kept; N is the kept count) as a quiet text button in `--soft`; then **+ Add** as a tinted pill (a plus icon and "Add"). Both are at least 44px tall.
- The `.handy-foot` row under the tiles is removed.
- An empty shelf keeps its line, "Keep links you use often here", with Add beside it, and no header buttons.
- Same header on desktop and phone; on a phone, Add stays reachable without scrolling the row.

Show all keeps its current behaviour (it reveals the hidden tiles). After it is used it disappears, as now.

## 2. Stored data (PR 2)

The next migration adds two tables. `link_images` is unchanged and stays the fetched picture only, so a fetch can never overwrite the owner's picture: the separation is structural, not a guard.

`owner_images`: the picture the owner set.

| Column | Meaning |
|---|---|
| `owner_id`, `link_id` | Primary key; deleted with its link by foreign key, as `link_images` is |
| `content_type` | png, jpeg, gif or webp (same CHECK as `link_images`) |
| `bytes` | At most 2 MiB (same CHECK) |
| `sha256`, `set_at` | As `link_images`' `sha256`, `fetched_at` |

`link_edits`: what the last edit replaced, so Undo can put it back. One row per link at most.

| Column | Meaning |
|---|---|
| `owner_id`, `link_id` | Primary key; deleted with its link |
| `title` | The title before the edit (null = none) |
| `title_changed` | 0 or 1 |
| `picture_changed` | 0 or 1 |
| `content_type`, `bytes`, `sha256` | The owner picture before the edit, or all null when there was none |
| `at` | When the edit was made |

**Which picture shows:** the owner's picture when there is one, else the fetched one, else none. One place decides this: the store's reads.

## 3. Rules (`core/`)

**Titles** (`core/links.ts`): one `normalizeTitle` used by `saveLink`, `updateLink` and the web edit. It trims whitespace; an empty result means no title (the card shows the URL); more than 200 characters is `invalid_input` with "A title can be at most 200 characters." This changes `update_link` and `save_link` for agents: a longer title is now refused instead of stored. Existing stored titles are not rewritten.

**Pictures** (`core/link-edit.ts`, new): `editLink(owner, linkId, edit)` where `edit` has an optional `title` (string or null) and an optional `picture`: `{ set: bytes }` or `"page"` (remove the owner's picture, so the page's shows). It:
- checks the picture with the shared image check (below): one of the four types, at most 2 MiB, at most `MAX_IMAGE_PIXELS`; otherwise `invalid_input` with "That picture can't be used. Try a PNG, JPEG, GIF or WebP under 2 MB.";
- an edit that changes nothing changes nothing (no `link_edits` row);
- otherwise, in one store transaction: writes `link_edits` with the prior state, then applies the title and picture.

`undoEdit(owner, linkId)` puts the `link_edits` state back and deletes the row; with no row it is `conflict` ("Nothing to undo.").

**The image check moves to core.** `readImageHeader` and `MAX_IMAGE_PIXELS` move from `fetch/` to `core/image-type.ts`. They decide which images are acceptable, which is a rule; the fetcher imports them from core. One check, two callers (fetch and upload).

## 4. Store interfaces (SOLID)

- **`LinkImageReader.imageVersions`** returns, per link with a picture, `{ version, own }`: `own` is true when the owner's picture shows. `version` is the version of the picture that shows. Every card builder and the Handy shelf already read this map; they keep reading it. `image()` serves the picture that shows.
- **Fetched-picture presence** for the dialog's wording comes from the same read: `imageVersions` also reports `page: true` when a fetched picture exists. One read, no second query per page.
- **`LinkEditStore`** (new, small): `applyEdit(owner, linkId, edit, prior, at)` and `undoEdit(owner, linkId)`. Implemented by the SQLite store and `FakeStore`, with a shared contract test that includes a two-owner case. `ImageStore` (the fetch pass) does not change: the upload path never reaches the fetch pass's writes (interface segregation).

## 5. Web door

### The card ⋯ menu

One `cardMenu(label, items)` builder in a new `src/web/card-menu.ts`, used by both the Handy shelf's tiles and the cards (one menu markup and one set of `.card-menu` styles; the shelf's `.tile-menu` styles become these). On cards it holds one item, "Edit title and picture…" with the pencil icon from the canvas.

- **Search result card:** the ⋯ sits at the card body's top-right (canvas board 1).
- **All links and space cards:** the ⋯ sits on the picture's top-right on a frosted circle, as on the Handy tiles.
- Cards currently clip with `overflow:hidden`; the menu needs them unclipped, so the picture gets the corner radius instead.
- Each card carries what the dialog needs as data attributes, built by one helper: the title, the page's title (`snapshot.title`), and the picture state (own, page, none).

### The edit dialog

Rendered once per page by `editDialog()` in a new `src/web/edit-link.ts`, as a native `<dialog>` opened with `showModal()` (focus moves in and is held; Esc closes; focus returns to the ⋯). Per canvas boards 2 and 3:
- **Header:** "Edit link"; a 44px close button (desktop).
- **Title:** labelled field. Under it, when the page has a title that differs: "Page's title: “…”" and a **Use it** button that fills the field.
- **Picture:** a preview (the current picture, or the space colour and initials when none); **Choose a picture…** (a file input accepting the four types); **Remove picture** when the owner's picture shows, worded **Use the page's picture** when a fetched one exists; and the hint "Or paste a screenshot (⌘V), or drop a picture here." (desktop only). While a file is dragged over the dialog, the preview gets a dashed outline and says "Drop to use this picture". A picked, pasted or dropped picture shows in the preview labelled "New · not saved yet". Under it: "PNG, JPEG, GIF or WebP. Big pictures are shrunk to fit."
- **Footer:** Cancel and Save (primary).
- **Phone (≤600px):** the same dialog, styled as a bottom sheet with a grabber; Cancel and Save move to the top bar either side of the heading; the close button and paste hint are hidden.

**Shrinking in the browser.** A picture is sent as chosen when it is one of the four types, at most 2 MiB, and at most 1600px on its longest side (so small logos and GIFs are untouched). Otherwise the browser decodes it and re-encodes it at most 1600px on the longest side as WebP (PNG where the browser can't encode WebP), stepping the size down until it fits under 2 MiB. Pictures the browser can decode but the server doesn't accept (for example HEIC on an iPhone) take the same path. The server still checks every file.

**Saving.** Save sends one `POST /links/edit` as `multipart/form-data` with `id`, `title`, and `picture` (a file, `page`, or absent for unchanged). The body is read with the existing `readCapped` at 2 MiB plus 16 KiB, before the session lock as every POST is, then parsed with the platform's `FormData`. On success the page swaps in the card's new title and picture, closes the dialog, and shows the Undo bar: "Link updated" with **Undo**, which sends `POST /links/edit/undo`. Errors show inside the dialog and keep it open.

**Both routes** join `CHECKED_PAGES` and `WRITE_ROUTES_TESTED`, each with a two-owner test (B naming A's link gets 404 and A's rows are unchanged).

### Transparent pictures on the Handy shelf

A Handy postcard's picture gets a white backing, so a transparent logo sits on white and the title keeps its fade and halo (#145 comment 6235422587).

## Testing

Each test is written red first.
- `normalizeTitle`: trim, empty to null, 200 passes, 201 refused; `save_link` and `update_link` both use it.
- `editLink`/`undoEdit` against `FakeStore` and the SQLite store through one contract: the owner picture beats the fetched one; a later fetch (`writeImage`) leaves the owner picture showing; "page" goes back to the fetched picture; Undo restores the prior title and picture; a no-change edit writes no `link_edits` row; another owner's link is untouched.
- The image check refuses SVG, a 2 MiB + 1 byte file and an over-pixel image, from both the fetch and upload callers.
- Routes: 413 over the cap, 400 for a bad picture, 404 for another owner's link with A's rows unchanged, 403 without a same-site Origin.
- Pages: every card on search, All links and spaces has the menu and data attributes; the Handy tiles use the same menu builder; the dialog has the canvas's labels and controls; theme rules for 44px, the sheet layout on a phone and the white backing.
- A Chrome render at 1280px and at 390px (device emulation) of a card with its menu open and of the dialog, compared with the canvas.

## Not in scope

- Agents setting pictures through MCP.
- Removing a fetched picture without setting another.
- Cropping or editing a picture.
- Editing from the Handy shelf.
