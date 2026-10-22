# The saved-copy reader's frame: implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** step 4 of #223. Around the article, the copy page gets the app's top bar, one Back / Open line, the title and one grey line, the why, and the three end buttons. Opening the original from the copy page counts as an opening. The page keeps a full CSP, relaxed only to the app's own scripts by hash and `connect-src 'self'`. The owner agreed on 2026-10-21 to run this in parallel with step 2 (tables), with step 3 (the article's look) after both.

Two PRs, in order:
- **PR A (this plan in full):** the CSP script mechanism, the top bar, the Back / Open line with `?from=`, the title, the grey line, the why, and openings.
- **PR B (outlined at the end):** the end buttons. It needs PR A's script mechanism.

## Grounding

What it enables, reachable today: on `/links/<id>/copy` there is no way to move around the app or act on the link. The only way out is the brand link to Home or the browser's Back. Opening the page from there isn't recorded, so Recently opened misses it.

- OBSERVED: `copyPage` (`src/web/copy-page.ts`) calls `page(title, body, { home: true })`, with title `link.title ?? link.url`, a site link with no `data-open`, two grey lines (`Saved copy from …`, `NEUTRAL`) and no why.
- OBSERVED: `COPY_HEADERS` is `default-src 'none'; img-src 'self' data:; style-src 'sha256-<PAGE_STYLE>'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, plus `Referrer-Policy: no-referrer`, `nosniff` and `no-store`. Only `GET /links/:id/copy` (`src/web/http.ts`) sends it, on its 200, 404 and 503.
- OBSERVED: `page()` (`src/web/page.ts`) writes its scripts inline from private constants: `MENU_SCRIPT` with `menu`, `UNDO_BAR`+`UNDO_SCRIPT` with `undo` or `ask`, and the Ask scripts with `ask`. None takes request data. `MENU_SCRIPT` signs out with `fetch("/api/auth/sign-out")`.
- OBSERVED: `openedScript(root, route)` (`src/web/open-link.ts`) posts a click on `a[data-open]` inside `#root` to `route` with its card's `data-id`. `/links/opened` is a signed-in POST in `CHECKED_PAGES` (`src/app.ts`).
- OBSERVED: a page links to a saved copy in exactly two builders: `cardLine` (`src/web/card-line.ts`, "Saved copy") and Home's gone row (`src/web/home-page.ts`, "Read the saved copy"). Search: `copyHref` across `src/`. `cardLine` is called by Home's featured card and its rows, `linkRow` (All links, its done view and space pages), the search result card (`pages.ts`) and Tidy up, which passes no copy.
- OBSERVED: the list pages are `/`, `/all`, `/all/done`, `/spaces?tag=<name>`, `/spaces/done?tag=<name>` and `/search?q=…` (with `tag` and `keep`). Routes in `src/web/http.ts`.
- OBSERVED: `whyText` (`src/web/link-rows.ts`) and `displayTitle` (`src/web/display-title.ts`) are the shared builders for a why and a title.
- OBSERVED: `src/web/AGENTS.md` holds the exception "the saved-copy page runs no script, so its link to the page records no opening (ROADMAP 2026-10-18)" and the CSP rule.

## Decisions

- **Script hashes come from the script constants, never from the rendered page.** Hashing whatever `<script>` the output holds would also allow a script that reached the page through the article. `page.ts` exports `pageScripts(options)`: the list of inline script texts `page()` writes for those options, and `page()` renders from that same list, so the two can't drift. `copy-page.ts` hashes `pageScripts({ menu: true })` and its own script once, at module load, into `COPY_HEADERS`.
- **The new CSP:** today's directives, plus `script-src` with exactly those hashes and `connect-src 'self'` for the sign-out and opening posts. Everything else stays as it is, including `form-action 'none'`, `no-referrer` and `img-src 'self' data:`. The Markdown rendering is untouched.
- **The top bar:** `page(…, { menu: true })` without `ask`, so All links, Spaces and tags, and the account menu (on a phone, the Menu button). The not-found page keeps `home: true`.
- **The Back / Open line** sits above the title: **← Back to <place>** on the left, **Open on <site> ↗** on the right, each at least 44px tall. The Open link opens in a new tab, with hidden " (opens in a new tab)" text. It's an `openLink` (`data-open`) inside an element carrying the link's `data-id`, with `openedScript` for it posting to `/links/opened`. A non-web link has no Open link.
- **Where you came from:** `copyHref(linkId, from?)` adds `?from=<the list page's path and query>`. `cardLine` and the gone row take a `from` from the page that renders them, including rows that Show older appends. The copy route accepts a `from` only when it parses as a same-site path whose path is one of `/`, `/all`, `/all/done`, `/spaces`, `/spaces/done` or `/search`. It keeps only what picks the list and rebuilds the address with the existing builders (`allHref`, `spaceHref`, `searchHref`), never echoing the raw value:
  - a space keeps its `tag` only when `findSpaceTag` finds it in the owner's catalog, else it falls back;
  - a search keeps `q`, and `keep=1`, and its `tag` only when the owner has it (else the tag is dropped);
  - order and page position (`order`, `before`) are dropped, so Back lands on the list's first page in its default order and never on a 400 or 404 (Sol, solution-choice review).
  The label is fixed by the path: Home, All links, Out of your lists (`OUT_OF_LISTS`), the space's name, or your search. Anything else, or none, is **Back to All links**. Tidy up passes no copy, so it needs no `from`.
- **What counts as an opening:** only the frame's Open on <site> link. A link inside the article to the same address isn't recorded: that would mean changing the renderer, and an article rarely links its own address.
- **Title and lines:** the title is `displayTitle(link)`. Making it the page's only `h1` needs the article's headings moved down one level, which is #223 step 3's renderer work. One grey line, "Your copy from <date> · the page may have changed", replaces the two grey lines and `NEUTRAL`. The why shows as `whyText`, 15px in ink, when the link has one.
- **Styles** go in `theme.ts`, with no `style=` attribute. They're only for the new line and the why; step 3 restyles the article.
- **Records:** in `src/web/AGENTS.md`, drop the no-script exception and reword the CSP rule (scripts by hash from `pageScripts`). A ROADMAP decision-log entry ends the 2026-10-18 exception and the 2026-10-20 note that left the copy page out of `displayTitle`, and records the owner's 2026-10-21 ruling to run this step alongside tables. The README's saved-copy lines change if they mention what the page offers.

## Not in PR A

- The end buttons (PR B).
- The article's look (#223, step 3).

## PR A tasks

- [ ] **1. Red tests: CSP** (`src/web/copy-routes.test.ts`):
  - every `<script>` in a served 200 copy page has its content's `sha256` in `script-src`, and `script-src` holds no other hash (the 404, which has no scripts, shares the same static headers);
  - a copy whose Markdown holds `<script>alert(1)</script>` and a `javascript:` link adds no script inside the article and no such link: the page's scripts are exactly those of `pageScripts({ menu: true })` plus the copy page's own;
  - `connect-src 'self'` and today's other directives are present, unchanged;
  - the 404 and 503 answers carry the same headers.
- [ ] **2. Implement `pageScripts`** and the new `COPY_HEADERS`. Changing `page.ts` must leave every other page's HTML byte for byte the same. Prove it with an existing snapshot or a before-and-after comparison test.
- [ ] **3. Red tests: the frame** (`copy-page` tests):
  - the top bar is there, with no Ask AI;
  - the title comes from `displayTitle`, never a raw URL (a link with no title and a snapshot title);
  - there is one grey line;
  - the why shows as `whyText` for an owner's why and an inferred one, and nothing shows with no why;
  - Open on <site> carries `data-open` inside the `data-id` element, and a click posts `/links/opened` (use `opened-test-kit.ts` as the list pages do);
  - a non-web link has no Open link.
- [ ] **4. Red tests: `from`:**
  - each list page's Saved copy link carries its own `from` (All links, its done view, a space page, search with a query, Home's featured card and its gone row);
  - the copy route maps each to its label and address;
  - a Saved copy link in rows appended by Show older carries the same `from`, and a search's `from` keeps `q`, `tag` and `keep`;
  - `/spaces?tag=<owned>&order=banana`, `/all?before=garbage` and `/search?q=x&tag=<not owned>` give working addresses (order and cursor dropped, the unowned tag dropped);
  - each of these falls back to Back to All links: `//evil.example/`, `https://evil.example/all`, `/\evil`, `javascript:alert(1)`, `/links/1/copy`, an unknown path, a space name the owner lacks, and another owner's space name. Each must also leave no trace of the raw value in the page.
- [ ] **5. Implement** the frame, `from` and styles.
- [ ] **6. Records**, then `npm run check`.
- [ ] **7. Browser check** on a local server under the real headers (the orchestrator does this): the account menu opens and closes on Escape and an outside press, Sign out works, Open on <site> records an opening, and the console shows no CSP violation.

## PR B (outline, planned in full after PR A merges)

Under the sheet: "Finished with this link?" with It's stale, Put it away and Keep handy (Not handy anymore once kept), as quiet buttons in the ⋯ menu's order. A link out of your lists shows only Bring it back. After It's stale or Put it away, the row says what happened and offers Undo through the Undo bar, and the Back link stays. The buttons reuse the routes and Undo texts in `done-link.ts` and `keep-handy.ts`. Its script joins the page's hashed scripts. An opening brings a put-away link back to your lists (`recordOpening`, `src/core/links.ts`), so PR B owns making the end buttons agree with the link's state after Open on <site> is clicked.
