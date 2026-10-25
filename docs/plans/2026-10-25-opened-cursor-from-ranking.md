# Opened cursor from the ranking read (#215)

## Problem (OBSERVED)
`linkPage` (`src/core/link-pages.ts`) ranks ids with `search.search(owner, "", query, limit + 1)`, then reads each link with `store.get`, then builds the `older` cursor from the last shown link's `CURSORS[order].key(link)`. For `opened` that key is `lastOpenedAt`, which `recordOpening` can move forward between the ranking and the read. The cursor then carries the newer time, and the next page (`ORDERS.opened.after` in `src/search/fts-search.ts`: `last_opened_at < ? OR (= ? AND id < ?)`) starts above links already shown.

Reproduced red on both engines by the new test in `src/core/link-pages.test.ts` ("takes an opened page's cursor from its ranking…"). It wraps `search.search` so that B is reopened at 21 000 after the ranking returns. With A, B, C, D opened at 20 000, 19 000, 18 000 and 17 000 and a limit of 2, page 1 is [A, B], and page 2 comes back [A, C] instead of [C, D].

Reachable through every caller of `linkPage`: All links in Recently opened (`src/web/http.ts` `/all?order=opened`), space pages in opened order (`openSpace` in `src/core/spaces.ts`), and MCP `list_links` with `order: "opened"` (`src/mcp/server.ts` → `src/core/list-links.ts`). `decode` accepts the newer time because an opened cursor may name any time at or before the link's last opening. newest and oldest key on `savedAt`, which never changes, so only opened is affected.

## Proposed fix
The cursor's time must come from the same SQL read that ranked the ids.

- **PROPOSED_NEW:** a `LinkListing` interface in `src/core/search.ts`:
  - `list(owner, filters, limit): Promise<{ id: string; at: Date }[]>`, where `at` is the time the order sorts by, as read in the ranking query.
  - Implemented by `FtsSearch`, which selects `l.id` plus the order's sort column, and by `FakeSearch`, which already computes `{ at, id }` positions.
- **Wiring:**
  - `deps.ts` gets `listing: keywordSearch`. It already sets `count: keywordSearch` with the comment "blank listings are keyword search's alone".
  - `linkPage` takes `{ store, listing }`.
- **Cursor:** `linkPage` reads the links as now, but takes the cursor's time from the ranked position of the last shown link, looked up by id because links that vanished are filtered out.
- **Blank queries in `search.search`:** `FtsSearch.search` and `FakeSearch.search` keep their blank-query path, now mapped from `list`, so other blank-query callers are unchanged.
  - **OBSERVED:** the only non-test callers of `search.search` are `src/core/search-links.ts` and `linkPage`.
  - **OBSERVED:** `HybridSearch.search` hands a blank query straight to `fts.search` (`src/search/hybrid-search.ts`).
- **Callers to update:**
  - `src/core/spaces.ts` (passes `Deps`);
  - `src/core/list-links.ts`, whose deps type `{ store, search, count }` becomes `{ store, listing, count }` (MCP passes the full deps);
  - `src/web/http.ts` (passes deps);
  - the test worlds in `link-pages.test.ts` and other tests that build a narrow world for `linkPage` or `listLinks`.

## What the fix guarantees, and what it doesn't
**Guaranteed:** the cursor carries the time the ranking used. An opening recorded between the ranking and the read no longer moves it, so page 2 resumes right after the last shown link's ranked position.

**Not guaranteed:** that `decode` always accepts the cursor, or that pages never repeat. Both still assume openings only move forward, and the Codex challenge disproved that:
- MCP `update_link` with `opened` and `handy` stamps `now` before awaiting the handy write, and the store writes `last_opened_at` unguarded. A newer opening can be overwritten by an older one.
- When that happens, a ranked cursor is refused, or a link already shown repeats.
- This is a base-branch defect, filed as #260, and not fixed here.

**Retained as they are now:**
- Month headings use each link's current `lastOpenedAt`, so a link reopened mid-read sits on its ranked page under its new month.
- A page whose whole ranked window was deleted before the read still ends the walk.

**Consequences this change owns:**
- `McpDeps` (`src/mcp/server.ts`) lists its fields explicitly, so it gains `listing`.
- The web app's deps type gains it too.
- The race test's hook moves onto `listing.list`, and the test asserts the hook ran.

## Rejected alternatives
- **Change `LinkSearch.search` to return positions.** It is implemented by HybridSearch and used by `searchLinks` and test fakes for word queries, where a sort time means nothing.
- **Read the links inside the ranking transaction.** better-sqlite3 is synchronous, but the store and search interfaces are async and separate. Relying on no await between them is fragile, and FakeStore would not model it.
- **Clamp the cursor, for example to `min(read time, the next ranked link's time)`.** The next link may be reopened too, and this does not give the ranked position.

## Non-goals
- Removing `order` and `before` from `SearchFilters` and `LinkSearch`'s contract, now that only the listing pages. A possible cleanup, not needed for correctness.
- A link opened for the first time during a walk is still missed, as `list_links` already documents.
