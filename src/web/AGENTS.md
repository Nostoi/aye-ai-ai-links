# src/web

Rules for this folder only. The reference is `docs/design/home-calm-desk-mockup.html` (option A) and spec §6.

## Design rules (spec §6)

1. **Room to breathe:** big text, generous space, few things per screen.
2. **Size = importance:** the one thing worth attention is the biggest thing.
3. **Color means one thing each** (below).
4. **Pictures jog memory:** real page images, shown large.
5. **Ask, don't make you dig:** open on a question; search understands vague memories.
6. **No guilt counters:** no unread totals; small, finishable nudges.

## Color

- Each space (pinned tag) owns one color everywhere, through the `.space-*` classes.
- Amber only ever means "needs you". Never use it for a space.
- Everything else is neutral. The teal logo is the one brand exception.

## Pages

- Pages make no outside requests: no remote images, scripts, stylesheets or fonts. Link navigation is fine.
- Every page renders through `page()` and the theme tokens in `theme.ts`; no page brings its own colors.

## New routes

A new web route must pass the route guard in `src/mcp/isolation.test.ts` ("owner isolation coverage"). Every signed-in read path needs a `READ_ROUTES` entry: a sample request with A's marker (A gets 200 with it; a second owner gets no A marker and, for bytes, not A's body), or a `noOwnerData` reason. Every write path needs a `WRITE_ROUTES_TESTED` entry naming its two-owner test, and a signed-in POST joins `CHECKED_PAGES` in `src/app.ts`. The guard also fails any HTML page A receives that makes an outside request.
