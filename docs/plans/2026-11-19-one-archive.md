# One Archive (#338, PR 1 of 3)

Design: `docs/specs/2026-11-19-explore-keep-archive-design.md` ("Landing order" 1, and the "Settled after the builder check" bullet on opening). ROADMAP 2026-11-19 "To explore, To keep, Archive".

Search scope for every sweep below: `command grep -rn` over `src/` (all `.ts`, tests included and counted separately), `src/web/__ask_off__/*.html`, `README.md`, `AGENTS.md`, `src/web/AGENTS.md`, `deploy/`. Docs under `docs/` were swept only to list dated survivors. The worktree had no `node_modules` and no `.trail/learnings` (the main checkout has none either).

## 1. Benefit, and the case reachable today

The owner cannot tell Done with it from Put it away, and Done with it feels irreversible. The only difference between them is a focus-word comeback that never brought back a link the owner wanted.

Two cases are reachable on `main` today (OBSERVED in source):
- **Comeback.** Put it away on a link (`putAwayLink`, `core/worth-a-look.ts`). Then add a focus entry sharing a word with it. Home's featured card leads with it, reading "put away in <month>, mentions …" (`worthALook` → `previewDigest` → `cameBackReasons` in `core/digest.ts`; `reason()` in `web/home-page.ts`). `get_digest` returns it with `came_back`.
- **Opening silently un-archives.** A put-away link opened from search, the Archived view, the saved copy, an `openUrl` or MCP `opened: true` turns active again. On the server this is `putAwayStamp` and `reactivate` in `core/links.ts`. On the page, `openedScript`'s `leaveMarker` (`web/open-link.ts`) takes the card out of the done views and the copy page.

## 2. Invariant map

Every opening reaches one choke point. OBSERVED: `/home/opened` → `markOpened` → `recordOpening`; `/links/opened` → `recordOpening`; `/o/<code>` → `openFromCode` → `recordOpening` (`core/open-codes.ts`); MCP `update_link {opened}` → `updateLink` or `updateLinkWithReceipt`. `recordOpening` is `updateLink({opened: true})`. Both `updateLink` and `updateLinkWithReceipt` call `putAwayStamp`/`reactivate` (`core/links.ts`). `getLinkWithText` (MCP `get_link`) records no opening. Saving an existing URL (`saveLink`, `insertIfAbsent`) never changes state.

### `putAwayAt` (TS field): 98 files, 19 outside tests

| Where | Symbol | Role |
|---|---|---|
| `core/types.ts` | `Link.putAwayAt`, `LinkPatch` | field |
| `core/store.ts` | `LinkExpectation.putAwayAt`, `claimSurfaced`'s `expectedPutAwayAt` | conditional writes, came-back claim |
| `core/fake-store.ts` | `matchesExpectation`, `claimSurfaced` | fake store |
| `core/store-contract.ts` (31), `core/snapshot-store-contract.ts` (1) | shared contract suites | tests (non-`.test` names) |
| `core/links.ts` | `saveLink` insert, `putAwayStamp`, `reactivate`, `buildPatch` (nulls it on any state), `eventsOf` `unlessBefore` | writers, opening reactivation |
| `core/worth-a-look.ts` | `snoozeLink` (allows a put-away link), `StateChange`, `beforeOf`, `putAwayLink`, `archiveLink`, `bringBackLink`, `undoStateChange` | writers, Undo |
| `core/digest.ts` | `DigestReason` came_back, `cameBackEligible`, `cameBackReasons`, `select`, `claimSurfaced(putAwayAt)`, `claimPicked` | comeback |
| `core/tidy-up.ts` | `keepInTidy` expectation | |
| `core/export-format.ts` | schema field and `superRefine` (v≥2 must have it), `manifestLink`, `toNewLink` | export |
| `mcp/output-schemas.ts` | `linkOutput.putAwayAt`, `digestReasonOutput` came_back | wire |
| `mcp/handy.ts` | link view mapping | wire |
| `mcp/guidance.ts` | update_link and came_back text | wire |
| `store/sqlite-store.ts` | row type, insert, `updateSync` set, `claimSync` CASE, `expectationWhere`, `rowToLink` | SQL |
| `web/http.ts` | `savedJson`, `StateChangeJson`, `isStateChangeJson`, `stateChange` | page JSON |
| `web/done-link.ts` | `outOfListsMarker` | |
| `web/copy-end.ts`, `web/save-dialog.ts` | client marker | page JS |
| `web/home-page.ts` | `reason()` came_back | |

### `put_away_at` (SQL): 20 lines

- `store/migrations.ts`: entry 18 (ADD COLUMN) and the `link_events` backfill. Dated, append-only, so these survive.
- `store/sqlite-store.ts`: the six sites above.
- Tests: `put-away-migration.test.ts` (asserts `LATEST_VERSION === PUT_AWAY + 9` and selects `put_away_at` at the latest version, so it breaks), `link-events-migration.test.ts` (seed only), `output-schemas.test.ts`, `home-routes.test.ts`.

### Event kinds

- `put_away` and `stale` are written by `putAwayLink`, `archiveLink` and `eventsOf`. They are unrecorded by `undoStateChange`.
- They are read by `stats.ts` `SET_ASIDE_KINDS` and accepted by `fake-store.ts` `LINK_EVENT_KINDS`, `types.ts` `LinkEventKind` and the `link_events.kind` CHECK at `migrations.ts:343`.
- OBSERVED: no MCP output schema carries a kind string (grep of `mcp/output-schemas.ts`). `get_stats` returns counts only, so the names are internal.

### `came_back` / `cameBack`

- `core/digest.ts`, `core/worth-a-look.ts` (`isCameBack` lead), `web/home-page.ts`, `mcp/output-schemas.ts`, `mcp/guidance.ts:125`.
- Tests: `digest.test.ts`, `worth-a-look.test.ts`, `home-page.test.ts`, `output-schemas.test.ts`, `guidance.test.ts` and others.

### `putAway` (MCP input)

- `mcp/server.ts`: `updateLinkInput.putAway`, the handler's exclusivity check, the call to `putAwayLink`, `fields: ["putAway", …]`. Also `mcp/guidance.ts:49`.
- INFERRED: stored Ask AI change records may hold `"putAway"` in `fields`, but nothing in `src/web` or `src/ai` reads `.fields` by name (grep), so an old reply still renders.

### `PUT_AWAY_*`, `DONE_*` constants (`web/done-link.ts`) and their users

`home-page.ts`, `space-page.ts`, `all-page.ts`, `copy-end.ts`, `copy-page.ts`, `copy-from.ts`, `tidy-script.ts`, `edit-link.ts`, `link-rows.ts`, `pages.ts` (the search result is `faded` only for `DONE_MARKER`), `save-dialog.ts`, `gone-line.ts`, `handy-shelf.ts`.

### Copy

- "Put it away", "Put away", "put away", "Done with it", "Done and put away", "it fits" appear in 37 non-test `.ts` files.
- Also: `core/bookmarks-html.ts` (folder name), `web/profile-stats.ts` ("done with it, put away or not handy"), `web/tidy-tray.ts` (finish line), `web/tidy-step.ts` (choices), `ALREADY_DONE` (`worth-a-look.ts`), `mcp/guidance.ts:79` (GONE_NOTE), `:111` (setAside), `app.ts:89` (`/home/put-away` in `CHECKED_PAGES`).
- `README.md` lines 17, 22, 23, 24, 25, 26, 30, 31, 46, 47, 49, 54, 57, 91. `src/web/AGENTS.md` lines 28, 29, 39, 44, 46, 47, 55. Root `AGENTS.md`: none.

### Opening reactivation

- Server: `putAwayStamp` and `reactivate` (`core/links.ts`), from both update functions.
- Page: the `leaveMarker` argument of `openedScript`, passed only as `PUT_AWAY_MARKER` by `all-page.ts:164`, `space-page.ts:208` (done views) and `copy-page.ts:26`.

### `__ask_off__` fixtures

- 30 files in `src/web/__ask_off__/`, generated by `toMatchFileSnapshot` in `src/web/ask-off-bytes.test.ts`. They are regenerated with `vitest -u` and the diff is read (ROADMAP #191 note).
- 25 of them contain affected copy or `put-away` markup.

### Claims

- OBSERVED: no non-test writer leaves `state='active'` with `put_away_at` set. The writers are `putAwayLink` (archived only), `buildPatch` (nulls it on any state), `reactivate` and `bringBackLink` (null), and the `undoStateChange` guard (refuses active with putAwayAt). The one exception, `toNewLink`, copies a file's value through but has no non-test caller. The column can be dropped without changing any row's state.
- OBSERVED (probe, scratchpad): `ALTER TABLE links DROP COLUMN put_away_at` succeeds after a fresh in-memory `migrate()` to version 27 on SQLite 3.53.4 (the main checkout's better-sqlite3). The row stays archived, and the `link_search` triggers still fire on a later update.
- UNVERIFIED: the same statement against a copy of the live database. Not run.
- OBSERVED: `deploy/deploy.sh` keeps database backups under `data/backups` and compares the live and backup `user_version` (lines 111–201, not traced in full). `migrate()` refuses a schema newer than the code, so a revert after deploy needs that restore. This is true of every migration, not only this one.
- OBSERVED contradiction: the spec says "Export version 3 adds intent and intentSource; drops putAwayAt". But `EXPORT_VERSION` is already 3 (`summarySource`, #160) in `core/export-format.ts`, so the intent bump in PR 2 is version 4.
- INFERRED: `updateLinkInput` is a plain `z.object`, so zod strips an unknown `putAway` key. An agent holding an old tool list that sends `putAway: true` alone gets a success with nothing changed. The MCP SDK's validation path was not read.
- PROPOSED_NEW: every claim in section 3.

## 3. Decisions (recommendation first)

1. **Column: no migration in PR 1; the drop moves to #339** (challenge resolution). Put-away links are already `state='archived'`, so nothing needs a data step. PR 1 stops every write and read of `put_away_at` (`rowToLink` no longer maps it), and #339 drops it in the same migration that adds intent and rebuilds `link_events`. PR 1 then reverts with a plain `git revert`, with no backup restore.
2. **Events: no schema change in PR 1.**
   - Archive keeps recording `stale`, and its Undo unrecords it. The spec lets the plan name the event kinds.
   - Rename the kind to `archived` in PR 2, which must rebuild the `link_events` CHECK anyway for `intent_changed`. That gives one table rebuild instead of two.
   - `put_away` stays in `LinkEventKind`, `LINK_EVENT_KINDS` and `SET_ASIDE_KINDS` as read-only history. Nothing writes it after this PR.
   - Stats counts are unchanged: `setAside` already counts `state='archived'` links.
3. **StateChange / Undo shape:** `{ before: { state, snoozedUntil }, after: { state }, at }`.
   - `undoStateChange` unrecords `stale` at `at` when `after.state` is archived. Its guard against an active side with putAwayAt goes.
   - `StateChangeJson`, `isStateChangeJson` and `stateChange` in `web/http.ts` lose the field. PR 2 adds intent.
   - Accepted limit: a tab loaded before the deploy may Undo a pre-deploy Put it away. `stateChange` rebuilds the change from named fields, so the Undo restores the link correctly and leaves one orphan `put_away` event.
4. **State actions after the merge:**
   - `putAwayLink` goes, along with the `/home/put-away` route (`http.ts` `stateActions`) and its `app.ts` `CHECKED_PAGES` entry.
   - `archiveLink` on any archived link is `ALREADY_DONE`, which now reads "This link is already archived. Reload.". It keeps its current behaviour of leaving `snoozedUntil` alone.
   - `snoozeLink` refuses every non-active link, since its put-away exemption goes.
   - `bringBackLink` on an active link stays a quiet success (tested at `worth-a-look.test.ts`, commit 37c6f06); only its put-away branch goes.
   - `buildPatch` stops writing `putAwayAt`. The `eventsOf` `unlessBefore` becomes `{ state: "archived" }`.
5. **Opening never changes state:** delete `putAwayStamp` and `reactivate`, and drop `openedScript`'s `leaveMarker` parameter and its three callers' argument. Opening still records `lastOpenedAt` and the `opened` event. `markOpened`'s surfaced claim stays until PR 3.
6. **Comeback:**
   - Delete the `came_back` reason, `cameBackEligible`, `cameBackReasons` and the came-back half of `select`.
   - Delete `claimPicked`'s per-link claims, since every pick is now a reading pick. Delete `claimSurfaced`'s `putAwayAt` option and the store's `expectedPutAwayAt` (interface, fake, `claimSync` CASE, contract tests).
   - `worthALook`'s lead becomes the first `focus_words` link. `FocusMatch` is unchanged.
7. **Wire:**
   - The state value stays `archived`. The URLs `/all/done`, `/spaces/done` and `/home/archive` stay, so bookmarks and cursors keep working.
   - Breaking for MCP clients (the spec accepts it, because agents read `tools/list` on each connection):
     - `update_link` loses `putAway`. An old client's `putAway` is refused with a named error (owner ruling, section 6.3). Only that key is refused; the input stays non-strict for every other key.
     - `linkOutput` keeps `putAwayAt`, always null, in PR 1 (challenge resolution: a validating client holding an earlier tool list must keep accepting results, per ROADMAP #39). #339 removes it with export version 4.
     - `get_digest` loses the `came_back` variant.
   - Guidance rewrites:
     - `update_link`: state "archived" means archived, out of the owner's lists and still found by search.
     - Opening never changes state.
     - `GONE_NOTE`: "offer to archive it".
     - setAside: "archived or declined as a kept tool".
8. **Export:**
   - Stay on version 3. `manifestLink` writes `putAwayAt: null` for every link, because `superRefine` requires the key for v≥2.
   - `toNewLink` ignores the field. An old file's put-away entry already has `state: "archived"`, so it reads as archived.
   - PR 2's version 4 drops the key on write.
   - Bookmarks HTML folder: "Archived".
9. **Words.** PR 1 has no mockup; these are Claude's calls, reusing today's Done with it lines.
   - Button and menu row "Archive", with hint "Still findable in search". Working word "Archiving…".
   - Undo bar "**Archived.** Off Home, All links and your spaces. Still findable in search."
   - Grey-line marker "Archived". Views "Archived"; a space's view is "Archived in <space>".
   - Empty states: "Nothing here is archived yet." and "You haven't opened any of the links you've archived."
   - Stats line "archived or not handy". Tidy's finish line "Everything you archive is still saved and still searchable."
   - Every archived search result is faded (`pages.ts`).
   - Constants become `ARCHIVE_LABEL/HINT/WORKING/UNDO/ITEM` and `ARCHIVED`, one name per fact. The icon constant `ARCHIVE` stays.
10. **Menus:**
    - An active card's ⋯ becomes: [Not now on Home rows], Archive, Keep handy / Not handy anymore, Edit, Remove saved copy, Delete. Home's Also today rows drop from seven items to six.
    - The featured card's ⋯ starts at Keep handy (Archive is on the card).
    - A Handy tile's menu is Archive and Not handy anymore, and its "Still using?" second answer is Archive.
    - The gone band is It still works and Archive.
    - The saved copy's end row is Archive, Keep handy, Back. For an archived link it shows "Archived" and Bring it back.
11. **Tidy:**
    - Choices are Keep ("Stays where it is.") and Archive (Archive's lines), with keys 1 and 2. `data-act="stale"` becomes `archive`.
    - Keep and its 180-day wait stay. `keepInTidy` expects `{ state: "active" }`.
    - The "If you're not sure" marker and `.safe` fill go to the owner (section 6).

## 4. Files by layer, and tests

**store/**
- `migrations.ts`: append the drop.
- `sqlite-store.ts`: the six sites above.

**core/**
- `types.ts`
- `store.ts`
- `fake-store.ts`
- `store-contract.ts`
- `snapshot-store-contract.ts`
- `links.ts`
- `worth-a-look.ts`
- `digest.ts`
- `tidy-up.ts`
- `export-format.ts`
- `bookmarks-html.ts`
- `stats.ts`: comment only, if any.

**mcp/**
- `server.ts`
- `guidance.ts`
- `output-schemas.ts`
- `handy.ts`

**web/**
- `done-link.ts`
- `edit-link.ts`
- `home-page.ts`
- `handy-shelf.ts`
- `gone-line.ts`
- `copy-end.ts`
- `copy-page.ts`
- `copy-from.ts`
- `open-link.ts`
- `all-page.ts`
- `space-page.ts`
- `pages.ts`
- `link-rows.ts`
- `card-line.ts` (comment)
- `save-dialog.ts`
- `delete-link.ts` (comment)
- `profile-stats.ts`
- `tidy-step.ts`
- `tidy-script.ts`
- `tidy-tray.ts`
- `theme.ts` (only if `.safe` moves or goes)
- `http.ts`
- `app.ts`

**docs**
- `README.md` (the lines listed in section 2; "Put it away" bullet 25 goes, and 49's "put away in August" example goes).
- `src/web/AGENTS.md` (the lines listed in section 2, plus the Also today seven-item exception and Tidy's "Keys 1, 2 and 3", which become false).
- A dated `ROADMAP.md` sub-bullet under 2026-11-19 recording decisions 1, 2 and 8 and the export-version correction. The 2026-11-19 entry itself is uncommitted in the worktree and owned by the orchestrator.

**Dated survivors, left as written:** `docs/specs/*`, `docs/plans/*`, `docs/design/*` mockups, older ROADMAP entries, migration entry 18 and the `link_events` CHECK.

**Existing tests to change.** 64 `.test.ts` files mention the terms. These assertions are obsolete because the contract changed:
- the put-away and came-back cases in `worth-a-look.test.ts`, `digest.test.ts`, `links.test.ts:504` (inverted: opening leaves it archived), `home-routes.test.ts`, `tidy-tray.test.ts`, `copy-end.test.ts`, `done-link.test.ts`, `all-page.test.ts`, `space-page.test.ts`, `output-schemas.test.ts`, `guidance.test.ts` and `export-format.test.ts`
- the store-contract came-back claim cases
- no migration test changes in PR 1 (no migration); #339 owns `put-away-migration.test.ts` and the offsets when it drops the column

Regenerate `__ask_off__` with `vitest -u` and read the diff: it must show only copy, menu-row and script changes. Unrelated coverage stays.

**New tests, red first.** Each must fail on today's code for the stated reason before the change. Rows 1, 2 and 6 use a put-away link. The type will no longer be able to express one, so run them red before removing the field. Row 7 keeps the formerly-put-away case alive afterwards, at the SQL layer.

| # | Test (file) | Red today because |
|---|---|---|
| 1 | Opening an archived link through `recordOpening`, `openFromCode` and `updateLink {opened}` leaves `state` archived and records `lastOpenedAt` and one `opened` event (`links.test.ts`, `open-codes.test.ts`) | `reactivate` makes it active |
| 2 | An archived link matching a focus entry written after it is absent from `worthALook` and `getDigest`, and nothing is marked surfaced (`worth-a-look.test.ts`, `digest.test.ts`) | it leads with `came_back` and is claimed |
| 3 | On the Archived views and the copy page, opening a card's link leaves the card and its "Archived" marker in place (`all-page.test.ts`/`space-page.test.ts` script tests, `copy-page.test.ts`) | `leaveMarker` takes the card out |
| 4 | MCP `tools/list`: `update_link` has no `putAway`, `get_digest` has no `came_back`, a link has no `putAwayAt`; `update_link {opened: true}` on an archived link leaves it archived (`mcp/http.test.ts`) | all present; reactivates |
| 5 | `/home/undo-state` accepts `{before:{state,snoozedUntil},after:{state},at}` and restores active, with the `stale` event removed (`home-routes.test.ts`) | `isStateChangeJson` requires `putAwayAt`, so it answers 400 |
| 6 | `/home/snooze` on an archived link answers 409, and `snoozedUntil`, `lastSurfacedAt` and the event log are unchanged (`home-routes.test.ts`) | allowed for a put-away link |
| 7 | `SqliteStore` (in `sqlite-store.test.ts`): a row seeded in SQL as archived with `put_away_at` set reads as archived, its opening leaves it archived, and nothing writes `put_away_at` | `reactivate` makes it active |
| 8 | Export: every manifest link has `putAwayAt: null`; a v2 entry with `putAwayAt` set and state archived gives a `NewLink` with no `putAwayAt` and state archived (`export-format.test.ts`) | written from the field; copied through |
| 9 | Bookmarks: the archived folder is "Archived" (`bookmarks-html.test.ts`) | "Done and put away" |
| 10 | `/home/put-away` answers 404, and `CHECKED_PAGES` lacks it (`home-routes.test.ts`, `app.test.ts`) | the route exists |
| 11 | Tidy step has exactly Keep and Archive with keys 1 and 2, and Archive posts `/home/archive` (`tidy-tray.test.ts`) | three choices |

Verification before review:
- `npm run check`.
- Then `command grep -rnE -i "put[ _-]?(it[ _-]?)?away|putAway|came_back|done with it|done and put|DONE_|doneLinkScript|data-act=\"(done|stale)\"|done-empty"` over `src/` (non-test), `src/web/__ask_off__`, `README.md` and `src/web/AGENTS.md` returns only the named survivors (the `put_away` event kind, migration 18, `put_away_at` in `migrations.ts`, `putAwayAt: null` in the export and `linkOutput`). The URL segments `/all/done` and `/spaces/done` stay and are listed as survivors.
- Browser check of Home, a card menu, the Archived view, the saved copy's end and Tidy, on desktop and phone widths.

## 5. One PR

- One PR. Removing the field and removing the behaviour are one piece of knowledge.
- The copy rename makes no sense while Put it away exists, and removing the comeback without the rename leaves two indistinguishable buttons.
- The column drop rides with #339's migration, so PR 1 has none.
- Risk is concentrated in the MCP contract (the `putAway` refusal; `putAwayAt` kept as null). The rest is deletion plus copy.
- Size is large: about 40 source files, about 64 test files and 25 fixtures. The owner waived the size ceiling.

## 6. Owner rulings (2026-11-19)

1. **Tidy's "If you're not sure" marker and its soft `.safe` fill go.** Both remaining choices are reversible.
2. **The words in decision 9 stand.** The owner may still change them at the browser check.
3. **MCP `putAway` is refused, not silently stripped.** This replaces decision 7's "accept the strip". `update_link` with `putAway` present answers a tool error that names the replacement, for example: `putAway is no longer supported; send state "archived" to archive a link.` Nothing is written. Test it red first (in `mcp/http.test.ts`): send `putAway: true` on an active link, assert the error, and assert the link is still active with no new event.
