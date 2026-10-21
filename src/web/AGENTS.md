# src/web

Rules for this folder only. The reference is `docs/design/home-calm-desk-mockup.html` (option A) and spec §6. The Ask AI panel's reference is `docs/design/ask-ai-panel-mockup.html`, which governs over the text of its design (#159).

## Design rules (spec §6)

1. **Room to breathe:** big text, generous space, few things per screen.
2. **Size = importance:** the one thing worth attention is the biggest thing.
3. **Color means one thing each** (below).
4. **Pictures are small accents:** your words lead, and a picture is a small fixed square beside them, never a wide crop (ROADMAP 2026-10-20; #194 and #195 bring All links and Home to it). A page's preview shows unless its site makes pictures of words (`isWordPictureHost`, `src/core/word-picture-host.ts`), which shows the site's icon. A link with no picture shows its initials on `--pic`, never in its space's color.
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
- A link card's actions live in one ⋯ menu in a fixed order: I'm done with it, Keep handy (Not handy anymore once kept), Edit, Remove saved copy, Delete link (#192). Cards build it with `editMenu` (`edit-link.ts`); a Handy tile's holds only the first two, Keep handy already done. A link you're done with has no first group. Keep the menu to five items: a new one replaces one or argues for its place (Read saved copy is a sixth until #194 moves it to the card). Rows stay neutral, with a line icon and no color.
- A card's title and its menu's "More for …" label come from `displayTitle`, through `linkTitle` or `editMenu`, never `link.title ?? link.url` (#197). A new card builder joins `display-title-cards.test.ts`.
- The edit dialog shows a Save on a card through markers, not classes: the title is the element marked `data-card-title`, and the picture is `tile()`'s box, which carries `data-pic`. A card on a page with the dialog draws its picture with `tile()`.
- A saved link opens in a new tab: `target="_blank" rel="noopener noreferrer"`. Render it with `openLink` or `linkTitle` (`open-link.ts`) inside a card carrying the link's `data-id`, and add `openedScript` for its list, so the opening is recorded (#124).
- Exception: the saved-copy page runs no script, so its link to the page records no opening (ROADMAP 2026-10-18).
- Markdown from a saved page renders only through `copy-markdown.ts`. The copy page is the one page with a full CSP (`COPY_HEADERS`); its style hash comes from `PAGE_STYLE`, so styles live in `theme.ts` and it carries no `style=` attribute.
- Page designs: #12 comment 6158134489.

## New routes

A new web route must pass the route guard in `src/mcp/isolation.test.ts` ("owner isolation coverage"). Every signed-in read path needs a `READ_ROUTES` entry: a sample request with A's marker (A gets 200 with it; a second owner gets no A marker and, for bytes, not A's body), or a `noOwnerData` reason. Every write path needs a `WRITE_ROUTES_TESTED` entry naming its two-owner test, and a signed-in POST joins `CHECKED_PAGES` in `src/app.ts`. The guard also fails any HTML page A receives that makes an outside request.
