# #223 step 4, PR B: the end buttons on the saved-copy page

Branch `issue-223-end-buttons`, from main 03d3017. It runs alongside step 3 (the reader's look, branch `issue-223-reader-look`). That branch owns the article and `copy-markdown.ts`. This one owns only what comes after the article.

PR A's plan (`docs/plans/2026-10-21-reader-frame.md`) outlined this PR.

## What it enables

Today, once you finish reading a copy, the only way to act on the link is to go back to a list and use the ⋯ menu. After this PR, the end of the copy asks "Finished with this link?" and offers the menu's actions there, each with Undo.

## Grounding

**OBSERVED**
- **`copyPage` (`src/web/copy-page.ts`):**
  - It renders `<main class="copy" id="copy-frame" data-id>`, holding the nav, h1, grey line, why and the article, then `OPENED = openedScript(FRAME_ID, "/links/opened")` (no leave marker).
  - `copyScripts = [...pageScripts({ menu: true }), scriptText(OPENED)]`. `COPY_HEADERS` hashes them.
  - `form-action 'none'` and `connect-src 'self'` stay.
- **`page.ts`:**
  - `pageScripts` returns `[undo, menu, …ask]` for the given options.
  - `UNDO_BAR` sits inside `<div role="status">`.
  - `showUndo(message, undo, title)` moves focus to Undo. On close, it returns focus only if the bar had focus.
- **`doneLinkScript` (`done-link.ts`)** needs `CARD_FETCH` (`post`, `failure`, `whileBusy`, from `tell-why.ts`), `showUndo` and a page-global `takeOut`.
  - `stateCard(card, act)` posts `STATE_ACTS[act].route`.
  - On 200 it calls `takeOut(listRoot, card, false)`, then `showUndo`.
  - Undo posts `/home/undo-state`, then calls `putBack()` on a 204.
  - A refusal goes to the error element through `failure`.
  - Its own listener matches only `.card-menu button`. Home's buttons call `doneCard` and `stateCard` from their own listener.
- **`takeOut` in `delete-link.ts`** hides the card and focuses the next card or the page h1. On the copy page it would hide `<main>`, so it does not fit.
- **`keepHandyScript` (`keep-handy.ts`)** listens for `[data-handy] button[data-act]`, with `card = closest("[data-id]")`, and uses the shared `whileBusy`.
  - It toggles `button[data-act=keep]`, `[data-handy] .handy-on` and the card menu's row.
  - It focuses `.card-menu summary` only when there's no `[data-handy]` control. So the end row must contain a `[data-handy]` control with `.handy-on`.
- **`handyControl`** returns `""` for a link that isn't active. Its "Handy · " prefix and `small-actions` classes style it as underlined text, which is not what the owner ruled.
- **`openedScript(root, route, leaveMarker)` (`open-link.ts`):** after a 2xx opening, if the card's `.card-line > :last-child` text equals `leaveMarker`, it calls `takeOut(root, card, false)`. The done views use this with `PUT_AWAY_MARKER`.
- **Core rules:**
  - An opening brings back a put-away link (archived with `putAwayAt`). A stale link stays stale (`src/core/links.ts`).
  - Bring it back on an already active link answers 200 with no change.
  - Put it away refuses a link that isn't active (`ALREADY_DONE`).
  - Undo gives a 409 `CHANGED_SINCE` when the link changed in between.
- **The copy route (`src/web/http.ts`)** loads no Keep handy state. `handyOf(deps, owner, link)` (`src/core/tools.ts`) exists.
- **CHECKED_PAGES:** every route used here is already in it: `/home/archive`, `/home/put-away`, `/home/bring-back`, `/home/undo-state`, `/tools/keep`, `/tools/not-handy`, `/tools/undo` and `/links/opened`. No new routes.
- **Origin:** a `fetch()` call has mode `cors`. The Fetch spec sets `Origin: null` under `no-referrer` only when the mode is not `cors`, so the copy page's posts carry the real Origin, and `originRefused` (`src/auth/http.ts`) passes them. This was reasoned during PR A's review. This PR's browser check must observe it: a 2xx and the request's `Origin` header.
- **Test kit:** `runPage` (`opened-test-kit.ts`) runs every script except the one containing "sign-out" in one scope, so a duplicate `const` throws.

**The mockup (ReaderDesktop, ReaderStress):**
- Under the sheet, 28px below it, there is one wrapping flex row with a 10px gap.
- The row holds a grey 15px label, "Finished with this link?", followed by the buttons.
- The buttons are It's stale, Put it away and Keep handy. Each is a 44px pill with 18px side padding, no border, and a soft grey fill (`#EDEAE3`, the account button's fill), with ink text at 15px.
- Under the row, 16px below it, is the grey "← Back to <place>" link, 44px tall.

## Decisions

1. **The "card" is `<main id="copy-frame" data-id>`.**
   - `stateCard`, Keep handy and `openedScript` all resolve to it, so they share one busy mark.
   - Rejected: a separate end card with its own `data-id`, which gives two busy marks for one link.
2. **The copy page has its own `takeOut(listRoot, card, remove, act)`** in its end script. It switches the end row by `act` and never hides `<main>`:
   - `archive` shows the out group with the marker "Stale";
   - `put-away` shows the out group with "Put away";
   - `bring-back`, or no act (an opening), shows the active group.
   
   When `act` is given, it focuses the shown group's line (`tabindex="-1"`), so the Undo bar's focus return stays at the bottom. An opening moves no focus.

   It returns a `putBack` that restores the previous group, marker and focus.
3. **One seam in `done-link.ts`:** `takeOut(listRoot, card, false)` becomes `takeOut(listRoot, card, false, act)`. The JSDoc for `doneLinkScript` and for `delete-link.ts`'s `takeOut` notes the 4th argument, which that `takeOut` ignores.
   - It's needed because only `stateCard` knows which act happened.
   - Rejected: reading `CARD_FETCH`'s private busy set, copying `stateCard`, or a custom event.
4. **Following an opening:** `OPENED = openedScript(FRAME_ID, "/links/opened", PUT_AWAY_MARKER)`. The out group's line is `<p class="card-line copy-end-line" tabindex="-1"><span>Out of your lists</span><span>Put away|Stale</span></p>`, so its last child is the marker, as on a list row.
   - After a 2xx opening, a put-away row switches to active. A stale one doesn't. A failed opening changes nothing.
   - This mirrors core as the done views do.
   - Rejected: reloading (loses the reading position), a new state route, changing `/links/opened`'s answer, and an optimistic swap.
   - Known narrow race: if the opening's answer arrives before an in-page Put it away has been applied on the server, the row can say Put away while the link is active. It's harmless, because Bring it back on an active link is a 200 with no change.
5. **On load the row comes from server state.** The page is `no-store`. Both groups are always rendered, and one is `hidden`:

   | State | Row |
   |---|---|
   | active | label, then It's stale, Put it away and Keep handy (Not handy anymore hidden) |
   | active and kept | Keep handy hidden, Not handy anymore shown |
   | put away | "Out of your lists · Put away", then Bring it back |
   | stale | "Out of your lists · Stale", then Bring it back |
   | missing or unreadable copy | the row as normal |
   | deleted, or another owner's link | 404, no row |

6. **Keep handy is the row's own control, built to `keepHandyScript`'s DOM contract:** `<span data-handy><button type="button" data-act="keep">Keep handy</button><span class="handy-on" hidden><button type="button" data-act="not-handy">Not handy anymore</button></span></span>`. Its texts and acts come from `KEEP_ITEM` and `NOT_HANDY`. It's always rendered, so it's there after Bring it back.
7. **The buttons come from the menu's items, in the ⋯ menu's order:** `DONE_ITEM`, `PUT_AWAY_ITEM`, then keep or not-handy. When the link is out of your lists, `BRING_BACK_ITEM` is shown instead. They are `type="button"`, have no icons, and aren't `.primary`. The only new text is "Finished with this link?".
8. **The Undo bar is the only live region.** Its `role="status"` announces each action.
9. **Scripts:**
   - `COPY_END_SCRIPT` is one constant `<script>` holding `CARD_FETCH`, the copy page's `takeOut`, `doneLinkScript(…)`, `keepHandyScript(…)` and a small listener that sends a `button[data-act]` in `STATE_ACTS` to `stateCard(button.closest("[data-id]"), act)`.
   - The script holds no link data.
   - `COPY_PAGE_OPTIONS = { menu: true, undo: true }` serves both `page()` and `pageScripts()`.
   - `copyScripts = [...pageScripts(COPY_PAGE_OPTIONS), scriptText(OPENED), scriptText(COPY_END_SCRIPT)]`.
   - Errors show in an error element in the row.
10. **Boundary.** New `src/web/copy-end.ts` holds `copyEnd(link, handy, back)`, `backLink(back)` and `COPY_END_SCRIPT`. `copy-page.ts` changes only:
    - its imports, `OPENED`, `copyScripts` and the options;
    - a 4th parameter, `handy: HandyView | null = null`;
    - the nav, which uses `backLink(back)`;
    - one line, `${copyEnd(link, handy, back)}`, after the article inside `<main>`.
    
    The section is `<section class="copy-end" id="copy-end" aria-label="Finished with this link?">`. The second Back sits after the row, inside the section.
11. **Styles: one contiguous `theme.ts` block at the end of `PAGE_STYLE`,** after everything else. It needs no phone line, because the row wraps.
    - `.copy-end{margin-top:28px}`
    - `.copy-end-acts{display:flex;flex-wrap:wrap;align-items:center;gap:10px}`
    - `.copy-end-label{font-size:15px;color:var(--soft);margin-right:6px}`
    - `.copy-end-acts button{min-height:44px;padding:0 18px;border:0;border-radius:999px;background:<the account button's fill token>;color:var(--ink);font-size:15px}`
    - `.copy-end [data-handy],.copy-end .handy-on{display:contents}`. The `[hidden]` `!important` rule still wins.
    - `.copy-end-line{min-height:44px;margin:0}`
    - `.copy-end .back-link{margin-top:16px}`
    
    Use existing colour tokens. Add none unless no token holds the fill.

## Red-first tests

**`src/web/copy-end.test.ts`** (new). Use `copyPage(view, NOW, BACK, handy)`, `parseHTML` and `runPage`.

*Markup:*
1. **Active:**
   - the label text;
   - the visible `[data-act]` values are `archive`, `put-away` and `keep`, with the menu items' texts;
   - not-handy sits inside a hidden `.handy-on`;
   - no `.primary`;
   - all buttons have `type=button`;
   - the out group is hidden.
2. **Kept:** keep is hidden and `.handy-on` is shown.
3. **Put away:**
   - the active group is hidden;
   - the line spans read "Out of your lists" and "Put away";
   - the only visible button is bring-back;
   - the hidden active group still holds keep.
4. **Stale:** the line reads "Stale".
5. **Second Back:** in every state, `#copy-end a.back-link` has the same href and text as the nav's.
6. **Layout and attributes:**
   - `#copy-end` comes after `article`;
   - there is exactly one `.card-line`;
   - `#undo-bar` sits inside `[role=status]`;
   - there are no `[style]` attributes.
7. **Missing or unreadable copy:** the row still renders.

*Behaviour:*

8. **It's stale (200, with the change):**
   - only `/home/archive {id}` is sent;
   - the out group shows "Stale";
   - the bar shows `STALE_UNDO`;
   - focus goes to the line, then to Undo;
   - Undo (204) sends `/home/undo-state` with that change, restores the active group and refocuses.
9. **Put it away:** the same, with `/home/put-away`, `PUT_AWAY_UNDO` and "Put away".
10. **Bring it back from put away:**
    - `/home/bring-back` is sent and the bar shows `BRING_BACK_UNDO`;
    - the active group shows, Keep handy included;
    - Undo restores "Put away".
11. **A refusal (409 `ALREADY_DONE`):** the error text shows, the groups don't change, and no bar appears.
12. **A refused Undo (409 `CHANGED_SINCE`):** the error shows and the row stays out.
13. **Keep handy:** `/tools/keep` is sent, keep and not-handy swap, and the bar shows its text. Undo sends `/tools/undo` and swaps back. Not handy anymore mirrors this.
14. **One action at a time:** while Put it away is waiting, Keep handy and It's stale send nothing.
15. **An opening on a put-away page (204):**
    - only `/links/opened` is sent;
    - the active group shows;
    - no bar appears;
    - no focus moves.
16. **Put it away on the page, then Open:** the row is active. A later Undo gets 409 `CHANGED_SINCE`, the error shows, and the row stays active.
17. **An opening on a stale page:** the row stays Stale.
18. **A refused or failed opening on a put-away page:** the row stays put away, so the swap is not optimistic.
19. **An opening on an active page:** nothing changes.

**`src/web/copy-routes.test.ts`** (real store)

20. **CSP:**
    - every script on 200, 404 and 503 is hashed;
    - the scripts equal `pageScripts({menu:true,undo:true})`, plus the opening script, plus the end script;
    - the script text is identical for two different links.
21. **State matrix, as real requests,** each checked in the store and on the next GET:
    - keep, then the page shows Not handy anymore;
    - put-away, then the store shows archived with `putAwayAt` set and the page shows the put-away row;
    - opened (204), then the store shows active and the page shows the active row;
    - archive, then opened, then the store is still archived with `putAwayAt` null and the page shows Stale.
22. **Deleted:** the page answers 404 with no `#copy-end`, under the same CSP.
23. **Second Back:** with `?from=/spaces?tag=<owned>`, the second Back's href equals the first's.

**`src/web/theme.test.ts`**

24. The end block's buttons have `min-height:44px` and use only theme variables.

**Regression**

25. `done-link`, `done-pages-script`, `keep-handy` and home tests stay green.

## Tasks

1. Red tests 1–7 and 20, then the `copy-end.ts` markup and the `handy` parameter.
2. Red tests 8–19, then:
   - the `act` argument in `done-link.ts`;
   - `COPY_END_SCRIPT`;
   - `OPENED` with the marker;
   - the page options and `copyScripts`.
3. Red tests 21–23, then load `handyOf` in the copy route.
4. The theme block and test 24. Then regenerate the `__ask_off__` snapshots with `-u`. Whichever of this PR and step 3 merges second merges main and regenerates rather than hand-merging.
5. Records, then `npm run check`.
6. Browser check (done by the orchestrator).

## Records

- **README "Saved copies":** under the article, "Finished with this link?" offers It's stale, Put it away and Keep handy (Not handy anymore once kept), each with Undo. A link out of your lists offers Bring it back. A second Back follows. Opening the site from the page brings a put-away link back to your lists.
- **ROADMAP decision log, 2026-10-21:** PR B of #223's step 4:
  - the order and the quiet style;
  - Bring it back only for a link out of your lists;
  - Undo through the bar;
  - the row follows an opening through `openedScript`'s leave marker;
  - `takeOut` now receives the act.
- **`src/web/AGENTS.md`:**
  - the CSP rule now covers the page's menu and Undo bar (`pageScripts`), its opening script and its end script;
  - the end row runs on the frame's `data-id` busy mark, with the copy page's own `takeOut`, and its buttons are the menu's items.

## Browser check

Run on a local server under the real headers, signed in, with DevTools open.

1. **The row on an active link:**
   - it matches the mockup;
   - every button and both Back links are at least 44px tall;
   - check desktop and 390px widths, in light and dark.
2. **It's stale:**
   - `/home/archive` answers 200, and the request's `Origin` header equals the app's origin;
   - the row reads Stale and the bar shows;
   - Undo answers 204 and the row is active again;
   - after a reload, the row is still active.
3. **Put it away:** after a reload, the row is put away, and `/all/done` shows "Put away".
4. **Open on <site>:** it answers 204, the row turns active without a reload, and `/all` lists the link again.
5. **Stale link, then Open:** the row stays Stale.
6. **Keep handy:** `/tools/keep` answers 200, the Handy shelf shows the link, and Undo answers 204.
7. **Keyboard:**
   - Tab reaches the buttons, then Back;
   - Enter on It's stale moves focus to Undo;
   - when the bar closes, focus returns to the row.
8. **Console:** no CSP violation. A 403 `INVALID_ORIGIN` stops the check: report it, and don't change the referrer policy without the owner.
