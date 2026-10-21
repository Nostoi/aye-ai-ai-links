# src/web

Rules for this folder only. The reference is `docs/design/home-calm-desk-mockup.html` (option A) and spec §6. The Ask AI panel's reference is `docs/design/ask-ai-panel-mockup.html`, which governs over the text of its design (#159).

## Design rules (spec §6)

1. **Room to breathe:** big text, generous space, few things per screen.
2. **Size = importance:** the one thing worth attention is the biggest thing.
3. **Color means one thing each** (below).
4. **Pictures are small accents:** your words lead, and a picture is a small fixed square beside them, never a wide crop (ROADMAP 2026-10-20; #194 and #195 bring All links and Home to it). The one exception is the Pictures view of All links and space pages, which the owner switches to on purpose and which shows each picture across its card (#191, #194). A page's preview shows unless its site makes pictures of words (`isWordPictureHost`, `src/core/word-picture-host.ts`), which shows the site's icon. A link with no picture shows its initials on `--pic`, never in its space's color.
5. **Ask, don't make you dig:** open on a question; search understands vague memories.
6. **No guilt counters:** no unread totals; small, finishable nudges.

## Color

- Each space (pinned tag) keeps one color everywhere, through the `.space-*` classes. The colors are `SPACE_COLORS` in `src/core/tag-space.ts`. A new pin takes a color no tag holds while one is free; two spaces may share a color past that, or when the owner picks one. A card's space comes from `linkSpace` and a tag's color from `spaceColor` (`src/core/link-space.ts`); both pass only `SPACE_COLORS`, and only for a pinned tag. An unpinned tag keeps its stored color but shows none, except on the Tags page, which edits that color and shows it. Other class names never start with `space-`.
- Amber only ever means "needs you". Never use it for a space, or for the reason a card is shown: that uses its space's color.
- Everything else is neutral. The teal logo is the one brand exception.

## Pages

- Pages make no outside requests: no remote images, scripts, stylesheets or fonts. Link navigation is fine.
- Every page renders through `page()` and the theme tokens in `theme.ts`; no page brings its own colors.
- Controls are at least 44px tall. Fields are outlined with `--field`.
- Removing or turning something off shows an Undo bar instead of asking first. The action is done at once, and Undo reverses it with a second request; nothing waits for the bar to close. The bar is `page()`'s `undo` option and its `showUndo`.
- A link card's actions live in one ⋯ menu in a fixed order: It's stale, Put it away, Keep handy (Not handy anymore once kept), Edit, Remove saved copy, Delete link (#192, #198). Cards build it with `editMenu` (`edit-link.ts`); a Handy tile's holds only It's stale and Keep handy, Keep handy already done, and no Put it away. A link out of your lists has no first group: its menu starts at Edit, then Bring it back (`doneLinkScript` works all three state rows). Keep the menu to six items: a new one replaces one or argues for its place. The owner chose six, for Put it away (#198), and Home's Also today rows seven (below). Every row is a button; nothing in the menu links away. Rows stay neutral, with a line icon and no color. Every ⋯ menu (this one and the account menu) carries `name="menu"` so only one is open, and `page()`'s menu script closes it on Escape, an outside press or focus leaving it (#201).
- A card's grey line (`cardLine`, `card-line.ts`) names its space, its site and, where a page shows it, when it was saved, then links **Saved copy** when there is one, then ends with Put away or Stale on a link out of your lists (`linkRow`); missing parts drop out. It is the one link to a saved copy on All links, space pages and search results (#194); a space page leaves its own space out. The dots between parts are the theme's, drawn after a shown part with a shown part later, so Remove saved copy hides the link with its dot.
- All links and space pages show their links as rows (`linkRow`, `link-rows.ts`) in one white card per month: picture, title, the why when there is one, the grey line, and the ⋯ menu. The List / Pictures switch changes only `data-view` on the page's `<main>`, so both views share one markup and the theme draws each; the choice is the `aye_view` cookie, per browser, which the server reads (`viewOf`) so the page draws right away.
- Home's "Worth a look today" (#195) is one featured card, then Also today rows.
  - The featured card holds Home's one filled button outside the search, Open it. Its It's stale and Not now are quiet buttons, so its ⋯ starts at Put it away (`editMenu`'s `onCard`). It alone asks Tell me why, and its grey line is `cardLine`.
  - An Also today row has no buttons of its own, so its ⋯ has seven items: Not now follows Put it away (`notNow`). This is the exception to the six-item menu (owner ruling, #195 comment 6304189584; the six itself is the owner's ruling in #198). A row never links a saved copy.
  - The gone row is the exception to that: it keeps Read the saved copy after its gone line (#195 comment 6304329071), and the theme hides the link with the line.
  - Home changes a card only once the server agrees, so one action's refusal never brings back a card another took out.
- A card takes one action at a time. It's stale, Put it away, Bring it back, Delete link, Keep handy, Remove saved copy, It still works, Not now and a Handy tile's buttons run on the one busy mark `cardBusy` that `CARD_FETCH` defines (#208). A second action sends nothing until the first has finished its answer, page update and Undo offer.
- A card's title and its menu's "More for …" label come from `displayTitle`, through `linkTitle` or `editMenu`, never `link.title ?? link.url` (#197). A new card builder joins `display-title-cards.test.ts`.
- The edit dialog shows a Save on a card through markers, not classes: the title is the element marked `data-card-title`, and the picture is `tile()`'s box, which carries `data-pic`. A card on a page with the dialog draws its picture with `tile()`.
- A saved link opens in a new tab: `target="_blank" rel="noopener noreferrer"`. Render it with `openLink` or `linkTitle` (`open-link.ts`) inside a card carrying the link's `data-id`, and add `openedScript` for its list, so the opening is recorded (#124).
- Exception: the saved-copy page runs no script, so its link to the page records no opening (ROADMAP 2026-10-18).
- Markdown from a saved page renders only through `copy-markdown.ts`. The copy page is the one page with a full CSP (`COPY_HEADERS`); its style hash comes from `PAGE_STYLE`, so styles live in `theme.ts` and it carries no `style=` attribute.
- Page designs: #12 comment 6158134489.

## New routes

A new web route must pass the route guard in `src/mcp/isolation.test.ts` ("owner isolation coverage"). Every signed-in read path needs a `READ_ROUTES` entry: a sample request with A's marker (A gets 200 with it; a second owner gets no A marker and, for bytes, not A's body), or a `noOwnerData` reason. Every write path needs a `WRITE_ROUTES_TESTED` entry naming its two-owner test, and a signed-in POST joins `CHECKED_PAGES` in `src/app.ts`. The guard also fails any HTML page A receives that makes an outside request.
