# Quick find (#360)

Owner ruling (2026-11-22, on #360): a quick-find modal, centred (mockup A), with each row showing title, then the why on its own line, then a small space-or-site line (mockup C). Five matches, then a link to all results; a removable "in <space>" chip from a space page; when nothing matches, "Try different words" and "Ask AI about …"; on a phone, a sheet that fills the screen, with Cancel and a full-width "See all"; a blank field shows nothing. Home keeps its field. Mockups: https://claude.ai/artifact/83s11a1FEo6DPfBCmw4exy

## What it enables

Today the bar magnifier, `/` on pages without a search field, and "Search this space" all go to `/search` (`page.ts` `MAGNIFIER` and `MENU_JS`; `space-page.ts:190`). After this, they open a dialog over the current page that shows the first five of the results `/search` would show for the same words, as you type. Enter opens the highlighted one, and "See all results" goes to `/search` with the same words and space.

## Grounding

OBSERVED (read at 3170531):
- `GET /search` resolves its `tag` through `oldAddress` and `findSpaceTag`, then calls `runSearch` (`core/search-links.ts`) with the default limit of 20. It issues a receipt only when there is an `entry`, keep mode is off and `fromOwnPage` holds. It writes nothing (`http.ts:1013-1077`).
- `HybridSearch` reads to a depth of 3 × `limit` (`search/hybrid-search.ts:71`). In the challenge's run, `limit: 5` and `limit: 20` put different links first. So quick find must search with the page's limit and show the first five.
- The results page reports its search as soon as it loads (`searchReportScript`, `open-link.ts`). An opening sends `/links/opened` with the receipt; `logOpenFromReceipt` writes the row first if it is missing, then pairs it. Receipts are held in memory, at most 200 shared by all owners, each for 30 minutes (`core/search-receipts.ts`).
- Ruling 2026-11-15 (#134, `ROADMAP.md`): web searches are logged and a click is paired with its search. Quick find follows it: every search it shows is reported when shown, as the results page does.
- `openedScript(..., true)` reads `main[data-receipt]` once at load (`open-link.ts:29`). Inside the dialog it would send the page's receipt, not the dialog's.
- A word query can return nothing even with many links, for example before the current model's vectors are built (challenge, run). The count-free footer still stands: when there are many links, the page's 20 is the usual answer, so a number would mislead.
- `runSearch` with a blank query lists the newest links. The dialog must not ask with a blank field.
- The Save dialog (#329) is the dialog precedent. Its markup is a body child in `page()`. It takes over the bar's `/save` link only on an unmodified click, and it gives focus back to its opener when it closes (`save-dialog.ts:200-218`). The phone sheet is the `.edit-link` rule in the 600px block of `theme.ts`.
- `src/web/AGENTS.md`: a signed-in read path needs a `READ_ROUTES` entry; a new card builder joins `display-title-cards.test.ts`; a new page script on the copy page joins its scripts.

PROPOSED_NEW:
- **Shared space resolution.** The tag lookup at the start of `/search` (`oldAddress`, `findSpaceTag`, the 404) becomes one helper, used by `/search` and the new route.
- **`GET /search/quick?q=&tag=`** (session, `NO_STORE`). A blank `q` answers the empty fragment with no search. Otherwise the route calls `runSearch` exactly as `/search` does (no limit, so 20) and answers an HTML fragment.
  - The fragment holds the first five links as rows, a "See all results" link (`searchHref(q, { tag })`), and `data-receipt` under `/search`'s conditions.
  - It is the nothing state (Try different words, and Ask AI when on) when there are no links.
  - A moved space answers the fragment for its new key. A missing space answers 404.
  - Rows use the existing helpers (`displayTitle`, `whyText` with the guess label, `linkSpace`, the picture and initials), so escaping and the label rules stay on the server.
  - The rows are a snapshot. A link deleted in another tab stays until the next keystroke.
  - The route joins `READ_ROUTES`, and the row builder joins `display-title-cards.test.ts`.
  - The path joins `CHECKED_PAGES` (`app.ts`), as `/search` does. Web routes have no rate limit; `ROUTE_LIMITS` covers only auth.
  - The fragment uses classes only, no `style=`, because the copy page's CSP allows only the page style's hash (`copy-page.ts:46`).
- **Logging.** #134 ruling (comment 6897915521): "Every web search is logged, not just ones followed by an open." When the dialog shows a fragment with a receipt, it reports that receipt at once (`POST /search/log`), as the results page does. The dialog is treated as a results view of its own, so its opens pair with its search. Whether a passing prefix counts as a web search is for the owner to say, so the reporting sits in one function that is easy to change. "See all" then logs a second row from `/search`; the tests expect two rows, one per showing. The search runs 250ms after typing stops, which keeps passing prefixes few. Opening a row sends `/links/opened` with the receipt of the list the row came from. `openedScript` with receipts reads `closest("[data-receipt]")` at click time instead of `main[data-receipt]` at load. The results page keeps its behaviour, since its rows are inside that `main`.
- **`find-dialog.ts`**: markup, script and CSS.
  - Desktop: centred, 640px, as mockup A. Phone: a sheet that fills the screen, as the Phone mockup.
  - The field is a combobox (WAI-ARIA APG): `role=combobox`, `aria-expanded`, `aria-controls` to a `role=listbox` of `role=option` rows, `aria-activedescendant` and `aria-selected` on the highlighted row. The first row is highlighted.
  - Every input, chip removal, close and reopen raises a turn number. An answer is shown only if its turn is still current; a pending debounce is cancelled on close.
  - ↑ and ↓ move the highlight. Enter calls `.click()` on the highlighted row's anchor, so the open is recorded, opens it in a new tab and closes the dialog, and Escape or Cancel closes. Focus goes back to the opener.
- **Triggers.**
  - An unmodified click on the magnifier opens the dialog; its `href="/search"` stays.
  - `/` opens the dialog on pages without `#q`; Home and `/search` keep focusing their field. The `MENU_JS` handler, its doc comment and its tests change together.
  - On a space page every opener (magnifier, `/`, "Search this space") starts with that space's chip, since the ruling is "when the search starts from a space page". The space page marks its key for the script. "Search this space" keeps its `href`.
  - "Search instead" comes off All links.
  - The Handy shelf's Add and Ask AI's link stay.
  - The dialog goes on every page that has the menu, through `scriptsFor` and `pageScripts`; the copy page's scripts and CSP follow.

Non-goals: no change to `/search` results, the Home field, keep mode or search ranking; no new setting.

Rejected alternatives:
- (a) A full results modal. It would duplicate `/search` and stack over the edit dialog.
- (b) A JSON endpoint rendered in the browser. It would copy the row and label rules into client JS.
- (c) `limit: 5`. It gives a different top five from the page (see above).
- (d) Logging only the last search on close. It contradicts the #134 ruling. It also leaves a shown search exposed to receipt eviction and expiry, which reporting at once avoids.
- (e) Splitting the endpoint into its own PR. It shows nothing until the dialog uses it.

## Tests (red first)

- Route:
  - The first five follow `/search`'s order. This test fails if the route passes `limit: 5`; it uses the challenge's ranking fixture.
  - A blank `q` runs no search, and a moved space resolves. A missing space answers 404.
  - The receipt follows `/search`'s conditions. The route itself writes no log row.
  - Two owners stay apart (`READ_ROUTES`).
- Logging: a shown fragment is reported once. An opening from the dialog sends the dialog's receipt over `/search`, not the page's. The results page still sends its own.
- Shell:
  - Pages with the menu carry the dialog, and the magnifier keeps its `href`.
  - All links has no "Search instead", and the space trigger carries the tag.
  - `/` opens the dialog where there is no `#q`.
- Browser: 1280 and 390 wide, light and dark, keyboard only, and with stale answers arriving out of order.

## PR boundary

One PR. README: the search line. ROADMAP: decision-log entry 2026-11-22 for #360, including the count-free footer.
