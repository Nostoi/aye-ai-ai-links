# Site icon when a page names no picture: design (2026-10-18)

Issue #149. The owner ruled on 2026-10-17 that a link whose page names no preview image shows the site's logo or icon (#149 body). Further owner rulings and the controller's defaults are from 2026-10-18 (#149 comment 6259932087). The controller's rulings on the solution-choice review (2026-10-19, in session) are folded in below. This is a dated design record; later ROADMAP.md entries override it.

Code references are to `main` at 9fecd57.

## Goal

A link whose page names no preview image (no `og:image` or `twitter:image`) has no picture today. On Worth a look that shows as an empty 220px box. Example: Photopea (link 30), `imageUrl: null`.

After this work every card shows something useful:
- the site's icon, shown whole and centred, when the page declares a usable one;
- otherwise the title's initials on the space colour, on every card, as the Handy postcards already show.

## Non-goals

- Screenshots or a real-browser capture. That stays a possible later part of #135.
- Falling back to the icon when a named preview image fails to fetch. The owner ruled "names no preview image", so a failed preview stays without a picture, for now (#149 comment 6259932087).
- `favicon.ico` and SVG icons. They are refused, as images are today.
- Guessing icon addresses the page doesn't declare, such as `/apple-touch-icon.png` (see Open questions).
- Telling agents about icons. `get_link`'s `imageUrl` stays the page's preview address.
- Changing how the owner's picture (#145) shows. It still fills its box.
- Decoding images fully. `checkImage` reads only the header, which is #145's deliberate limit (controller ruling).

## 1. The order

What a card shows, first match wins:
1. **The owner's picture** (#145). It fills the box (cover).
2. **The page's preview image** (`og:image`, else `twitter:image`). It fills the box (cover).
3. **The site's icon**, only when the page names no preview image. Shown whole (contain).
4. **The title's initials** on the space colour (the host's initials when there is no title; `initialsText`, src/web/initials.ts:15-18). A box with no initials at all is the plain tint, as today.

Steps 1 and 2 already work this way: the reads coalesce the owner's picture over the fetched one (src/store/sqlite-image-store.ts:72-93).

Steps 2 and 3 never both apply to one link. The snapshot picks what to fetch: the preview when one is named, else an icon. A stored icon is retired as soon as a snapshot names a preview (§4), so a preview that is pending or failed never leaves an old icon showing.

**What "names no preview image" means** (controller interpretation, 2026-10-19; to put to the owner). It means extraction found no acceptable preview URL. A preview the page declares but extraction rejects counts as none, so the icon may show. Extraction rejects a `data:` URL, a URL with a username or password, and a URL over 2,048 characters (src/fetch/extract-metadata.ts:52-62). The reasoning: such a preview could never be shown, and the owner's ruling is about not falling back when a real preview fails to fetch. The backfill uses the same meaning (§8).

## 2. How the icon is chosen

This happens in the extraction child, beside `og:image`, in `src/fetch/extract-metadata.ts`. It is parsed with linkedom and filtered in JS, the same way `imageUrl` is. The result is `iconUrls`: up to two URLs, best first. No new import enters the child, so the import list in src/fetch/AGENTS.md doesn't change.

**Candidates.** Every `<link>` element whose `rel`, split on whitespace and lower-cased, contains the token `icon`, `apple-touch-icon` or `apple-touch-icon-precomposed`. `rel="shortcut icon"` counts, since it contains `icon`. `mask-icon` doesn't.

**Filtered first, then ranked.** Filtering first means an SVG declared `sizes="any"` can't outrank a usable PNG. A candidate is dropped when:
- it has a `media` attribute. Media-specific icons (most often a `prefers-color-scheme: dark` variant) are meant for one display condition. Cards show one icon in both themes, so they take the declaration that isn't media-specific. A site that declares only media icons gets initials (see Risks);
- its `href` fails the URL rule `imageUrl` already uses: it must resolve against the document base, use http or https, have no username or password, and be at most 2,048 characters. That rule moves into one helper that both use;
- it has a `type` attribute (lower-cased, parameters removed) that isn't `image/png`, `image/jpeg`, `image/gif` or `image/webp`;
- it has no `type`, and its URL's path ends in `.svg` or `.ico` (any case). An extensionless ICO gets through this filter. `checkImage` refuses it by its bytes, and the next candidate is tried (below).

**Ranking.** No size is invented for a declaration that gives none.
- **Sized declarations come first, largest first.** `sizes` is a space-separated list of `WxH` entries (the `x` in either case). A declaration's size is the largest `min(W, H)` among its valid entries. Among equal sizes, the later declaration comes first.
- **Unsized declarations come after every sized one, last declared first.** That covers a missing `sizes`, `any`, and only malformed entries. The order follows the HTML standard's "last equally suitable" choice (https://html.spec.whatwg.org/multipage/links.html#rel-icon, as cited by the review).
- The same URL appearing twice counts once. The top two are kept.

Examples:
- **Photopea** (checked 2026-10-17, #149 body) declares `apple-touch-icon` with no sizes and `rel=icon sizes=512x512` at `promo/icon512.png`. The 512 icon is first, and the unsized touch icon is second.
- **Apple's documented pattern** (as the review reports it): an unsized iPhone icon followed by a `sizes="180x180"` icon. The 180 icon is first.

**A bounded fallback, at most two candidates.** If the first icon ends without being stored, the second is tried. That covers a refusal, a body that isn't a kept image type, one too large, one under 64px, a 4xx, and running out of retries. The state lives in `snapshots.icon_next_url` (§3). The image pass's end-write promotes it to `icon_url` and keeps the image pending, in the same compare-and-set (§4). There is no third try.

**The 64px floor is measured from the real bytes.** The declared `sizes` only rank candidates. After an icon is fetched and passes `checkImage`, the image pass reads its header with `readImageHeader` (src/core/image-type.ts:98-107), which gives width and height. If the shorter side is under 64px, the icon ends as `none`, and that brings in the next candidate.
- `checkImage` (:118-124) returns only the type, so the floor reads the header separately.
- The rule is `ICON_MIN_PX = 64` and `iconBigEnough(bytes)`, both in `src/core/image-type.ts`.
- It applies to icons only. A small preview image is kept as it is today.

## 3. The data model

Migration 16 (`LATEST_VERSION` is 15 at 9fecd57; checked by importing src/store/migrations.ts). It is additive and rebuilds nothing:

```sql
ALTER TABLE snapshots ADD COLUMN icon_url TEXT;
ALTER TABLE snapshots ADD COLUMN icon_next_url TEXT;
ALTER TABLE link_images ADD COLUMN role TEXT NOT NULL DEFAULT 'preview'
  CHECK (role IN ('preview', 'icon'));
```

- **`snapshots.icon_url` and `icon_next_url`:** the first and second icon candidates. The code never writes `icon_next_url` without `icon_url`.
- **`link_images.role`:** whether the fetched picture is the page's preview or the site's icon.
  - Every existing row came from `og:image`/`twitter:image`, so the default `'preview'` is the correct value for them.
  - `link_images` has no such column today (src/store/migrations.ts:169-180).
  - It is called `role`, and the field the cards read is `fit`, because `kind` is already taken by the edit dialog's `picture.kind === "page"` (src/web/edit-link.ts:169).
- **No `icon_checked_at` column.** Review alternative 2 is adopted: whether a page has been looked at for an icon is recorded in `snapshots.image_status`, which already exists.
  - From PR B, an extract-stage snapshot that finds neither a preview nor an icon records `image_status = 'none'`.
  - `NULL` with no image URL then means "never looked at for an icon", which is what the backfill selects.
  - The only readers of `image_status` are the image pass's `pending` reads and writes (sqlite-image-store.ts:26, :128) and FakeStore's mirror (fake-store.ts:478, 589-594). None of them reads `none` or `NULL`, so what existing readers see doesn't change.
  - `'none'` already means "nothing usable came of this link's picture". That now also covers "nothing was declared".

All three columns land in PR A, so there is one migration. In PR A nothing writes `icon_url` or `icon_next_url`, and every `link_images` row keeps the `'preview'` role.

## 4. Pending, settle, retirement and freshness

Today a snapshot recorded with an image URL is pending (src/store/sqlite-store.ts:274-299). The image pass fetches it (src/core/image-indexer.ts:99-120), and both writes compare and set on `image_url` (src/store/sqlite-image-store.ts:124-133).

**The pending key is (URL, role).** The URL to fetch is `coalesce(image_url, icon_url)`. The role is `icon` exactly when `image_url IS NULL`. Both writes compare on both, so if a snapshot is re-recorded between the image pass's read and its write, neither a stale write nor a stale end can land with the wrong role. That includes the corner where the page's new `og:image` is the old icon's address.

**`recordSnapshot`.** `SnapshotRecord` gains `iconUrls: string[]` (at most two). It runs in one immediate transaction:
```sql
UPDATE snapshots SET fetch_status = ?, attempts = ?, next_fetch_at = ?, fetched_at = ?,
  title = ?, description = ?, image_url = ?, icon_url = ?, icon_next_url = ?,
  image_status = CASE WHEN coalesce(?, ?) IS NOT NULL THEN 'pending' ELSE NULL END,
  text = ?, last_error = ?, lease_token = lease_token + 1
WHERE link_id = ? AND owner_id = ? AND lease_token = ?;
-- only when that update changed a row and the record names a preview:
DELETE FROM link_images WHERE owner_id = ? AND link_id = ? AND role = 'icon';
```
- PR B changes the `ELSE NULL` arm to `WHEN ? IS NOT NULL THEN 'none' ELSE NULL`, bound to `r.fetchedAt`. `fetchedAt` is set on every extract-stage terminal and null on every fetch-stage one (src/core/snapshot-outcome.ts:137-138).
- **Retiring a stored icon (controller ruling 1, PR A).** When a snapshot records a usable preview URL, the icon row is deleted in the same transaction as the snapshot write.
  - This is done once, at the store, rather than in each reader. Every reader reads `link_images`: `imageVersions`, `image()` (including `?page=1`), `pictureInfo`, and through them the mosaics and the edit dialog. So the icon stops showing everywhere at once, whether the new preview is still pending or later ends as `none` or `refused`.
  - It is in PR A because PR A introduces the role and the store's two-URL contract. The PR A tests create an icon through `recordSnapshot` with `iconUrls`, which the store accepts even though nothing produces them until PR B.
  - A stored *preview* is not removed when a later snapshot names nothing. That is existing behaviour and isn't part of this ruling (see Risks).

**`pendingImages`:**
```sql
SELECT owner_id, link_id, coalesce(image_url, icon_url) AS url, image_url IS NULL AS icon
FROM snapshots WHERE image_status = 'pending' AND link_id > ? ORDER BY link_id LIMIT ?
```
`PendingImage` gains `role: "preview" | "icon"`. `imageUrl` keeps its name and now means the URL to fetch.

**`settle`**, used by `writeImage` and by `endImage` for a preview:
```sql
UPDATE snapshots SET image_status = ?
WHERE link_id = ? AND owner_id = ? AND image_status = 'pending'
  AND coalesce(image_url, icon_url) = ? AND (image_url IS NULL) = ?
```

**`endImage` for an icon (PR B)** promotes the second candidate in the same compare-and-set. All right-hand sides read the old row:
```sql
UPDATE snapshots SET icon_url = coalesce(icon_next_url, icon_url), icon_next_url = NULL,
  image_status = CASE WHEN icon_next_url IS NULL THEN ? ELSE 'pending' END
WHERE link_id = ? AND owner_id = ? AND image_status = 'pending'
  AND image_url IS NULL AND icon_url = ?
```
In PR A an icon's end only settles, because `icon_next_url` is never set there.

**Interface changes:**
- `writeImage(owner, linkId, imageUrl, role, image, at)` and `endImage(owner, linkId, imageUrl, role, end)` (`ImageStore`, src/core/image-store.ts:30-48).
- `writeImage` upserts `role` with the bytes.
- The indexer's backoff key adds the role. A promoted URL is a new key, so its backoff starts fresh.
- For an icon whose bytes fail `iconBigEnough`, `take()` calls `endImage(…, "none")`.

The contract text "for the same `imageUrl`" becomes "for the same URL and role". FakeStore mirrors all of this, including retirement and promotion, and the shared contract tests run against both stores.

**Freshness (controller ruling 7).** The contract is URL plus role, not a generation token.
- Take a link at `X/icon`, re-recorded as `Y/icon`, then as `X/icon` again. A result for `X/icon` fetched during the first period is still accepted in the third. The review ran this sequence and saw it accepted.
- This is accepted on purpose: the result is the bytes of the same URL in the same role, which is what the third snapshot asked for.

## 5. The reader's result shape

`LinkImageReader.imageVersions` (src/core/image-store.ts:58-60) now returns, for each link with a picture:

```ts
export type PictureFit = "cover" | "contain";
export type ShownPicture = { version: string; fit: PictureFit };
imageVersions(owner, linkIds): Promise<Map<string, ShownPicture>>;
```

`fit` is `contain` only when no owner picture shows and the fetched picture's role is `icon`:
```sql
SELECT j.value AS link_id, coalesce(o.sha256, f.sha256) AS sha256,
  CASE WHEN o.sha256 IS NULL AND f.role = 'icon' THEN 'contain' ELSE 'cover' END AS fit
FROM json_each(?) j
LEFT JOIN owner_images o ON o.owner_id = ? AND o.link_id = j.value
LEFT JOIN link_images f ON f.owner_id = ? AND f.link_id = j.value
WHERE coalesce(o.sha256, f.sha256) IS NOT NULL
```

**This replaces** the #145 spec's "`LinkImageReader.imageVersions` keeps its shape" (2026-10-17 spec, §4). The method name stays. Callers that change:
- src/web/http.ts:488, 516, 527, 543, 590 and 645;
- src/core/spaces.ts:48;
- the FakeStore implementation (src/core/fake-store.ts:502);
- the image-store and link-edit-store contracts.

Other changes:
- `PictureInfo` (src/core/image-store.ts:51) gains `pageFit: PictureFit | null`. The dialog uses it for the preview and to word the button **Use the site's icon** when the fetched picture is an icon.
- The edit routes' answer (`cardState`, src/web/http.ts:486-497) gains `fit`, and `picture` gains `pageFit`.
- `image()` and `/images/:id` don't change.

## 6. Cards and mosaics

### One builder for the picture box

`tile(link, picture: ShownPicture | undefined, className)` (src/web/pages.ts:135-138) renders one of three shapes. Every card already calls it: search (pages.ts:170), All links (all-page.ts:118), space pages (space-page.ts:97), Worth a look (home-page.ts:71, 86, 101) and Handy (handy-shelf.ts:90).

| Shown | Markup |
|---|---|
| `fit: "cover"` | `<img class="CLS" src="/images/ID?v=V" alt="" loading="lazy">` (unchanged) |
| `fit: "contain"` | `<div class="CLS icon-box" aria-hidden="true"><img class="site-icon" src="/images/ID?v=V" alt="" loading="lazy"></div>` |
| none | `<div class="CLS initials-box" aria-hidden="true"><span class="pic-initials">AB</span></div>`, with the span left out when there are no initials |

The icon sits on a light, rounded plate in the middle of the card's tinted box, never stretched or cropped.

### Handy

- `.photo` (handy-shelf.ts:89) is set only when `fit` is `cover`. An icon tile keeps the dark caption with no fade.
- The icon sits in the top half, where the initials sit now.
- Handy's own `initials()` helper (handy-shelf.ts:61-64) and its `.handy-initials` element are removed, and the shared shape replaces them. The Handy tests that select `.handy-initials` (handy-shelf.test.ts:116-140, images.test.ts:170) switch to `.pic-initials`, with the same expected text.

### Mosaics

`HomeSpace.mosaic` (src/core/spaces.ts:16-22) gains `fit`. The picks don't change: newest first, of either kind, three at most (spaces.ts:47-55). A `contain` cell renders as `<div class="mosaic-icon"><img class="site-icon" ...></div>` (spaces-section.ts:9-15). Empty cells keep their tints.

### Edit dialog

- `editData` (edit-link.ts:40-55) adds `data-fit` and `data-page-fit`.
- `render()` (edit-link.ts:164) adds `fit-contain` to the preview, and the class `site-icon` to its `img`, when it shows an icon.
- `showCard` (edit-link.ts:239-260) must build the same three shapes as `tile()` from the answer's `version`, `fit` and `initials`. Today it copies the old box's whole class list (edit-link.ts:252-253). Instead, it takes the base class (the first one: `tile` or `card-image`) and drops `icon-box` and `initials-box` before adding the new shape's modifier.
- This is a second copy of the shapes, in the browser script, because the box's class varies by page and the server's answer doesn't know it. A test checks that the two copies agree (§10).

### CSS

There is one new theme token, `plate`: light `#FFFFFF`, dark `#E9E6E0`. Dark mode follows the existing `prefers-color-scheme` block (theme.ts:52).

Transparent icons drawn for light backgrounds would vanish on the dark surface, so the plate stays light in both modes, and off-white in dark mode so it doesn't glare. Handy already backs pictures with white for the same reason (theme.ts:171).

```css
div.icon-box,div.initials-box{display:flex;align-items:center;justify-content:center}
.site-icon{display:block;width:var(--icon,72px);height:var(--icon,72px);padding:calc(var(--icon,72px) / 9);object-fit:contain;border-radius:22%;background:var(--plate);box-shadow:0 1px 4px rgb(0 0 0 / .12)}
.mosaic .site-icon,.edit-preview .site-icon{width:var(--icon,72px);height:var(--icon,72px);min-width:0;min-height:0;object-fit:contain}
.pic-initials{font-size:var(--initials,34px);line-height:1;font-weight:800;letter-spacing:.02em;color:color-mix(in srgb,var(--space,var(--field)) 55%,var(--ink))}
.tile{--icon:72px;--initials:34px}
.card-image{--icon:80px;--initials:40px}
.worth-image{--icon:112px;--initials:56px}
.worth-tile{--icon:56px;--initials:26px}
.handy-image{--icon:56px;--initials:34px}
.handy-image.icon-box,.handy-image.initials-box{inset:0 0 auto;height:50%}
.mosaic-icon{display:flex;align-items:center;justify-content:center;min-width:0;min-height:0;--icon:40px;background:color-mix(in srgb,var(--space,var(--field)) 18%,var(--surface))}
.edit-preview.fit-contain{display:flex;align-items:center;justify-content:center;--icon:88px}
/* inside the existing @media (max-width:600px) block */
.tile{--icon:56px}
```

**Which rule wins:**
- `.mosaic img` (theme.ts:262) and `.edit-preview img` (:319) have specificity (0,1,1) and set `width:100%;height:100%;object-fit:cover`. They beat `.site-icon` (0,1,0).
- So the third line, `.mosaic .site-icon,.edit-preview .site-icon` (0,2,0), restates the size and `contain`, and wins regardless of source order.
- No other existing `object-fit:cover` rule matches the icon `img`, since it carries none of their classes. Those rules are `img.tile` (:139), `.worth-image` (:152), `img.worth-tile` (:166), `.handy-image` (:170) and `.card-image` (:280).
- `div.icon-box` (0,1,1) outranks `.card-image{display:block}` and `.worth-image{display:block}` (0,1,0).

**Other CSS changes:**
- The `.handy-initials` rule (:172) is removed, and so is the `.handy-initials` selector in the guess-dimming rule (:111). That rule keeps `.handy-tile.guess .handy-image`, which covers the new boxes.
- The boxes keep their existing tints (:138, :152, :165, :169, :240, :280).

## 7. Initials everywhere

- **PR A** makes the third shape of `tile()` the only picture-less box. Search, All links, space cards and Worth a look show initials on the space colour, as Handy does (#149 comment 6259932087).
- **Archived cards:** the done pages use the same builders, so they show initials too.
- **Mosaics:** they keep their tints.

## 8. The backfill pass (PR C)

Existing links were snapshotted before icons were looked for, and a successful snapshot is final. A new small pass looks at each of them once. It never re-runs a snapshot, because a failed attempt nulls the title and text (src/core/snapshot-outcome.ts:122). It writes only `icon_url`, `icon_next_url` and `image_status`. The preview, if any, stays the snapshot runner's data.

**Candidates.** This is a cross-owner maintenance read, like `pendingImages`, never used for a request. It follows the copy pass's `backfillCandidates` (src/store/saved-copies.ts:830-854). Links in id order where:
- `s.fetch_status = 'ok'`;
- `s.image_url IS NULL`;
- `s.image_status IS NULL` (never looked at for an icon; §3);
- the link has no fetched picture (no `link_images` row);
- the link isn't flagged dead now (no `link_checks` row with `flagged_at IS NOT NULL`).

**Links with an owner picture are included** (controller ruling 6). Their icon is fetched and stored behind the owner's picture, so removing the owner picture later shows the icon. A dead-flagged link is skipped only while it is flagged. Done links are included.

**One fetch at a time.** A new `core/icon-backfill.ts` has a store interface, `IconBackfillStore`, with `iconCandidates(afterId, limit)` and `recordIconCheck(owner, linkId, iconUrls)`. The SQLite image store and FakeStore implement it, with a shared contract test that includes a two-owner case.

A sweep runs every 15 s and never stops for good. Each sweep:
1. Restarts the scan from the first candidate, as the copy pass does.
2. Skips links waiting out an in-memory backoff.
3. Fetches at most one page with the guarded page fetcher, and reads it with the backfill's own child extractor.

The backoff is the image pass's, from `RETRY_BASE_MS` doubling up to `RETRY_MAX_MS` (src/core/image-indexer.ts:5-6). It is per process, so a restart clears it. Because each sweep re-reads the candidates, a link becomes eligible again on its own when its dead flag clears.

**Every outcome has a result.** "Record" means `recordIconCheck`: icons when the page names no preview, otherwise none.

| Outcome | Result |
|---|---|
| Extraction `ok` | Record from its metadata. A usable preview means record none (controller ruling 2). |
| `timeout`, `out_of_memory`, `crashed` with metadata | Record from that metadata, as for `ok`. |
| `timeout`, `out_of_memory`, `crashed` before any metadata | Record none. These failures come from the page's content (src/core/extract.ts:14-15). |
| Extraction `spawn_failed` | Record nothing; back off. A machine problem, not the page (:16-17). |
| Fetch `refused`, `not_html`, `too_large`, 4xx other than 408 and 429 | Record none. |
| 5xx, 408, 429, timeout, network error, network up | Record none: tried once. |
| Timeout or network error while `canResolve` says the network is down | Record nothing; back off. The link stays eligible. |
| `aborted` at either stage (`stop()`) | Record nothing, with no backoff. |

The network check follows the copy pass, which gets `canResolve` from the link checker (src/start-server.ts:206; src/core/copy-pass.ts:162-167). It matters because the server is a home Mac and the pass starts at boot.

**The write compares and sets.** If a snapshot is recorded between the read and the write, the write changes nothing:
```sql
UPDATE snapshots SET icon_url = ?, icon_next_url = ?,
  image_status = CASE WHEN ? IS NULL THEN 'none' ELSE 'pending' END
WHERE owner_id = ? AND link_id = ? AND fetch_status = 'ok'
  AND image_url IS NULL AND image_status IS NULL
```
- `snapshot_search`'s update trigger fires only on `title`, `description` and `text` (migrations.ts snapshots()), so the keyword index isn't touched.
- A found icon becomes pending. The ordinary image pass fetches it, with its retries, the 64px floor and the second-candidate fallback.

**Wiring in `src/start-server.ts`:**
- `iconBackfill = createIconBackfill({ store: deps.images, pages: fetcher, extractor: iconExtractor, canResolve: (s) => linkChecker.canResolve(s), now: deps.now })`.
- `iconExtractor` is a new `StartOptions` field that defaults to `createChildExtractor()`, as `copyExtractor` does (:117). It forks a child per extraction (extract-runner.ts:85), so it costs no process while idle.
- It doesn't share the snapshot runner's extractor. That extractor runs one page at a time (extract-runner.ts:29-30), and a save waits on its snapshot (`saveWaitMs`).
- In `closeAll`, `iconBackfill.stop()` comes before `fetcher.close()` and `iconExtractor.close()`, following the comment at :137.
- The pass starts with the others.

## 9. What agents see

Nothing changes:
- `get_link`'s `snapshot.imageUrl` is still `snapshots.image_url` (sqlite-store.ts:598, 654).
- `icon_url` and `icon_next_url` are not added to `SNAPSHOT_SELECT`, `SnapshotSummary` (src/core/types.ts:26-32) or the output schema (src/mcp/output-schemas.ts:61).
- An icon-only link reads `imageUrl: null` to agents.

## 10. Tests

Each test is written red first. The discriminating ones are marked ★, with the wrong implementation they catch in brackets.

**Migration (A)**
- A database at 15 migrates to 16. Existing `link_images` rows read `role = 'preview'`, and `role = 'x'` is refused.

**Store and image pass (A), through the shared contracts on SQLite and FakeStore**
- ★ A preview and an icon are both named: the preview is pending, and the preview ends as `none`. Afterwards nothing is pending, no row exists, and the fetcher never saw the icon URL. [Falling back.]
- An icon only: pending as `icon`, stored with role `icon`, and `fit: "contain"`.
- ★ **Retirement.** Store an icon, then re-record the snapshot naming a preview. Check it in four states: (a) pending, (b) ended `none` after a 404, (c) ended `refused`, (d) ended `none` after the retries run out. In each, `imageVersions`, `image()`, `image(…, "page")`, `pictureInfo` and the space mosaic show no icon, and the card shows initials. [Retiring per reader, or only on a successful preview write.]
- ★ **Role compare-and-set.** Read the image as pending `(X, icon)`, then re-record with `image_url = X`. Both `writeImage(X, icon)` and `endImage(X, icon)` return false and write nothing. `writeImage(X, preview)` succeeds. [Comparing on the URL alone.]
- **Freshness.** `X/icon` → `Y/icon` → `X/icon`: a result for `X/icon` is accepted. This pins the URL-plus-role contract.
- An owner picture over an icon gives `cover`; removing it gives `contain` again; `pageFit` is `contain`.
- Another owner's writes return false, and A's rows are unchanged.

**Choosing the icon (B), `extractMetadata` on HTML strings**
- A Photopea-shaped head gives `[icon512.png, touch icon]`.
- ★ Apple's pattern, an unsized icon then a 180×180 one, puts the 180 first. [An invented default size.]
- ★ An SVG with `sizes="any"` beside a 32px PNG gives the PNG. [Ranking before filtering.]
- Two unsized declarations: the later one comes first.
- `apple-touch-icon-precomposed` and `rel="shortcut icon"` count; `mask-icon` doesn't.
- A declaration with `media` is skipped.
- `type="image/x-icon"`, `type="image/svg+xml"`, a typeless `.ICO` and a typeless `.svg` are refused.
- A typeless, extensionless URL is kept.
- `<base href>` is honoured. `javascript:`, `data:`, credentials and 2,049 characters are refused.
- A duplicate URL counts once, and at most two URLs are returned.
- ★ A `data:` `og:image` with a usable PNG icon gives `imageUrl: null` and that icon. [Treating a rejected preview as a named one.]
- The real child sends `iconUrls` (the runner test, per src/fetch/AGENTS.md).

**Floor and fallback (B)**
- ★ A 63×200 icon ends and the second candidate becomes pending. 64×64 is stored. [Using the longer side.]
- ★ `sizes="512x512"` with 32×32 bytes is refused. [Trusting the declaration.]
- ★ A 32×32 `og:image` is still stored. [Applying the floor to previews.]
- ★ An unsized 57px first candidate with a second at 96 stores the 96. An ICO body as the first stores the second. Both failing ends as `none` with no third fetch. [No fallback, or no bound on it.]

**Snapshots (B)**
- `snapshotRecord` carries `metadata.iconUrls`; `pastLastAttemptRecord` and retries carry `[]`.
- ★ An extract-stage snapshot with neither a preview nor an icon records `image_status = 'none'`, and that link is not a backfill candidate. [Leaving it NULL.]

**Display (A)**
- Each card builder (search, All links, space, Worth a look lead, small and gone, Handy) renders the three shapes, with initials from `initialsText`.
- ★ A Handy icon tile has no `.photo`. [`.photo` whenever a version exists.]
- A mosaic `contain` cell renders as `.mosaic-icon`.
- Theme:
  - `--plate` exists in both modes;
  - `.mosaic .site-icon,.edit-preview .site-icon` has `object-fit:contain`;
  - `div.icon-box` sets `display:flex`;
  - the 600px block sets `.tile{--icon:56px}`;
  - no rule names `.handy-initials`.
- ★ In the dialog's script test, start from each shape and save into each of the other two. `showCard` matches `tile()`, including an owner picture on an icon card and **Use the site's icon**. [img-or-div only, or a kept `icon-box`.]
- The isolation guard still finds no outside request.
- A get_link test: an icon-only link has `imageUrl: null`, and the output schema test is unchanged.

**Backfill (C)**
- Candidates: one case each for a flagged dead link, a named preview, a settled `image_status`, a fetch status other than `ok`, and an existing `link_images` row (all left out). A link with an owner picture and a done link are included.
- ★ A dead flag cleared after a sweep makes the link a candidate on the next sweep. [Stopping when empty.]
- ★ The fresh page names a usable preview and an icon: the check is recorded as none, and no icon or preview is written. [Ignoring the preview.]
- ★ A snapshot recorded between read and write makes the write change nothing, and title, description, text and fetch status are unchanged. [An unconditional update.]
- ★ A network error while `canResolve` is false records nothing and the next sweep fetches a different candidate. A 404 records none. [Stamping every failure, or a cursor that skips the link for good.]
- Each row of the outcome table, including `spawn_failed` and a crash before metadata.
- One page fetch per sweep. `stop()` during a fetch records nothing. The pass is stopped before its fetcher and extractor close.

**Browser checks (each PR's verification list).** Chrome at 1280px and 390px, in light and dark mode:
- A: search, All links, Worth a look, Handy and the spaces section, with a card of each shape. Check the computed `object-fit` and size of `.mosaic .site-icon` and `.edit-preview .site-icon`. Then in the edit dialog: an owner upload over an icon card, **Use the site's icon**, and Undo.
- B: new saves of real sites with icons.
- C: old links gaining icons.

## 11. Landing: three PRs, each safe on its own

1. **A: schema, store and display.**
   - Contents: migration 16; `SnapshotRecord.iconUrls` (always empty in A); the two-URL pending and settle; retiring a stored icon in `recordSnapshot`; role in `writeImage`; `ShownPicture` and `pageFit`; the three-shape `tile()`, the mosaic, Handy, the edit dialog and the CSS.
   - Safe alone: no icon is ever found. The only visible change is initials on picture-less cards.
2. **B: finding icons.**
   - Contents: icon choice in `extract-metadata.ts`; `PageMetadata.iconUrls`, with `NO_METADATA` (src/fetch/extract.ts:11) and the metadata-sending fixture children updated; `snapshotRecord` passing it on; `'none'` for snapshots that looked and found nothing; the 64px floor; the second-candidate promotion in `endImage`.
   - Safe alone: new snapshots get icons, and older links keep initials.
3. **C: backfill.**
   - Contents: `core/icon-backfill.ts`, its store methods and contract, and the start-server wiring.
   - Safe alone: a bounded pass that never touches a snapshot's title, text or preview.

**README.md in every PR that changes what the owner sees** (controller ruling 8; AGENTS.md "README in the same PR"): A for initials everywhere, B for icons on new links, C for existing links gaining icons. ROADMAP.md gets the decision entry in A, and an update in any PR that changes a recorded decision.

## 12. Risks

- **Initials will be common.** Many sites declare only `favicon.ico`, which is refused (#149 comment 6259932087).
- **Two candidates at most.** A site whose two best declarations both fail gets initials, even when a third would have passed.
- **Media-only icons.** A site that declares icons only with `media` gets initials.
- **A stale fetched preview.** A re-snapshot that names nothing leaves an old *preview* row showing. This is existing behaviour that this change doesn't alter. Only icons are retired.
- **Header-only checks.** A truncated file that declares 64×64 passes the floor and may not render (review's probe). This is #145's deliberate limit, not changed here.
- **Owner pictures always fill their box,** even a logo. This is a controller default (#149 comment 6259932087).

## 13. Open questions

- **For the owner:** does a declared but rejected preview (a `data:` URL, credentials, too long) count as "no preview image"? The controller's interpretation in §1 says yes.
- Should the server try an undeclared `/apple-touch-icon.png` when nothing usable is declared?
- Should a named preview that fails to fetch fall back to the icon? Ruled "not for now" on 2026-10-18. Revisit once icons have run for a while.
