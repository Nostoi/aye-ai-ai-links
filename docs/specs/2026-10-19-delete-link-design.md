# Delete a link, with Undo: design (2026-10-19)

Issue #126. Rulings already in the issue body (owner, 2026-10-16) are not repeated here: web only, soft delete with Undo and no confirmation, gone means gone after the window, `search_log` left as it is. Owner rulings from the 2026-10-19 session are marked **(owner)**; everything else is the designer's call, marked **(call)**. This is a dated design record; later ROADMAP.md entries override it.

## Goal

The owner can delete a link they saved by mistake, a duplicate, or a test link, from where they already look for per-link actions: the card's ⋯ menu and the Edit dialog. Undo brings it back unchanged for 60 seconds; after that the link and everything attached to it is gone.

## Non-goals

- No MCP or API delete. AIs keep archiving (#126).
- No bulk delete, no "trash" page, no confirmation dialog.
- No delete on Home's cards or the Handy shelf (call; the owner did not object). Those surfaces carry everyday actions, and a destructive row there is one tap from "Keep handy".

## Where the control is (owner)

1. **The ⋯ menu** on every card that shows it: search results, All links, space pages, and now the done pages too (owner). The row is "Delete link", last in the menu, after Edit and the saved-copy rows. Its icon follows `card-menu.ts`'s existing set (call: a trash outline).
2. **The Edit dialog** (owner): a quiet text button "Delete link", apart from Cancel and Save, placed where it shows on both desktop and phone (call). `.edit-foot` is hidden below 600px (`theme.ts` `.edit-foot{display:none}`), so it does not go there: it sits at the bottom of the form body, under the picture fieldset, on every width. Pressing it discards any unsaved title or picture change, closes the dialog, and deletes as the menu does.

Both run one shared client function: post the delete, remove the card from the page (moving focus to the next card, or the list's heading when none), and `showUndo("Link deleted.", …)`. Undo posts the restore and puts the same card back where it was (call: re-insert the removed element; no page reload). If the restore answers 404 (too late), the bar shows core's `not_found` message, in the copy-removal pattern (`core/copy-removal.ts`): "It's too late to undo: the link was deleted for good." (call).

**Done pages get the full menu** (call, following the owner's yes): `/all/done` and `/spaces/done` (and a space's done view) render `editMenu` and `editData` like the active pages, and pass `undo: true` to `page()`. This replaces the 2026-10-17 ruling at ROADMAP.md "The ⋯ menu and the dialog are on search results (archived links included), All links and space pages, not on the done pages or the Handy shelf"; the ROADMAP entry for this work says so. Search results already show the menu on archived links, so this only makes the done pages match.

## Stored data

One migration, a **rebuild of `links`** (call):

- `id INTEGER PRIMARY KEY AUTOINCREMENT`, so an id is never reused. This closes #126 comment 6263878763 and every other reuse path, not only the export's: an AI that read link 40 earlier in a chat and calls `update_link 40` after the purge must get `not_found`, never an unrelated new link; the saved-copy folder is named by link id, and the orphan sweep that removes a folder with no row runs only with the copy pass (every 6 hours by default, `core/copy-pass.ts`) and only for folders over an hour old (`ORPHAN_GRACE_MS`); `search_log.opened_link_id` pairs by id. Without AUTOINCREMENT SQLite gives the next save `max(id)+1`, so deleting the newest link (the usual mistake) hands its id straight to the next save.
- A new column `deleted_at INTEGER` (ms, null = live). Everything else is copied unchanged: columns, `UNIQUE(owner_id,url_key)`, `UNIQUE(owner_id,id)`, the `state` CHECK, defaults.

Rebuild rules (`store/migrations.ts:6-11`; the test helper `rebuild` in `store/sqlite-store.test.ts` already does this for `links`): create `links_new`, copy every row with its id, drop every trigger whose SQL names `links` (call, per the migration rule; today seven: `link_search_links_ins/_upd/_del`, which fire on `links`, and `link_search_lt_ins/_upd/_del` and `link_search_tags_upd`, whose bodies read `links`; find them from `sqlite_master`, don't hard-code the list), drop `links`, rename `links_new` to `links`, recreate those triggers and every index on `links` from their saved `sqlite_master` SQL. Do not rename the old table first: that rewrites every child foreign key to the old name. `migrate()` runs with foreign keys off and `foreign_key_check` after, so child rows survive and are verified. The FTS table `link_search` keeps its rowids because ids are copied. This is the first shipped rebuild, so its test (below) carries the weight.

## Rules (`core/`)

New use cases in one file (call: `core/link-removal.ts`, beside `copy-removal.ts`), with `LINK_UNDO_WINDOW_MS = 60_000`:

- `deleteLink(owner, id)`: in one transaction, sets `deleted_at = now` on a live link and, when the link has an `ok` saved copy, removes it the way "Remove saved copy" does (`status='removed'`, `removed_at = now`, the same value). A missing or already-deleted link is `not_found`.
- `restoreLink(owner, id)`: in one transaction, clears `deleted_at` only when `deleted_at >= now - LINK_UNDO_WINDOW_MS` and the row still exists, and restores the saved copy only when its `removed_at` equals that `deleted_at` and it is not a tombstone (so a copy the owner had removed earlier stays removed); otherwise `not_found` and nothing changes. The link comes back exactly as it was.
- `purgeDeletedLinks(now)`: deletes, for all owners, links with `deleted_at < now - LINK_UNDO_WINDOW_MS` **whose saved copy is absent or already a 0-byte tombstone**. Foreign-key cascades remove tags attached, snapshot and its text, vectors, fetched and owner pictures, the last-edit row, Keep handy, link checks, the saved-copy rows and their picture rows; the FTS triggers remove the search rows.

**Saved-copy files retire through the existing path** (call). Because delete marks the copy removed, the copy pass's `purgeRemoved` deletes its files and tombstones its row after the window, as it does for "Remove saved copy" today, only while the folder is `owned()`, and it keeps the byte accounting right: bytes are freed only once the files are gone. Until then the link row stays, hidden from every reader, and the next link purge removes it. `purgeRemoved` runs on every copy-pass poll (15 s by default) while the folder is ready, so a link with a saved copy is also gone within about 2 minutes; only while the copy folder is unavailable does it wait, hidden, which is the same promise "Remove saved copy" already makes. The orphan sweep (every 6 hours) stays as recovery only.

**Re-saving inside the window when the copy's files still exist** (call): the insert cascades the hidden copy row away, so its files become an orphan folder and the space-used figure under-counts them until the orphan sweep removes them. Accepted: the alternative would break the fresh-save rule above, and the case needs a re-save within a minute of a delete.

**When the link purge runs** (call; replaces "at your next change" said in session, so a deleted link can never linger hidden for days): on a timer every 60 seconds, started and stopped in `start-server.ts` with the other runners, plus once at start-up. It is not part of the copy pass, so a paused copy folder never holds up links without copies.

**Hidden from every reader and writer at once.** The store is the one place that knows a link is deleted; no door or core rule checks `deleted_at`. The class is **every store method that takes a link id or reads `links`**; the builder enumerates it across `store/` and `search/` (every adapter, not only `sqlite-store.ts`) and lists it in the PR.
- **Writes are refused, not just hidden.** Every write keyed by a link id carries the live-link condition in the same statement or transaction, so a hidden link is never changed: `update` (fields and tag replacement), `updateIf`, `fillWhyIfMissing`, openings and surfacing marks, the tool upsert, title/picture edits and their undo, owner pictures, link-check writes ("still works"), and saved-copy remove/restore. Today `updateSync` and `fillSync` write before reading back, so filtering only the read would return `not_found` after changing the hidden link (the design challenge ran this); the store contract's "null means nothing is written" must hold for hidden links too.
- **Byte readers keyed by link id return nothing** for a hidden link: `/images/:id` (fetched and owner pictures), the saved-copy page and its pictures (`copyInfo`, `readCopy`, `copyImage`), `pictureInfo`, and any other per-link read the enumeration finds. These read their own tables without naming `links`, so each gains the join or check.
- `read` (backs `get`, `update`, `updateIf`, `fillWhyIfMissing`) and `readAll` (backs `listLinks`) skip deleted rows, so every core path through them (digest, Handy, gone pick, export, getLink, updateLink, save page, copy reading, link-check existence, worth-a-look actions) treats the link as missing.
- `search/scope.ts` adds `l.deleted_at IS NULL`, covering blank listings, counts, keyword, snapshot-text and meaning search.
- Counts shown anywhere (a tag's or space's link count, the Tags page, All links' totals) exclude a deleted link at once, not only after the purge (call). The only SQL count today is `fts-search.ts`'s `count`, through `scope`; counts built in core from `listLinks` follow `readAll`. The builder confirms no other count reads `link_tags` without joining `links`.
- Direct SQL that joins `links` adds the same condition: `claimSurfaced`, `dueChecks`, `iconCandidates`, `backfillCandidates`, the vector indexer's `rowsAfter` and `writeVector` existence check, the link-edits reads, the saved-copies existence checks, and the tool upsert's existence check. The builder sweeps for every other spelling (`FROM links`, `JOIN links`, `links l`, `owner_id, id` lookups) and lists what it found in the PR.
- Queries that never see `links` (`dueSnapshots`, `pendingImages`, `pendingCopyImages`) may finish work on a hidden link inside the window; that is harmless because the purge cascades. But every writer must survive the link vanishing mid-work (a foreign-key failure or zero rows changed) without crashing its runner or logging an error loop. No production code has ever deleted a link, so the builder checks each writer and adds a test for each runner that can hold an id across a purge.
- **Saving a deleted link's address.** `insertSync`'s `url_key` lookup finds a hidden row: inside the same transaction it deletes that row (cascading) and inserts the new link, which gets a fresh id and `created: true`. The old one's Undo then answers the too-late message. The owner heard this exception in session (2026-10-19) and accepted it; it is the one way Undo ends early.
- The fakes (`core/fake-store.ts`, `fake-search.ts`, `fake-saved-copies.ts`) and the contract suites get the same behaviour, tested through the contracts.

## Page cursors (confirms #126's proposal)

`decode` (`core/link-pages.ts`) refuses a cursor whose link `store.get` cannot find, and after this change it cannot find a deleted one either. Core distinguishes a well-formed cursor naming no live link (`not_found`) from a malformed or mismatched one (`invalid_input`, unchanged). The web answers `not_found` with a redirect to the same list's first page (same order, same done view, same space); `show-older.ts` already follows a redirected answer as a normal navigation, so the page restarts from the newest links instead of appending a duplicate first page or showing the error page. `list_links` keeps answering its existing "doesn't fit" error text for both, so the AI lists again. No store read of deleted rows is added for this.

## Doors

- `POST /links/delete` and `POST /links/restore`, body `{ id }` validated with `linkId`, signed-in, 204 on success, 404 on `not_found`. Both join `CHECKED_PAGES` in `src/app.ts` and `WRITE_ROUTES_TESTED` in `src/mcp/isolation.test.ts`, each with a two-owner test (B cannot delete or restore A's link; A's link unchanged).
- No MCP change. Tool descriptions are not changed; `get_link`/`update_link` on a deleted id already answer `not_found` through `store.get`.

## Export

`listLinks` skips deleted links, so a link deleted before a build starts is not exported. A link deleted while a build runs: the build already captured its row, so the link is written as captured, and its per-link reads (now hidden) return nothing, so it is written without pictures or copy rather than failing (builder confirms what `export.ts` does today when a read comes back empty and makes it so if needed). Because ids are never reused, no read can return another link's files.

**A ready export is a snapshot** (call, put to the owner): an export already built keeps the links it had until its existing 24-hour expiry, like a file already downloaded. Deleting a link does not rebuild or revoke it.

## Tests (red first)

1. Migration: a database at the previous version with links, tags, snapshots, vectors, pictures, checks, saved copies and keyword index rows migrates with every child row intact, `foreign_key_check` clean, keyword search still finding the links, and `sqlite_master` showing AUTOINCREMENT and every trigger that named `links` before the migration, with identical SQL.
2. Id reuse: save, delete the highest id, purge, save again; the new id is greater. (Fails today.)
3. Hidden at once: after `deleteLink`, the link is absent from `get`, `listLinks`, search (keyword, snapshot text, meaning), counts, digest, Handy, `list_links`, `get_link`, and its card is not on `/all`, a space, search results or Home.
4. Undo: restore inside the window brings back the same link with its tags, why, pictures, Keep handy entry and saved copy; restore after the window, or after a purge, is `not_found` and changes nothing.
5. Purge: after the window the link's rows in every child table are gone (assert each table), and other links and other owners are untouched. A deleted link with a saved copy keeps its hidden row until the copy pass has removed its files; byte accounting never drops while its files remain; after the copy pass, the next purge removes it.
5a. Hidden writes: `update` (with tags), `updateIf`, `fillWhyIfMissing`, an edit, a tool upsert, "still works" and saved-copy remove/restore on a hidden link return missing **and** change nothing (assert the rows, then Undo and assert the link is exactly as before the delete).
5b. Hidden bytes: `/images/:id`, the copy page and a copy picture answer 404 for a hidden link.
5c. Undo of a link whose copy the owner had removed earlier leaves that copy removed.
6. Re-save during the window: fresh id, `created: true`, old link's restore is `not_found`.
7. Cursors: Show older after deleting the cursor's link redirects to the same list's page one (inside the window and after the purge); a malformed cursor is still a 400.
8. Runners: each runner that can hold a link id survives that link's purge mid-work.
9. Web: the menu row and the dialog button both delete and show the bar; the dialog's Delete is rendered outside `.edit-foot` (shown at phone width); done pages show the menu and the bar; two-owner route tests.

## Same-PR obligations

- `README.md`: deleting a link from the web page.
- `ROADMAP.md`: a dated decision-log entry for this design (including the done-pages reversal and AUTOINCREMENT), and the Later order ruled 2026-10-19 (#126 comment 6268810403).
- `src/web/AGENTS.md` if a web rule changes (the done pages now show the menu).

## Left to the builder

The icon, the exact purge timer wiring, and the PR split (suggested: 1. migration + store + core + purge; 2. web controls, done pages, cursors, README).
