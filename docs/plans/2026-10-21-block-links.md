# A link around blocks reads cleanly in a saved copy: implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** fix #220. When a page links a whole card (an `<a>` holding headings, paragraphs, lists or pictures), the saved copy shows the card's content, then one plain link line to the card's address. It no longer shows a stray `[` and `](url)`. Copies already saved read correctly on the copy page. One PR. It is step 1 of #223's landing sequence.

## Grounding

What it fixes, reachable today: any copy of a page whose article links a card. The owner saw it on `mcpmarket.com` and `gameartstyle.loopyhop.com` copies (#220 and its comment). Reproduced on main cfbc114: `articleMarkdown` given `<a href=…><img><h3>…</h3><p>…</p></a>` writes `[![](images/01-…)\n\n### …\n\n…\n\n](https://…)`, and `copyHtml` renders `<p>[</p>…<p>](https://…)</p>`. CommonMark link text can't span blocks, so no link forms. Nothing in either step refuses or repairs it.

- OBSERVED: `articleMarkdown` (`src/fetch/extract-copy.ts`) adds only a `copyImage` rule to Turndown, so links go through Turndown's own `inlineLink` rule. That rule writes `'[' + content + '](' + href + title + ')'` whatever `content` holds (`node_modules/turndown/lib/turndown.cjs.js`, `rules.inlineLink`).
- OBSERVED (runtime) / not typed: Turndown keeps its default rules on `td.options.rules`, but `@types/turndown` 5.0.6 doesn't declare `rules` on `Options`. Reaching it needs an explicit typed bridge (Sol, solution-choice review).
- OBSERVED: a copy's Markdown is read in exactly two places: the copy page (`copyHtml`, `src/web/copy-markdown.ts`) and the export (`src/core/export.ts`). Search: `copyHtml(`, `read.markdown` and `copy.markdown` across `src/`.
- OBSERVED: the export design says "A finished copy is written unchanged" and "Export never rewrites a finished copy's text" (`docs/specs/2026-10-18-export-design.md`), and `export.test.ts` holds a byte-preservation test.
- OBSERVED: copies are write-once (saved-copy spec §12), so a copy saved before this fix keeps the broken text in storage.
- OBSERVED: `copyHtml`'s `safeTokens` core rule keeps a link only when `isSafeHref` passes, and it runs over the token stream after parsing.

## Decisions

- **One shape for a link around blocks** in new copies: the content as it was, unlinked, then its own paragraph `[<label>](<href>)`. Its `<label>` is the address without its scheme and without a trailing `/` (`mcpmarket.com/tools/skills/x`), escaped for Markdown. The link's title attribute is dropped. #223 styles a paragraph that is only a link as the grey link line.
- **New copies (`fetch/extract-copy.ts`):** a Turndown rule for `a[href]`. When the converted content contains a blank line, it writes the block shape. Otherwise it returns exactly what Turndown's `inlineLink` returns, reached through a typed bridge that throws at construction if the rule is missing. Turndown wraps every block (heading, paragraph, list, quote, `div`, figure) in blank lines. Tests cover each of those, so the condition is checked per kind of block rather than assumed.
- **Copies already saved are repaired only where they're shown**, as a markdown-it core rule in `copy-markdown.ts` that runs before `safeTokens`:
  - It walks the parsed tokens, so code blocks and fences are never touched.
  - An **opener** is an inline token whose source starts with a `[` that isn't closed within it.
  - A **closer** is an inline token whose source starts with `](<destination>)`, parsed with markdown-it's own `parseLinkDestination`. Anything after it, such as the next card's `[`, is handled again as possible opener text.
  - A closer pairs with the most recent unpaired opener at the same nesting level, so no card pairs across a quote or list boundary.
  - On a pair, the `[` is removed from the opener (a paragraph left empty is dropped). The closer becomes `link_open` / text label / `link_close`, which `safeTokens` then checks like any link.
  - It is one linear pass with a stack. An opener or closer with no partner is left as it is.
- **The export is not changed.** It keeps writing stored copies byte for byte, as its spec requires, so an exported copy made before this fix keeps the broken text. Files read straight from the synced copy folder are unchanged too. Both are recorded on #220.

## Not in this PR

- Styling the link line (#223).
- Tables (#223, step 2).

## Tasks

- [ ] **1. Red test: new copies.** In `src/fetch/extract-copy.test.ts`:
  - The #220 snippet gives Markdown with no `[` before the picture, the heading and paragraph unlinked, and a last paragraph `[mcpmarket.com/tools/skills/x](https://mcpmarket.com/tools/skills/x)`.
  - Through `copyHtml` it renders one `<a href="https://mcpmarket.com/tools/skills/x"`, and no text holds `[` or `](`.
  - The same holds for an anchor around a `<ul>`, a `<blockquote>`, a `<div>` and an `<h2>`, and for two adjacent card anchors with no whitespace between them, each keeping its own address.
  - Byte-for-byte regressions: an inline link in a paragraph, a link around only a picture (`[![](…)](…)`), and a link with a title.

  Run red, then implement the rule and its bridge.
- [ ] **2. Red test: saved copies on the page.** In `src/web/copy-markdown.test.ts` (or its existing test file), `copyHtml` given stored broken Markdown renders the content plus one link, with no `[` or `](` text. Cover:
  - one card
  - two adjacent cards (`](https://e.example/a)[` in one paragraph), each with its own address
  - a card inside a blockquote and inside a list item, keeping the container
  - a fenced code block holding the same broken text, rendered unchanged
  - a paragraph starting `[a](b) and more`, unchanged
  - a closer with no opener, unchanged
  - a repaired `javascript:` address, rendered with no `<a>`
  - escaped parentheses in the address
  - an image-finished copy and an unfinished one (`images/NN.ext` and `images/NN-<nonce>`)
  - a large input (2 MiB of orphan `](x)` and `[` lines) that renders within the existing budget

  Then implement the rule.
- [ ] **3. Route test.** The copy page route on a stored broken copy shows the link and no `](`. Every existing R39 safety test stays unchanged and passing. The export's byte-preservation test stays unchanged and passing.
- [ ] **4. Check.** `npm run check` passes. README's "Saved copies" needs no change, because it doesn't describe link layout.
