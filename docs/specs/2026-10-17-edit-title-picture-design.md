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

**The header's buttons stay inside the refreshed fragment.** The shelf script swaps `#handy-shelf`'s contents after each action and finds Show all inside it, so the buttons are rendered inside `#handy-shelf`, not beside the static `<h2>`. The section is a grid: the `<h2>` takes the first row's first column; `#handy-shelf` is `display:contents`, so its header-actions element sits in the first row's second column and the tiles span the second row. The `<h2>` stays outside the swap, so it keeps its focus role and label. After any action the count, Show all and the empty-state line are re-rendered with the tiles.

## 2. Stored data (PR 2)

The next migration adds two tables. `link_images` is unchanged and stays the fetched picture only, so a fetch can never overwrite the owner's picture: the separation is structural, not a guard.

`owner_images`: the picture the owner set.

| Column | Meaning |
|---|---|
| `owner_id`, `link_id` | Primary key; deleted with its link by foreign key, as `link_images` is |
| `content_type` | png, jpeg, gif or webp (same CHECK as `link_images`) |
| `bytes` | At most 2 MiB (same CHECK) |
| `sha256`, `set_at` | As `link_images`' `sha256`, `fetched_at` |

`link_edits`: what the last edit replaced and what it wrote, so Undo can put it back only while nothing has changed since. One row per link at most.

| Column | Meaning |
|---|---|
| `owner_id`, `link_id` | Primary key; deleted with its link |
| `edit_id` | A random id for this edit, returned to the page; Undo must name it |
| `title_changed`, `picture_changed` | 0 or 1 |
| `prior_title`, `written_title` | The title before and after (null = none), when the title changed |
| `prior_content_type`, `prior_bytes`, `prior_sha256` | The owner picture before the edit, or all null when there was none |
| `written_sha256` | The owner picture's sha256 after the edit, or null when the edit removed it |
| `at` | When the edit was made |

**Which picture shows:** the owner's picture when there is one, else the fetched one, else none. One place decides this: the store's reads.

## 3. Rules (`core/`)

**Titles** (`core/links.ts`): one `normalizeTitle` used by `saveLink`, `updateLink` and the web edit. It trims whitespace; an empty result means no title (the card shows the URL); more than 200 characters is `invalid_input` with "A title can be at most 200 characters." This changes `update_link` and `save_link` for agents: a longer title is now refused instead of stored. Existing stored titles are not rewritten, and only a title that is being written is checked: an edit that leaves the title alone never checks or rewrites it.

**MCP keeps refusing before writing.** `update_link` writes handy before the link, so a refusal after handy would leave a half-done update. The tool already checks tags before the handy write (`normalizeTags`, src/mcp/server.ts); it checks the title with `normalizeTitle` in the same place.

**Pictures** (`core/link-edit.ts`, new): `editLink(owner, linkId, edit)` where `edit` has an optional `title` (string or null) and an optional `picture`: `{ set: bytes }` or `"page"` (remove the owner's picture, so the page's shows). It:
- checks the picture with the shared image check (below). The check reads the file's header: one of the four types, at most 2 MiB, at most `MAX_IMAGE_PIXELS`. It does not decode the image. Otherwise `invalid_input` with "That picture can't be used. Try a PNG, JPEG, GIF or WebP under 2 MB.";
- inside one store transaction, reads the current title and owner picture, compares them with the edit, and if nothing would change writes nothing and returns no edit id (the page shows no Undo);
- otherwise, in that same transaction, writes the `link_edits` row (prior state read inside the transaction, written state, a new `edit_id`), then applies the title and picture, and returns the `edit_id`.

`undoEdit(owner, linkId, editId)` follows `restoreTool`'s rule (src/core/tools.ts): inside one transaction it puts the prior state back and deletes the row only when the row's `edit_id` is `editId` and the link still holds what the edit wrote (the written title, when the title changed; the written owner picture's sha256, or none, when the picture changed). Otherwise it is `conflict` with "This link changed since, so nothing was undone." and nothing changes. A newer edit from another tab replaces the row, so the older tab's Undo conflicts; an agent's later title change makes the title differ, so it conflicts too.

**The image check moves to core.** `readImageHeader` and `MAX_IMAGE_PIXELS` move from `fetch/` to `core/image-type.ts`. They decide which images are acceptable, which is a rule; the fetcher imports them from core. One check, two callers (fetch and upload).

## 4. Store interfaces (SOLID)

- **`LinkImageReader.imageVersions` keeps its shape**: the version of the picture that shows. Its callers (the web routes and `homeSpaces` in src/core/spaces.ts, for the space mosaics) change nothing, and the owner's picture reaches every one of them, because the precedence lives in this one read. `image()` serves the picture that shows.
- **`LinkImageReader.pictureInfo(owner, linkIds)`** (new): per link, `{ own: boolean, pageVersion: string | null }`, the dialog's wording and the fetched picture's version. Only pages with the edit menu call it. `image()` takes an optional `which: "page"` that serves the fetched picture, so the dialog can preview "Use the page's picture"; the image route reads it from `?page=1`, owner-scoped as now.
- **`LinkEditStore`** (new, small): `applyEdit(owner, linkId, edit, at)` returning an edit id or null, and `undoEdit(owner, linkId, editId)`. Both read and write inside one transaction. Implemented by the SQLite store and `FakeStore`, with a shared contract test that includes a two-owner case. `ImageStore` (the fetch pass) does not change: the upload path never reaches the fetch pass's writes (interface segregation).

## 5. Web door

### The card ⋯ menu

One `cardMenu(label, items)` builder in a new `src/web/card-menu.ts`, used by both the Handy shelf's tiles and the cards (one menu markup and one set of `.card-menu` styles; the shelf's `.tile-menu` styles become these). On cards it holds one item, "Edit title and picture…" with the pencil icon from the canvas.

- **Search result card:** the ⋯ sits at the card body's top-right (canvas board 1).
- **All links and space cards:** the ⋯ sits on the picture's top-right on a frosted circle, as on the Handy tiles.
- Cards currently clip with `overflow:hidden`; the menu needs them unclipped, so the picture gets the corner radius instead.
- Each card carries what the dialog needs as data attributes, built by one helper used by all three card builders: the title, the page's title (`snapshot.title`), and `pictureInfo`. Cards added to a page later come from the same builders, and the menu script is delegated from the list, so they get the menu too.
- **Active pages only.** Search results, All links and space pages get the menu. The archived pages (`/all/done`, `/spaces/done`) don't: they have no Undo bar or card scripts today.
- "Use it" copies the page's current title into the field once; it doesn't follow later changes to the page.

### The edit dialog

Rendered once per page by `editDialog()` in a new `src/web/edit-link.ts`, as a native `<dialog>` opened with `showModal()` (focus moves in and is held; Esc closes; focus returns to the ⋯). Per canvas boards 2 and 3:
- **Header:** "Edit link"; a 44px close button (desktop).
- **Title:** labelled field. Under it, when the page has a title that differs: "Page's title: “…”" and a **Use it** button that fills the field.
- **Picture:** a preview (the current picture, or the space colour and initials when none); **Choose a picture…** (a file input accepting the four types); **Remove picture** when the owner's picture shows, worded **Use the page's picture** when a fetched one exists; and the hint "Or paste a screenshot (⌘V), or drop a picture here." (desktop only). While a file is dragged over the dialog, the preview gets a dashed outline and says "Drop to use this picture". A picked, pasted or dropped picture shows in the preview labelled "New · not saved yet". Under it: "PNG, JPEG, GIF or WebP. Big pictures are shrunk to fit."
- **Footer:** Cancel and Save (primary).
- **Phone (≤600px):** the same dialog, styled as a bottom sheet with a grabber; Cancel and Save move to the top bar either side of the heading; the close button and paste hint are hidden.

**Shrinking in the browser.** A picture is sent as chosen when it is one of the four types, at most 2 MiB, and at most 1600px on its longest side (so small logos and GIFs are untouched). Otherwise the browser decodes it and re-encodes it at most 1600px on the longest side as WebP (PNG where the browser can't encode WebP), stepping the size down until it fits under 2 MiB. Pictures the browser can decode but the server doesn't accept (for example HEIC on an iPhone) take the same path. The server still checks every file. The latest pick wins: a slower earlier conversion that finishes later is dropped. While a conversion runs, Save is disabled and the preview says "Preparing…". If the browser can't decode the file, the dialog says so and keeps the previous preview.

**Saving.** Save sends one `POST /links/edit` as `multipart/form-data` with `id` and only what the owner changed: `title` when the field differs from the title the dialog opened with, and `picture` (a file, or `page`) when the picture changed. Nothing changed: the dialog just closes. The body is read with the existing `readCapped` at 2 MiB plus 16 KiB, before the session lock as every POST is, then parsed with the platform's `FormData`. On success the server answers with the card's new title, picture version, `pictureInfo` and the edit id; the page updates the card from that answer (not from what it sent), closes the dialog, and, when there is an edit id, shows the Undo bar: "Link updated" with **Undo**, which sends `POST /links/edit/undo` with the id and the edit id and updates the card from its answer. Errors show inside the dialog and keep it open; an Undo conflict shows its message in the Undo bar.

**Both routes** join `CHECKED_PAGES` and `WRITE_ROUTES_TESTED`, each with a two-owner test (B naming A's link gets 404 and A's rows are unchanged).

### Transparent pictures on the Handy shelf

A Handy postcard's picture gets a white backing, so a transparent logo sits on white and the title keeps its fade and halo (#145 comment 6235422587).

## Testing

Each test is written red first.
- `normalizeTitle`: trim, empty to null, 200 passes, 201 refused; `save_link` and `update_link` both use it.
- `update_link` with a 201-character title and a handy action: refused, and neither the link nor its handy state changes.
- `editLink`/`undoEdit` against `FakeStore` and the SQLite store through one contract: the owner picture beats the fetched one; a later fetch (`writeImage`) leaves the owner picture showing; "page" goes back to the fetched picture; Undo restores the prior title and picture; a no-change edit writes no `link_edits` row and returns no edit id; another owner's link is untouched.
- Stale Undo: edit A then edit B on one link, then Undo with A's edit id, conflicts and B's title and picture stay; an edit followed by an `updateLink` title change, then Undo, conflicts and keeps the agent's title.
- A picture-only edit on a link whose stored title is 201 characters succeeds and leaves the title as it was.
- The spaces mosaic and every card show the owner's picture's version, and `/images/:id` serves it; `?page=1` serves the fetched one.
- Handy header: with nine kept tools, Show all is in the header and disappears after use; after removing a tool the count and buttons re-render; empty to one and one to empty switch between the empty line and the header buttons.
- The image check refuses SVG, a 2 MiB + 1 byte file and an over-pixel image, from both the fetch and upload callers.
- Routes: 413 over the cap, 400 for a bad picture, 404 for another owner's link with A's rows unchanged, 403 without a same-site Origin.
- Pages: every card on search, All links and spaces has the menu and data attributes; the Handy tiles use the same menu builder; the dialog has the canvas's labels and controls; theme rules for 44px, the sheet layout on a phone and the white backing.
- A Chrome render at 1280px and at 390px (device emulation) of a card with its menu open and of the dialog, compared with the canvas.
- In the browser: a slow first pick followed by a fast second keeps the second; an undecodable file keeps the previous preview.

PR 2 also updates README.md (what the owner can now do, and the title limit for agents), ROADMAP.md, and removes the old `fetch/` image-check module and the shelf-only menu styles it replaces.

## Not in scope

- Agents setting pictures through MCP.
- Removing a fetched picture without setting another.
- Cropping or editing a picture.
- Editing from the Handy shelf.
