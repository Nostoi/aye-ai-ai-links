# #223 step 3: how the saved copy reads

Branch `issue-223-reader-look`, from main 03d3017. Runs alongside PR B (the end buttons, branch `issue-223-end-buttons`). Closes #221.

The spec is #223's "The article on a sheet". The mockup boards are `ReaderDesktop`, `ReaderPhone`, `ReaderStress` and `ReaderStressDarkPhone` on the design canvas, section 5.

## What it enables

Today the article runs straight on the page background, in the page's own type sizes. Its `# headings` render as a second `h1`. A picture is just an `img` in a paragraph. A picture that wasn't saved shows only as loose words. After this change:
- the article sits on a white sheet in the reading type;
- the title is the page's only `h1`;
- pictures stand on bands;
- a lost picture says so.

## Grounding

**OBSERVED**
- **The renderer.** `src/web/copy-markdown.ts` uses markdown-it 15.0.2 with the commonmark preset, `html:false`, and `table` on.
  - Core rule order: …, `copy_repair` (before `text_join`), `text_join`, `copy_safe` (`safeTokens`), `copy_plain_cells`.
  - Every link and picture decision is made in `safeTokens`:
    - only http, https and mailto links are kept;
    - a kept picture gets `src=/links/<id>/copy/images/<n>` and `loading=lazy`;
    - a refused picture becomes a `text` token holding its alt, which records nothing about it having been a picture.
- **Token shapes (probed):**
  - `![a](x)` → `paragraph_open inline[image] paragraph_close`.
  - `[![a](x)](h)` → `inline[link_open,image,link_close]`.
  - Two pictures separated by a space or a line break → `image, text(" ")|softbreak, image`.
  - A picture inside text → `text,image,text`.
  - `![a]()` → `image` with `src=""`, which `imageNumber` refuses.
  - A setext heading gives a `heading_open` token, as an ATX heading does.
  - A picture in a table cell → `td_open inline[image]`, with no paragraph.
- **The writer** (`src/fetch/extract-copy.ts`, rule `copyImage`):
  - The 31st picture and later are written as `image.text`, with `|` escaped.
  - A picture with no `src`, or a non-http(s) one, becomes its escaped alt.
  - Saved pictures are `![alt](images/NN-<nonce>)`.
  - A link around blocks (#220, rule `copyLink`) puts the blocks first, then `[label](href)`.
- **Finishing.** `src/core/saved-copy.ts` `finishedMarkdown` turns every reference to a picture that isn't stored into its bare `alt`.
  - The store refuses a finished copy longer than reserved (`src/store/saved-copies.ts`, "The finished copy is longer than reserved").
  - Export finishes copies that aren't finished yet (`src/core/export.ts`).
- **So, today, the stored Markdown of a finished copy holds no picture token for a lost picture.** The renderer alone can't show "Picture not saved".
- **The page.** `src/web/copy-page.ts` renders `<article class="copy-article">` inside `main.copy`. `COPY_HEADERS` hashes `PAGE_STYLE` at module load.
- **Theme.** In `src/web/theme.ts`:
  - The copy rules are `.copy{max-width:720px}`, `.copy-article{…font-size:17px;line-height:1.65}`, `.copy-article>*{max-width:68ch}`, and rules for img, pre (`--surface` with a line), blockquote and tables.
  - `main p,main li{max-width:68ch}` is global.
  - The card shadow is `0 4px 18px #0000000f`.
  - There is one long phone block, `@media (max-width:600px){…}`.
- **Test hazard.** `src/web/theme.test.ts` finds the phone block with a first-match regex (`/@media \(max-width:600px\)\{(.*)\}$/m`). A new phone line placed before it would break unrelated tests.
- **Snapshots.** Every `src/web/__ask_off__/*.html` inlines the CSS, so a theme change rewrites them all. `copy-ok.html` renders `<h1>Hello</h1>`.
- **#221 is already met by PR A:** `.copy-open` and `.back-link` have `min-height:44px`, and the old site line is gone.
- **Tests that change:**
  - `copy-routes.test.ts`'s `<h3>Skill</h3>`.
  - `copy-markdown.test.ts`'s `blockquote h3` and "keeps an image inside a kept link".
  - The alt-text tests.
  - `saved-copy.test.ts`'s finishing case.
  - `extract-copy.test.ts`'s past-30 case.
  - `export.test.ts`'s gone-picture case.

**The mockup, read for measurements:**
- The column is 720px wide, and the sheet fills it. The padding is `44px 48px 48px`, so the text measure is 624px.
- A band is `margin:32px -48px; padding:24px 0; background:--bg`. The picture is centred with 6px corners, and `max-height:60vh`.
- A linked picture: the band, then a grey 15px "Picture links to <address> ↗" link on the sheet *under* the band, 44px tall. The picture itself isn't a link.
- A lost picture: a band holding grey 15px text, with padding `18px 48px`.
- Code and inline code use the `--bg` fill. A quote has a 3px `--line` left rule, an 18px left padding and the `--soft` colour.

## Owner rulings

- **2026-10-21:** pictures run edge to edge in the sheet, an exception to `src/web/AGENTS.md` rule 4.
- **2026-10-21, D1:** lost pictures are marked in copies made from now on. Old copies keep their plain alt text.

## Decisions

1. **Headings.** A core rule `copy_headings` sets `heading_open` and `heading_close` to `h${min(n+1,6)}`. It works on tokens, so ATX and setext headings both shift, and so do old copies. The page `h1` is the only one.
2. **The sheet is the existing `<article class="copy-article">`**. There's no new wrapper, and `copy-page.ts` markup doesn't change. PR B adds its section after the article, so the two don't collide.
3. **Lost pictures in new copies:**
   - `finishedMarkdown` writes `![alt]()` where it wrote `alt`. That's always shorter than `![alt](images/NN-<32 hex>)`, so the never-longer check holds.
   - `articleMarkdown` writes `![<escaped alt>]()` for the 31st picture and later, keeping the `\|` escape. The renderer refuses `src=""` already, so no new safety code is needed.
   - Export writes the same `![alt]()`.
   - Pictures with `data:` or `blob:` addresses, or with no `src`, stay as they are (a possible follow-up).
   - Rejected: `![alt](images/NN)`, which suggests a file export doesn't have. Also rejected: literal "Picture not saved" text, which page text could imitate.
4. **The refused picture's marker.** `safeTokens` gives the refused picture's `text` token `meta = { unsavedPicture: true }`. Its content and its inline rendering are unchanged.
5. **Bands are built on tokens by a core rule `copy_pictures`**, pushed after `copy_plain_cells`, so it sees only decisions `safeTokens` has already made.
   - It applies to a `paragraph_open, inline, paragraph_close` whose inline children are only:
     - pictures;
     - refused-picture markers;
     - a picture alone inside one kept `link_open … link_close`;
     - softbreaks or whitespace text between them.
   - Each picture becomes its own block, in order:
     - a saved picture → `<div class="copy-band"><img …></div>`;
     - a lost picture with alt → `<div class="copy-band copy-band-note"><p class="copy-pic-note">Picture not saved: ALT</p></div>`;
     - a lost picture with empty alt → nothing;
     - a linked picture → its band, then `<p class="copy-pic-link"><a href target rel>Picture links to LABEL <span aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span></a></p>`, with `href`, `target` and `rel` copied from the kept `link_open` and LABEL from `linkLabel(href)`.
   - A refused link gives no caption line.
   - New tokens use fixed tags (div, p, a, span), fixed classes and aria attributes, and `text` tokens. They never use `html_inline` or `html_block`.
   - Pictures inside text, a picture with text in a link, pictures in headings and pictures in cells stay inline and get only the height cap.
   - Rejected: hoisting inline pictures out of text, because icon images would become huge bands.
6. **Pictures in lists or quotes** get a band inside their container, with no negative margins (only `.copy-article>.copy-band` bleeds).
7. **A pending picture in an unfinished copy shows "Picture not saved: alt"** until the copy is finished. The page is `no-store`, so that's true at the time.
8. **Theme.** Replace the copy rules in place as one contiguous block:
   - `.copy{max-width:720px}` (unchanged).
   - The sheet: `.copy-article{margin-top:0;padding:44px 48px 48px;background:var(--surface);border-radius:20px;box-shadow:0 4px 18px #0000000f;font-size:18px;line-height:1.7;overflow-wrap:anywhere}`, plus first and last child margins set to 0. Also add `.copy-article p,.copy-article li{max-width:none}`, and drop `.copy-article>*{max-width:68ch}`.
   - Headings: h2 24px, h3 19px, h4–h6 18px.
   - Bands: `.copy-band{margin:32px 0;padding:24px 0;background:var(--bg)}` and `.copy-article>.copy-band{margin-left:-48px;margin-right:-48px}`.
   - Pictures in bands: `.copy-band img{display:block;width:auto;height:auto;max-width:calc(100% - 48px);max-height:60vh;max-height:60svh;margin:0 auto;border-radius:6px}`.
   - Notes and caption links:
     - `.copy-band-note{padding:18px 48px}`;
     - `.copy-pic-note{margin:0;font-size:15px;color:var(--soft)}`;
     - `.copy-pic-link a{display:inline-flex;align-items:center;gap:4px;min-height:44px;font-size:15px;color:var(--soft)}`;
     - `.copy-band+.copy-pic-link{margin-top:-24px}`, so the line sits just under its band.
   - Other pictures: `.copy-article img` (inline ones) keeps `max-width:100%` and gets the height cap.
   - Code: `pre{background:var(--bg);border:0;border-radius:10px;padding:14px 18px}`, `code{background:var(--bg);border-radius:5px;padding:1px 5px}` and `pre code{background:none;padding:0}`.
   - Quotes: `blockquote{padding-left:18px;border-left:3px solid var(--line);color:var(--soft)}`.
   - Tables: as shipped.
   - Phone: a new line `@media (max-width:600px){.copy-article{padding:24px 20px;font-size:17.5px;line-height:1.65}.copy-article h2{font-size:22px}.copy-article>.copy-band{margin-left:-20px;margin-right:-20px}.copy-band-note{padding:18px 20px}}`. It goes *after* the existing phone lines, so the first-match regexes still find the main block.
   - Exact values may be tuned in the browser check against the boards.

## Solution-choice challenge (Sol, REVISE): resolutions

All five objections are accepted. They're folded in here, and they override the decisions above where the two conflict.

- **A. `hardbreak` between pictures.** A `<br>` between pictures is written as a Markdown hard break. The band rule therefore also accepts `hardbreak` between pictures, alongside softbreaks and whitespace. Tests cover saved, lost and linked pictures separated by a hard break.
- **B. The #220 link line is this PR's.** The block-links plan promised that #223 styles a paragraph that is only a link as the grey link line, and nothing styles it yet. Here's the rule:
  - A `paragraph_open, inline, paragraph_close` whose inline children are exactly one kept `link_open, text…, link_close`, with no other content, and whose text tokens (none a lost-picture marker) joined equal `linkLabel` of the link's address (as kept, or decoded for an old card), gets `class="copy-link-line"`.
  - The rule appends `<span aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span>` inside the link.
  - The CSS: `.copy-link-line a{display:inline-flex;align-items:center;gap:4px;min-height:44px;font-size:15px;color:var(--soft)}`, with `overflow-wrap:anywhere`.
  - Tests: the #220 card renders the line with the class, and neither a link inside a sentence nor an author's own link alone in its paragraph gets it.
- **C. Lost pictures from refused sources are marked too.** In new copies, `copyImage` writes `![<escaped alt>]()` for a picture with no `src`, or with a `data:`, `blob:` or other non-http(s) address. It does the same for the 31st picture and later. An empty alt gives `![]()`, which renders nothing. Tests cover `data:`, `blob:`, a missing `src` and the past-30 case.
- **D. Inline pictures are explicitly inline.**
  - A picture that isn't in a band gets `.copy-article img{display:inline;vertical-align:middle;margin:0;max-width:100%;height:auto;max-height:60vh;max-height:60svh}`.
  - A picture in a band gets `.copy-band img{display:block;margin:0 auto;…}`, which is more specific, so it overrides the inline rule.
  - The browser check confirms a picture mid-sentence stays in the sentence.
- **E. The boundary is "copies already finished stay as they are".** A copy still being finished when this deploys, or an old unfinished copy that gets exported, is finished with the new marker. That's truthful and does no harm. The ROADMAP entry states the boundary in exactly these words. No creation-time check is added.
- **Pending pictures:** a picture still being fetched shows "Picture not saved" until the copy finishes (decision 7). A stored picture whose file has gone missing is out of scope.
- **Mockup spacing:** the browser check owns the remaining values, such as heading line heights, paragraph spacing and the phone band spacing, and tunes them against the boards.

## Red-first tests

**`src/web/copy-markdown.test.ts`**
1. **Headings:** `# A\n\n## B\n\n###### F\n\nS\n=` gives `h2 A`, `h3 B`, `h6 F`, `h2 S`, and no `<h1`.
2. **A saved picture alone** gives `div.copy-band > img[src="/links/7/copy/images/1"]`, with no `p > img`.
3. **A linked picture:**
   - the `img` has no `a` ancestor;
   - the next sibling is `p.copy-pic-link > a` with the href, `target=_blank` and `rel="noopener noreferrer nofollow"`;
   - its normalised text is `Picture links to e.example/p ↗ (opens in a new tab)`.
4. **A picture in a refused link** (`javascript:`): a band with the img, no `a`, no caption, and no `javascript:` anywhere.
5. **A lost picture:**
   - `![two]()` and a reference missing from the ledger each give `.copy-band p.copy-pic-note` with text `Picture not saved: two`, and no `img`;
   - `![]()` alone gives no band and no empty `p`.
6. **A lost linked picture:** the note, then the link line. With empty alt, only the link line.
7. **A hostile alt** (`![<script>x</script> *b*]()`): the note's text holds `<script>x</script> b`, with no script or `b` element.
8. **Two pictures in one paragraph** give two bands, in order.
9. **Pictures that stay inline:**
   - a picture inside text gives `p > img`;
   - a picture plus text in a link gives `p > a > img`;
   - a picture in a cell gives `td > img`;
   - a lost picture inside text gives plain alt text with no "Picture not saved".
10. **Containers:** a picture in a list gives `li .copy-band img`, and one in a quote gives `blockquote .copy-band`.
11. **#220 still holds:** the linked-card test keeps its hrefs, and gains a band img with no caption and an `h4` title. `blockquote h3` becomes `blockquote h4`.
12. **A safety sweep over a stress document plus the existing hostile list:**
    - every href matches `^(https?:|mailto:)`;
    - every src starts with `/links/7/copy/images/`;
    - there's no `style`, no `on*` attribute and no `script`;
    - every element is on the allow-list: p, h2–h6, a, img, div, span, ul, ol, li, blockquote, pre, code, em, strong, hr, br, table, thead, tbody, tr, th, td.
13. **The budget tests still pass**, plus a new one with about 2 MiB of picture paragraphs.
14. **The alt-text tests:** the label is still present with no `img`. Where the picture stands alone, the note prefix is added.

**Writer (D1)**

15. `src/core/saved-copy.test.ts`: lost pictures finish as `![alt]()`. The output is never longer than the input, including with 30 lost pictures and long alts.
16. `src/fetch/extract-copy.test.ts`: the 31st picture gives `![alt31]()`, and the escaping is kept.
17. `src/fetch/copy-tables.test.ts`: a `|` in a lost picture's alt inside a cell still gives 2 `td`.
18. `src/core/export.test.ts`: an unfinished copy's gone picture is exported as `![alt]()`.

**Page and theme**

19. `copy-page.test.ts`: exactly one `h1`, the title; the article's `h2` is "Hello".
20. `copy-routes.test.ts`:
    - `<h3>Skill</h3>` becomes `<h4>Skill</h4>`;
    - the `world()` page shows `.copy-band img` and `Picture not saved: two`;
    - the `[style]` count is still 0;
    - after finishing, the page still shows `Picture not saved: two`.
21. `theme.test.ts`:
    - the sheet values;
    - the band's bleed and `--bg`;
    - `.copy-band img` has `max-height:60vh` and no `object-fit`;
    - the caption link has `min-height:44px`;
    - the code fill;
    - the phone line's values;
    - the existing phone-block tests still pass.

## Tasks

1. Write red tests 1–14 and 19–20, then implement `copy_headings`, the marker and `copy_pictures` in `copy-markdown.ts`, and update its doc comment.
2. Write red tests 15–18, then change `finishedMarkdown` and `extract-copy.ts` (and their doc comments).
3. Write red test 21, then the theme.
4. Run `npx vitest run src/web/ask-off-bytes.test.ts -u`. Read the diff: it should hold only CSS and `copy-ok`'s `h2`. Whichever of this PR and PR B merges second merges main and runs `-u` again rather than hand-merging.
5. Update the records, then run `npm run check`.
6. Do the browser check (the orchestrator does this).

## Records

- **`src/web/AGENTS.md` rule 4** gains the saved-copy exception (owner, 2026-10-21): a picture standing alone runs edge to edge across the sheet on a band of `--bg`. It keeps its proportions, is centred, isn't cropped, and is no taller than 60% of the screen. A picture inside text or a cell stays inline. The Markdown bullet notes that bands and caption lines are built from tokens with fixed tags only, and that a caption's address is the link `safeTokens` already kept.
- **ROADMAP decision log, 2026-10-21:** the saved copy reads as an article on a sheet (#223 step 3). Cover:
  - the heading shift;
  - bands and the rule 4 exception;
  - the caption line;
  - lost pictures, which changes the saved-copy spec's "a picture not stored becomes its alt text": new copies and exports write `![alt]()`, and old copies keep plain words;
  - that it closes #221.
- **README "Saved copies":** the article on a white sheet, pictures across it, a line under a picture that links somewhere, and a "Picture not saved" line where a picture couldn't be kept (in copies saved from now on).

## Browser check (desktop 1280px and phone 390px, light and dark)

Use a test copy that has:
- h1–h6, a long paragraph, nested lists, a wide table, a fenced code block, inline code and a quote;
- a wide picture, a tall picture, a tiny picture, a linked picture, a picture mid-sentence, two pictures in one paragraph, and pictures inside a list and a quote;
- lost pictures with alt, with empty alt, and linked;
- an old #220 card.

Check:
- **Sheet and type:** the sheet's colour, corners, shadow, padding and width; the body size and line height; one `h1`.
- **Bands:** a band touches both sheet edges. A tall picture is capped at 60% of the window height and centred, not cropped.
- **Picture lines:** the caption line is 44px tall and opens a new tab. The lost-picture line is grey on its band.
- **Wide content:** the table and code scroll inside their boxes, with no page-level sideways scroll at 390px.
- **Page safety:** no CSP violation in the console, and no `style=` attributes.
- **PR A still works:** the account menu and Open on <site>.
