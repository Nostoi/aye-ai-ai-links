# A link around blocks reads cleanly in a saved copy: implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** fix #220. When a page links a whole card (an `<a>` holding headings, paragraphs or pictures), the saved copy shows the card's content, then one plain link line to the card's address. It no longer shows a stray `[` and `](url)`. Copies already saved are mended where they are read. One PR. It is step 1 of #223's landing sequence.

## Grounding

What it fixes, reachable today: any copy of a page whose article links a card. The owner saw it on `mcpmarket.com` and `gameartstyle.loopyhop.com` copies (#220 and its comment). Reproduced on main cfbc114: `articleMarkdown` given `<a href=…><img><h3>…</h3><p>…</p></a>` writes `[![](images/01-…)\n\n### …\n\n…\n\n](https://…)`, and `copyHtml` renders `<p>[</p>…<p>](https://…)</p>`. CommonMark link text can't contain a blank line, so no link forms. Nothing in either step refuses or repairs it.

- OBSERVED: `articleMarkdown` (`src/fetch/extract-copy.ts`) uses `TurndownService` with only a `copyImage` rule added, so links go through Turndown's own `inlineLink` rule. That rule writes `'[' + content + '](' + href + title + ')'` whatever `content` holds (`node_modules/turndown/lib/turndown.cjs.js`, `rules.inlineLink`).
- OBSERVED: Turndown keeps its default rules on `td.options.rules`, and `@types/turndown` 5.0.6 types it as `TurndownService.Rules`. A new rule can therefore hand the ordinary case back to `td.options.rules.inlineLink` unchanged.
- OBSERVED: a copy's Markdown is read in exactly two places: the copy page (`copyHtml` in `src/web/copy-markdown.ts`, called by `copyPage`) and the export (`src/core/export.ts`, which passes `read.markdown` through `finishedMarkdown`). Search: `copyHtml(`, `read.markdown` and `copy.markdown` across `src/`. MCP and the AI don't read the Markdown.
- OBSERVED: copies are write-once. The copy pass changes only image references the server wrote (`finishedMarkdown`, `src/core/saved-copy.ts`). The saved-copy spec §12 says a copy is never replaced. So a copy saved before this fix keeps the broken text unless it is mended when read.
- OBSERVED: `copyHtml` keeps a link only when `isSafeHref` passes (http, https, mailto). The mend runs before parsing, so every mended address still goes through that check.

## Decisions

- **One shape for a link around blocks**, in new copies and mended old ones: the content stays as it was, unlinked, followed by its own paragraph, `[<label>](<href>)`. Its `<label>` is the address without its scheme, and without a trailing `/` (`mcpmarket.com/tools/skills/x`). The label is escaped for Markdown. The reader (#223) styles a paragraph that is only a link as the grey link line.
- **What makes a link a block link** is the failure condition itself: the converted content contains a blank line (`/\n[ \t]*\n/`). An inline link, or a link around only a picture, stays exactly as Turndown writes it today.
- **The label helper** `blockLinkLabel(href)` lives in `src/core/saved-copy.ts`, beside `finishedMarkdown`, because `fetch/` and `core/` both need it and `fetch/` already imports `core/saved-copy.ts`.
- **The mend** is `mendBlockLinks(markdown)` in `src/core/saved-copy.ts`, a pure function. It finds each paragraph that is exactly `](<destination>)` (optionally with a title), and the nearest earlier paragraph that starts with an unmatched `[`. It removes that `[`, dropping the paragraph if nothing else is left, and replaces the closing paragraph with the block-link shape. Escaped brackets (`\[`, `\]`) don't count. If no opener is found, the text is left as it is. Both readers call it: `copyHtml` before `md.render`, and the export before `finishedMarkdown`.
- `copy-markdown.ts`'s token-level safety pass is not changed.

## Not in this PR

- Styling the link line (#223).
- Tables (#223, step 2).

## Tasks

- [ ] **1. Red test: new copies.** In `src/fetch/extract-copy.test.ts`, the #220 snippet becomes Markdown with no `[` before the picture, the heading and paragraph unlinked, and a last paragraph `[mcpmarket.com/tools/skills/x](https://mcpmarket.com/tools/skills/x)`. Rendering it with `copyHtml` gives one `<a href="https://mcpmarket.com/tools/skills/x"`, and no text node holds `[` or `](`. Two regression cases keep today's output byte for byte: an inline link inside a paragraph, and a link around only a picture (`[![](…)](…)`). Run it red, then implement the Turndown rule.
- [ ] **2. Red test: mending.** In `src/core/saved-copy.test.ts`:
  - the broken Markdown from the reproduction mends to the task 1 shape
  - a paragraph starting `[a](b) and more` is unchanged
  - text with escaped `\[` and `\]` is unchanged
  - a closing paragraph with no opener is unchanged
  - two cards in a row both mend
  - a mended `javascript:` address renders through `copyHtml` with no `<a>`

  Then implement `mendBlockLinks` and `blockLinkLabel`.
- [ ] **3. Wire both readers.** `copyHtml` calls `mendBlockLinks` first. The export calls it before `finishedMarkdown`. Red tests:
  - the copy page route on a stored broken copy shows the link and no `](`
  - the export zip's copy file holds the mended text

  Keep every existing R39 safety test unchanged and passing.
- [ ] **4. Check.** `npm run check` passes. README's "Saved copies" needs no change, because it doesn't describe link layout.
