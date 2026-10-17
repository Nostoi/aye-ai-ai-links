# Saved copy of each page: design (2026-10-17)

Issue #135. The binding owner rulings are #135's last comment (2026-10-17, "Owner rulings ... for the design"). The naming ruling is the comment before it: in the app, in tool text and in code names it is the link's **saved copy** (or reading copy), never "archived", because "archive" already means "I'm done with it". This is a dated design record; later ROADMAP.md entries override it.

Statements marked **Assumption** are this design's choices, not owner rulings. The points that were open have been settled by the owner or the controller (cited where they appear, dated 2026-10-17); the Assumptions that remain are choices nobody has ruled on.

## Goal

When a page goes away or changes, the owner can still read what they saved. For every link whose page has a readable article, the server keeps a **saved copy**: the article as Markdown, with its images in files beside it. The owner reads it on a clean page in the app. Export (#130) can later hand out the same files, which Joplin, Obsidian and similar apps can import.

This is level 1 of the three levels in #135's body. The owner's first #135 comment says it must not be designed as articles-only, so the layout leaves room for:
- **level 2**, a single-file HTML snapshot as fetched;
- **level 3**, a real-browser capture (PDF or screenshot).

Neither is built here.

## Non-goals

- Levels 2 and 3. Only their file names and the ledger's room for them are reserved (see "Folder layout").
- Refreshing a copy. A copy is made once and never re-fetched (ruling).
- Compression. Images are already compressed (ruling).
- Sign-in integrations with Dropbox, iCloud or Google Drive. Cloud copies come from putting the folder inside a folder the Mac already syncs (#135, 2026-10-16 comment).
- Copies of pages behind a login or paywall. Those copy as the page the server sees, and the owner can remove one (ruling).
- Tables, embedded video, iframes and forms. Turndown's core has no table rule, so a table comes out as its text. Adding the GFM plugin is not ruled.
- Agents reading the copy. `get_link` only says whether one exists (ruling).
- Front matter or other metadata inside `copy.md`. The ledger holds the facts; export (#130) can add front matter when it writes files out.

## Dependencies on other work

- **#128 (dead-link checks) lands first.** Its spec (`docs/specs/2026-10-17-dead-link-checks-design.md`, in the `aye-wt-128` worktree) did not exist when this was written. So this design names only what #128's rulings (#128 comment, 2026-10-17) already fix, and leaves the exact names to #128's spec:
  - the dead flag is stored apart from the snapshot, and a check never changes the snapshot's text, title or image;
  - link outputs gain a nullable dead field;
  - a dead link's card has a quiet "This page seems gone" line, plus one dead link at a time on Worth a look, with a slot for the saved copy that stays empty until this lands.
  This design fills that slot, and the backfill skips links #128 has flagged dead.
- **#126 (delete) is not built.** Its rulings are in its body: a soft delete hidden from every reader at once, Undo within 60 s, then "gone means gone" for the link and everything that hangs off it. Files do not cascade with a foreign key, so whichever of #126 and #135 lands second wires the copy's removal into #126's purge (see "Archive and delete").

## 1. Where the copy is made

### New links: in the snapshot pass

The copy is made in the same job as the snapshot fetch (ruling), from the same HTML. Today the HTML is dropped after extraction (`createSnapshotRunner`, src/core/snapshot-runner.ts, passes `fetched.html` to the extractor and keeps nothing).

**The extraction child.** Readability already returns the article as a DOM element (`articleText`, src/fetch/extract-text.ts:103-105, with a serializer that returns the element itself), and `flatten` turns it into the snapshot text. The Markdown is made from that same element:
- `extract-text.ts` gets `readArticle(doc): Element | null`. It runs Readability once, since Readability changes the document. `articleText` becomes `flatten` of that element.
- A new child file, `src/fetch/extract-copy.ts`, holds `articleMarkdown(article, finalUrl): CopyDraft | null`. A `CopyDraft` is `{ markdown, imageUrls }`. The new file joins the list of child files in src/fetch/AGENTS.md and in `extract-runner.test.ts`, under that file's rules: `.ts` imports, strippable TypeScript only.
- **Protocol.** The child's messages become `received`, `metadata`, `text`, then `copy`. `text` is sent before the Markdown work starts, for the same reason metadata goes before text. The runner already settles `ok` once it has `text` and `metadata`, whatever ends the child afterwards (`extract-runner.ts`, close handler). So a deadline, crash or out-of-memory during the Markdown step gives an `ok` snapshot with no copy, never a failed snapshot. The `received` rule in src/fetch/AGENTS.md is unchanged.
- **Asked for, not always made.** The message to the child gains `copy: boolean`, and `PageExtractor.extract` takes it as an option. The runner asks for a copy only when saved copies are on (see "Settings").
- `ExtractOutcome`'s `ok` case gains `copy?: CopyDraft | null`: absent when not asked for or not received, null when no article was found.
- **Save latency.** Sending `text` first protects correctness, not latency. The runner settles only when the child closes, and today the child exits right after `text`. With a copy asked for, it keeps working on the Markdown first, so the snapshot record, and with it a save's 4 s wait (`SAVE_WAIT_MS`), is delayed by the conversion. It is bounded by the extraction deadline and pinned by a budget test (see "Testing").

**Turndown input. Assumption to check first in the build:** turndown is given the Readability element directly. Turndown clones a DOM node it is given. Whether linkedom's nodes satisfy turndown has not been verified. If the first test shows they don't, the element is serialized (`outerHTML`) and turndown parses the string with its own bundled parser. The output is the same either way.

**URLs are resolved in the child, against `finalUrl`.** Readability fixes relative URLs against the document's base. Under linkedom the document has no URL, so that base cannot be trusted. Every `href` and image `src` is resolved explicitly with `new URL(value, base)`. The base is the page's first `<base href>` when it is an http(s) URL, else `finalUrl`. Then:
- a link whose scheme is not `http:`, `https:` or `mailto:` keeps its text and loses its link;
- an image is kept only for an `http:` or `https:` URL. Duplicates (by resolved URL) are numbered once, and only the first 30 distinct images are kept (ruling: at most 30). The 31st and later become their alt text, with no image.

An unresolved relative link would otherwise point into this app, so this step is required, not cosmetic.

**Image references.** A custom turndown rule writes each kept image as `![alt](images/NN)`, where `NN` is its two-digit number (01 to 30), with no extension yet. Image types come from magic bytes, known only after each image is fetched (see "Finishing a copy"). Turndown escapes `[` and `]` in text, so the sequence `](images/NN)` can only come from this rule. A test pins that.

**The runner writes the copy** after `recordSnapshot` succeeds. It calls core's `keepCopy(deps, owner, linkId, draft, now)` (src/core/saved-copy.ts, new) only when all of these hold:
- the outcome is `ok`;
- `draft` is a `CopyDraft`, not null or absent;
- the link is not a kept tool at that moment (a suggested tool, not yet kept, counts as not kept);
- the link has no saved-copy row yet.

`keepCopy` applies the per-copy caps, then asks the store to save it (see "Size ledger"). A kept tool records `none` and gets no copy. A copy refused for room records `no_room`. One that is too large records `too_large`. A copy write that throws is logged and leaves no row, so the backfill picks the link up later. Writing the Markdown is one file and one transaction, so it fits inside the job's lease. The lease default is 120 s; `MIN_LEASE_MS` (55 s) is only the floor, one fetch plus two extractions. A shutdown that comes after extraction finished `ok` still records the snapshot (existing rule), and writes the copy too.

**No article, no copy** (ruling). When Readability finds nothing, the snapshot's text is null and the draft is null. No copy and no row are written, and the backfill's candidates exclude it (it needs snapshot text).

### Existing links: the one-time backfill

Existing links get a one-time backfill (ruling). The HTML of their pages was not kept, so the backfill fetches each page once more.

**Candidates.** A link is a candidate when all of these hold:
- its snapshot is `ok` with non-null text (an article was found at save time);
- it has no `saved_copies` row;
- it is not soft-deleted (#126);
- #128 has not flagged it dead.

A kept tool the backfill reaches is not fetched. It records `none`, so a link that stops being a tool later gets no copy: a copy is made only in the snapshot pass or in this one-time backfill (controller ruling, 2026-10-17).

"One-time" holds per link because every backfill attempt ends in a row (`ok`, `none`, `failed`, `no_room` or `too_large`), and a link with a row is never a candidate again. There is one exception: `no_room` (see "When full").

There are no migration-time rows: the same query also covers links saved while copies were paused, or whose copy step crashed.

**It never touches the snapshot.** The backfill calls `PageFetcher.fetch` and `PageExtractor.extract` and uses only the `copy` part of the outcome. It never calls `recordSnapshot`, so the snapshot's text, title, description and image stay as they were (#128's ruling relies on this). The copy shows its own made-at date, since today's page may differ from the one saved.

**Its own extractor.** `createChildExtractor` runs one child at a time for the whole process (its `tail` chain). The snapshot lease floor assumes only the two snapshot slots queue on it. A backfill sharing that extractor would queue new saves behind old pages. So the copy pass gets its own `createChildExtractor()` instance: a second child, at most one at a time.

**Pace. Assumption:** one page at a time, with at least 10 s between page fetches.

**Outcomes:**

| Fetch and extract | Row |
|---|---|
| `ok` with a draft | saved through `keepCopy` (`ok`, `no_room` or `too_large`) |
| `ok` with draft null (no article now) | `none` |
| `refused`, `not_html`, `too_large`, a 4xx other than 408 or 429 | `none` |
| A kept tool (not fetched) | `none` |
| network error, timeout, 408, 429, 5xx, `spawn_failed`, or an extract crash, timeout or out-of-memory | retried after a backoff kept in memory, doubling from 1 min to at most 1 h. On the 5th failure, `failed`. |
| `aborted` by shutdown | nothing; it stays a candidate |

## 2. Folder layout and the safe path rule

```
<AYE_SAVED_COPY_DIR>/
  .aye-saved-copies          marker: this library's id (see below)
  .aye-tmp/                  writes in progress; the sweep clears stale ones
  <linkId>/
    copy.md                  level 1
    images/
      01.jpg  02.webp  ...   at most 30; the extension is from the magic bytes
    (reserved, not written now: page.html for level 2, capture.pdf or capture.png for level 3)
```

**One folder per link, named by its link id. Assumption:** no owner level in the path. Link ids are integers unique across owners (`links.id INTEGER PRIMARY KEY`). The ledger row, keyed by owner and link, is what binds a folder to its owner, and every read goes through that row first (see "Owner scoping").

**The safe path rule.** A path under the root is built only from:
- the link id, checked against `^[0-9]{1,20}$` (the web door's `isLinkId` pattern);
- fixed names: `copy.md`, `images`;
- image file names the server makes: `^[0-9]{2}\.(png|jpg|gif|webp)$`.

Nothing from the page, the URL or the title ever reaches a path. In addition:
- the root is resolved with `realpath` once at start;
- every file is opened with `O_NOFOLLOW`, and each folder on the way is checked with `lstat` to be a real folder, not a link;
- a resolved path that is not under the root is refused and logged.

**The marker.** On first use the server writes `.aye-saved-copies`, holding a random library id that is also stored in the database (a one-row `saved_copy_library` table). At start:
- a non-empty root with no marker, or with a marker whose id differs from the database's, turns saved copies off with a log line naming the folder;
- an empty root gets a marker.

This keeps the sweep from deleting numeric folders in a folder that was never the app's, such as the home folder chosen by mistake. It also stops a dev server and the live one, whose link ids collide, from sharing a folder.

**Recovering from a mismatch.** A mismatch has one way out, and the log line and README both say it: move the folder aside, then restart; the server starts a new, empty one.
- The case that needs this: the first deploy of this feature writes the library row and the marker, then fails its health check. `deploy.sh` restores the old database, which has no library row, and the next deploy makes a new id that the marker doesn't match.
- Nothing in the moved-aside folder is lost. Its copies have no rows after the restore, so they would be orphans anyway.
- An empty ledger never adopts a marker it finds. Otherwise a fresh dev database pointed at the live folder would adopt it and sweep it.

**Refused roots.** The root must be absolute, and must not be inside `~/.aye-links/releases` or `~/.aye-links/current`, because `deploy.sh` prunes releases. The check uses real paths.

## 3. Size ledger, caps and when full

### Stored data

The next migration adds three tables. All are additive and rebuild nothing.

`saved_copies`: one row per link that has had a copy attempt.

| Column | Meaning |
|---|---|
| `owner_id`, `link_id` | Primary key; deleted with its link by the composite foreign key, as `link_images` is |
| `status` | `saving`, `ok`, `removed`, `none`, `failed`, `no_room` or `too_large` |
| `made_at` | When the copy was written; null unless `saving`, `ok` or `removed` |
| `md_bytes` | Bytes of `copy.md`: its size plus the finishing reserve below until the copy is finished, then its exact size |
| `bytes` | `md_bytes` plus the bytes of every image in `saving` or `ok`: what this copy holds on disk |
| `removed_at` | Set when the owner removes the copy; Undo clears it within 60 s |

`saved_copy_images`: one row per numbered image of a copy.

| Column | Meaning |
|---|---|
| `owner_id`, `link_id`, `n` | Primary key; `n` is 1 to 30; deleted with its copy row |
| `url` | The resolved image URL |
| `status` | `pending`, `saving`, `ok`, `none`, `refused`, `no_room` or `too_large` |
| `content_type`, `size`, `sha256` | Set from `saving` on; same type CHECK as `link_images` |

`saved_copy_library`: one row, the library id the marker must match.

**Space used** is the sum of `bytes` over every row, across owners, because there is one folder and one cap. Rows in `none`, `failed`, `no_room` and `too_large` hold 0. A `removed` row keeps its bytes until its files are deleted, then holds 0 as a tombstone.

### Caps

- **Per file (existing caps):**
  - the page fetch stays at 5 MiB (src/fetch/guarded-fetcher.ts);
  - each image is at most `MAX_IMAGE_BYTES` (2 MiB) and `MAX_IMAGE_PIXELS`, checked by `checkImage` (src/core/image-type.ts);
  - `copy.md` is at most 2 MiB (controller ruling, 2026-10-17). A longer one is `too_large` and no copy is kept. The snapshot text is capped at 100,000 code points, so an article bigger than this is unusual. The cap also bounds the main-process Markdown render (see "The copy page").
- **Per copy (ruling):** at most 30 images and 20 MiB, `copy.md` included.
- **Total:** `AYE_SAVED_COPY_LIMIT_GB` (see "Settings").

These numbers are constants in `core/saved-copy.ts`, and the total comes from settings. Core passes the limits to the store, which applies them inside its transaction.

### Reserve, write, confirm

Two snapshot slots and the copy pass can all write at once, so a check followed by a separate write could let two writers both pass. Every write follows one pattern, so the cap holds and a crash leaves nothing counted wrongly:

1. **Reserve.** In one SQLite transaction (better-sqlite3 runs it synchronously, so it is atomic):
   - check the per-copy and total caps against the bytes about to be written;
   - insert or update the row as `saving` with those bytes.
   If either cap fails, write `no_room` or `too_large` instead, and write no file.
2. **Write.** Write to `<root>/.aye-tmp/<random>`, `fsync`, then `rename` into place. A copy's folder is built in the temp folder and renamed whole.
3. **Confirm.** In a transaction, move `saving` to `ok`. A compare-and-set means a copy row that already exists is never replaced, so copies are write-once.

At start, before any pass runs, each row still in `saving` is undone:
- a copy row is deleted with its folder, which makes the link a backfill candidate again;
- an image row goes back to `pending` with its bytes released and its file deleted.

The reservation for `copy.md` includes the finishing step's worst case: 5 bytes per image reference (`.webp`).

### When full

**Warn at 80%** (ruling). **When full, stop making copies, and never drop old ones** (ruling): that could delete the copy of a dead link.
- A copy refused for room records `no_room`, and its link is otherwise left alone. An image refused for room records `no_room`. Its copy keeps its text, and the image becomes its alt text when the copy is finished.
- Nothing is deleted to make room.
- Once at least 20 MiB is free (the per-copy maximum), `no_room` links become backfill candidates again, so copies resume without the owner doing anything. This converges: a retry either fits and is saved, or stays `no_room`. It re-fetches today's page, which may have changed or died. A dead page then records `none`. (Controller ruling, 2026-10-17: yes, retry.)
- Crossing 80%, reaching full, and dropping back below 80% are each logged once.

**Where the warning shows** (controller ruling, 2026-10-17): a line at the foot of All links. At 80% it is neutral: "Saved copies use 0.8 of 1 GiB." When full: "Saved copies are full, so new links aren't getting one. Raise AYE_SAVED_COPY_LIMIT_GB or remove some copies." When paused (see "Writability"): "Saved copies are paused: the server can't write to its folder." The 80% line uses no amber. The full and paused lines are amber (`needs-you`, src/web/AGENTS.md), since then the owner must act.

There is no settings page today, and the line is not a counter of links.

## 4. The image pass and finishing a copy

The images of a copy are fetched apart from the snapshot job. The job holds its lease for one fetch and its extraction. Up to 30 images of up to 2 MiB each, at 15 s apiece, would not fit.

The pass is modelled on `createImageIndexer` (src/core/image-indexer.ts): the same verdicts, the same backoff kept in memory (doubling from `RETRY_BASE_MS` to `RETRY_MAX_MS`), and `MAX_IMAGE_ATTEMPTS`. It reuses the process's one `ImageFetcher` (src/fetch/image-fetcher.ts), so each image goes through the guarded request: private, loopback and link-local addresses are refused, including after redirects. The image check is `checkImage`.

For each `pending` image, in link and `n` order, one at a time:
- `ok`: reserve, write and confirm as `images/NN.<ext>`, with the extension from the content type the magic bytes named.
- `refused`: `refused`.
- `not_image`, `too_large`, or a 4xx other than 408 or 429: `none`.
- A transient failure: retry; on the last attempt, `none`.
- `aborted`: left pending.

**Finishing a copy.** When the last image of a copy settles, core's pure `finishedMarkdown(markdown, images)` rewrites each `](images/NN)`:
- a stored image becomes `](images/NN.ext)`;
- an image that was not stored becomes its alt text only.

The store writes the result to a temp file and renames it over `copy.md`, and updates `md_bytes` and `bytes` in the confirming transaction.

**This is not a refresh.** It never fetches the page again, and it changes only references the server itself wrote. Until a copy is finished, the copy page resolves `images/NN` through the ledger, so a copy reads correctly at once.

## 5. Settings

Both are read in src/config.ts into `ServerConfig.savedCopies`, and documented in README.md, which `src/readme.test.ts` enforces. Neither name contains ARCHIVE.

| Setting | Meaning |
|---|---|
| `AYE_SAVED_COPY_DIR` | Absolute path of the saved-copy folder. Defaults to `~/.aye-links/saved-copies` (owner, 2026-10-17), beside `data/` and outside `releases/`, as `modelRoot()` is. A relative path, or one inside the release tree, refuses the start, as other bad settings do. |
| `AYE_SAVED_COPY_LIMIT_GB` | The total cap, in GiB (1024³ bytes); a number of 0 or more, decimals allowed. Defaults to **1** (owner, 2026-10-17). The owner can change it: it is a server setting, documented in README. `0` turns saved copies off: no new copies are made, and existing ones stay readable (controller ruling, 2026-10-17). A negative or non-number value refuses the start. |

Saved copies are on by default, since the ruling covers every link with an article. When the limit is `0` the runner asks the extractor for no copy, the copy pass makes none, and the reads, the copy page and removal keep working on what exists.

`startServer` gains `savedCopyDir` and `copyFetcher`/`copyExtractor` seams for tests, so no test writes under `~/.aye-links`.

**Start and shutdown.** The copy pass is one runner (`createCopyPass`, src/core/copy-pass.ts). Each sweep does these in order: purge removed copies past the window, backfill, then pending images; the orphan sweep runs on its own schedule. It has the image pass's lifecycle: `start`, `quiesce`, `stop`. `startServer` fits it into the existing shutdown order:
- it starts with the others, after the server is listening, once `undoUnconfirmed` has run;
- it quiesces with the runner, the indexer and the image pass;
- its `stop` (which aborts its fetch in flight) is awaited inside the settle window with theirs;
- it is stopped again before the image fetcher, the page fetcher and both extractors close, for the reason the image pass's comment gives: a closed fetcher would end its fetch as a failure.

Its own extractor closes with the snapshot extractor.

## 6. Writability, including macOS sync folders

The owner may put the folder inside an iCloud Drive, Dropbox or Google Drive folder (#135, 2026-10-16 comment). The server runs as a LaunchAgent (deploy/com.aye-links.plist). macOS grants access to protected folders per program, so a write from Terminal or from `deploy.sh` proves nothing about the service.

So **the check runs inside the server process, at start, by trying**:
1. create the root if missing;
2. write `.aye-tmp/write-check-<pid>`, `fsync`, read it back, rename it, delete it.

Any error turns saved copies **paused**: no copies are made and no folders are swept. Existing copies are still served if they can be read. The log names the folder and the error. For a permission error (EPERM or EACCES), the log suggests granting the Node binary access in System Settings → Privacy & Security, then restarting the service. The check runs again before each copy pass sweep, so copies resume once it passes, with no restart. While paused, the calm line in §3 says so.

A failed check pauses copies and does not refuse the start (controller ruling, 2026-10-17), so a sync client that mounts late at login cannot keep the whole app down.

**Files the sync client moved to the cloud.** iCloud's "Optimize Mac Storage" and Dropbox's online-only files can evict files from the disk. Reading one then waits for a download. Each copy-page read has a 10 s timeout (**Assumption**). Past it, or when offline, the page says "The saved copy couldn't be read just now." **To verify in the build:** whether such a read blocks one of libuv's 4 worker threads until the download ends. A JavaScript timeout does not free that thread, and the same threads serve file reads and `dns.lookup`. If it does block, copy reads go one at a time.

Sync clients may also add their own files (`.DS_Store`, "copy.md (conflicted copy)", `Icon\r`). The sweep leaves anything it did not name alone.

## 7. Owner scoping and interfaces

Core depends on interfaces, and owner scoping lives in `store/`. One implementation in `src/store/saved-copies.ts` composes the SQLite ledger and the folder. Every read and write that takes an owner checks the ledger row for that owner and link before touching a file, so B naming A's link id reads nothing. The interfaces are split by caller (interface segregation), with a shared contract test run against the real store (on a temp folder) and an in-memory fake, including two-owner cases:

- **`SavedCopyWriter`** (snapshot runner and copy pass):
  - `saveCopy(owner, linkId, draft, limits, at)` returns `saved`, `exists`, `no_room` or `too_large`;
  - `recordNoCopy(owner, linkId, status)`;
  - `saveCopyImage` and `endCopyImage`, each comparing and setting on `pending`;
  - `finishCopy`.
- **`SavedCopyMaintenance`** (copy pass only; cross-owner, never for a request):
  - `backfillCandidates(afterId, limit)`, `pendingCopyImages(afterId, limit)`;
  - `undoUnconfirmed()`, `purgeRemoved(before)`, `sweep(graceMs)`;
  - `usage()`, which returns used and limit bytes.
- **`SavedCopyReader`** (web and MCP doors):
  - `copyInfo(owner, linkIds)` returns, per link with an `ok` copy, `{ madeAt }`;
  - `readCopy(owner, linkId)` returns the Markdown, `madeAt` and the image map, or `missing`, or null;
  - `copyImage(owner, linkId, n)`.
- **`SavedCopyRemover`** (web door): `removeCopy(owner, linkId, at)` and `restoreCopy(owner, linkId, since)`.

Rules stay in core:
- which links get a copy;
- the caps;
- the Markdown finishing;
- the Undo window.

The doors only translate.

## 8. The copy page

### Route and rendering

`GET /links/:id{[0-9]+}/copy`, signed in, renders a "Saved copy" page on the server (ruling) through `page(title, body, { home: true })`. The `menu` option is not used, because it injects the inline Sign out script (src/web/page.ts, `MENU_SCRIPT`) and this page runs no script. The header links home.

The page shows:
- the link's title (the one that shows on cards);
- the site, linking to the original URL with `target="_blank" rel="noopener noreferrer"`. The opening is not recorded: `openedScript` is a script;
- "Saved copy from March 12, 2026", from `made_at`, read with `savedOn`;
- one neutral line: "A reading copy kept by this app. The page itself may have changed since.";
- the rendered article.

When the link is not the owner's, does not exist, is soft-deleted (#126), or has no `ok` copy, the route answers 404 with the same body each time. A row whose files are gone answers 200 with "This saved copy's files are missing." That happens after `deploy.sh` restores a database backup, which does not include the folder, or after files are deleted by hand.

**Markdown rendering** (`src/web/copy-markdown.ts`), with markdown-it configured as follows:
- `html: false` (raw HTML off, per the ruling), `linkify: false`, `typographer: false`;
- **Link schemes:** `validateLink` allows only `http:`, `https:` and `mailto:`. Any other link renders as its text. Links get `rel="noopener noreferrer nofollow"` and `target="_blank"`.
- **Local images only:** an image renders only when its source matches `^images/[0-9]{2}(\.(png|jpg|gif|webp))?$` and the ledger has that image as `ok`. It is rewritten to `/links/<id>/copy/images/<n>?v=<first 16 of sha256>`. Every other image, remote URLs and `data:` among them, renders as its alt text. The page makes no outside requests (src/web/AGENTS.md; the isolation guard checks this).
- Rendering happens per request in the main process. It is bounded by the 2 MiB `copy.md` cap. A test pins a time budget for the largest allowed copy, so rendering stays bounded whatever the markdown-it version (see "New dependencies").

### Headers

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'none'; img-src 'self' data:; style-src 'sha256-<hash of page()'s one style block>'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `Cache-Control` | `no-store` |

Notes on the policy:
- **`data:` in `img-src`** is for the favicon, which is a `data:` URI (src/web/logo.ts). The renderer never emits a `data:` image.
- **The style hash** is computed once from the same string `page()` inlines, so a theme change cannot drift from it. No page puts `style=` attributes in its markup today; a test keeps it that way for this page.
- **No `sandbox` directive**, unlike stored images. A sandboxed document has an opaque origin, so its image requests would not carry the session cookie, and the owner-checked image route would refuse them.
- No HTML page sends a CSP today, and this changes no other page.

### Copy images

`GET /links/:id{[0-9]+}/copy/images/:n{[0-9]{1,2}}`, signed in, serves one `ok` image of the owner's copy with the existing `imageHeaders` (src/web/http.ts): `nosniff`, `default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, and a private cache only when `?v=` matches. Anything else gets the same 404 as `/images/:id`.

### Where it is linked from

- **The card ⋯ menu** (`cardMenu`, src/web/card-menu.ts) on search results, All links and space pages, only on cards whose link has an `ok` copy (one `copyInfo` read per page, like `imageVersions`). Two rows:
  - **Read saved copy**, a link to the copy page. `MenuItem` gains an optional `href`, rendered as an `<a>` row.
  - **Remove saved copy**, a button with an Undo bar (see "Removing a copy").
  Archived links keep their copy and show the menu in search results. The done pages have no menu today and get none.
- **A dead link's card** (#128's slot): "Read the saved copy", when there is one. Where exactly is #128's markup.

### Removing a copy

The owner can remove a copy (ruling). Under src/web/AGENTS.md, removal is done at once and shows an Undo bar, so the control is in the ⋯ menu, which has page script and the bar, not on the script-free copy page.
- `POST /links/copy/remove` `{id}` sets `removed_at` and status `removed`. The copy is hidden from every reader at once.
- `POST /links/copy/restore` `{id}` brings it back while `removed_at` is within 60 s (**Assumption:** a new `COPY_UNDO_WINDOW_MS` of 60 s, matching notes and keys).
- After the window, the copy pass deletes the files. The row stays as a 0-byte tombstone, so the backfill never re-makes the copy.

Both routes join `CHECKED_PAGES` in src/app.ts and `WRITE_ROUTES_TESTED`, each with a two-owner test.

### Route guard

- Both GET routes get `READ_ROUTES` entries in src/mcp/isolation.test.ts. The page has A's copy text as its marker. The image route has A's image bytes as its marker, and B must not get those bytes.
- The copy page joins `CHECKED_PAGES` as a pattern, for the host check, as the other signed-in GET pages do. **To verify in the build:** that Hono's `app.use` matches `/links/:id{[0-9]+}/copy` there.
- The image route follows `/images/:id`, which is not in `CHECKED_PAGES`.

## 9. Agents

`get_link`'s output gains `savedCopy: { madeAt: string } | null` at the top level, beside `snapshotText` (ruling: `get_link` says whether a copy exists).
- It is a nullable field, not an enum value. `tools/list` is open to added fields, and an added enum value breaks clients holding an earlier list (ROADMAP, 2026-10-11 #39 entry).
- Core's `getLinkWithText` reads it through `SavedCopyReader.copyInfo`.
- No Markdown and no copy text go into any tool output (ruling).
- `GET_LINK` (src/mcp/guidance.ts) adds one sentence: savedCopy says whether the server keeps a saved copy of the page, which the owner can read from the link's ⋯ menu on the web page.

## 10. Archive and delete

- **Archive** ("I'm done with it") keeps the copy (ruling).
- **Delete (#126)** removes it (ruling: "gone means gone"). The ledger rows go with the link by foreign key when #126 purges it. The files are deleted in the same purge step, through `SavedCopyRemover`'s file deletion, after the 60 s Undo window, never at the soft delete. A soft-deleted link's copy is hidden at once, because the reads join the link and respect #126's hidden state. Whichever of #126 and #135 lands second wires this.
- **Orphan sweep** (`SavedCopyMaintenance.sweep`), at start after `undoUnconfirmed`, then every 6 hours (**Assumption**). It never runs while paused, or when the root or its marker is missing.
  - It deletes a `<linkId>` folder (name `^[0-9]{1,20}$`, a real folder) that has no ledger row and is older than 1 hour.
  - It deletes a `.aye-tmp` entry older than 1 hour.
  - Inside a folder that has a row, it deletes an image file the ledger does not list as `saving` or `ok`.
  - It deletes only names it could have made. A folder is removed only once empty. Any other file is left, and logged once.
  - It never deletes a ledger row because its folder is missing. That row renders as "files are missing".
  This also cleans up after a deploy rollback: a restored database lacks the rows of copies made after the backup, so their folders become orphans. Their links become candidates again and are re-fetched.

## 11. New dependencies (pinned exactly)

| Package | Version | Where | Why |
|---|---|---|---|
| `turndown` | `7.2.4` (2026-04-03) | `dependencies` | HTML to Markdown, in the extraction child (ruling) |
| `@types/turndown` | `5.0.6` | `devDependencies` | Turndown ships no types |
| `markdown-it` | The newest 15.x release at least 14 days old at build time, checked with `npm view markdown-it time`, pinned exactly | `dependencies` | Markdown to HTML for the copy page (ruling) |

Notes:
- markdown-it 15 ships its own type definitions (`dist/markdown-it.d.mts`), so `@types/markdown-it` (14.2.0, for v14) is not added.
- The 14-day rule applies to every dependency here (controller ruling, 2026-10-17). `turndown` 7.2.4 (2026-04-03) qualifies. No release under two weeks old is pinned.
- The rendering time-budget test (see "Testing") bounds rendering whatever the markdown-it version, since Markdown made from third-party pages can hit quadratic-time parse paths.
- Turndown pulls in `@mixmark-io/domino` (^2.2.0). It is used only if the string fallback in §1 is needed.

## 12. Errors and edge cases

- **Login or paywall page:** copied as that page when Readability finds an article in it (ruling). The owner removes it from the ⋯ menu.
- **Kept tools** (controller ruling, 2026-10-17):
  - a link that is a kept tool when its copy would be made gets none, and records `none`;
  - `save_link` writes `handy` after `saveLink` has kicked the job and waited up to 4 s (`applyHandyToSaved`, src/mcp/server.ts), so a link saved straight onto the shelf usually gets its copy before it becomes a tool, and that copy is kept;
  - making a link a tool later keeps its copy;
  - a link that stops being a tool gets no backfill copy, since a copy is made only in the snapshot pass or the one-time backfill;
  - suggested tools (not yet kept) count as not kept, so they get copies.
- **A page that changed, or died, after the copy:** the copy is never replaced. Copies are write-once, and nothing fetches a page for a link that has a row.
- **Same image twice:** numbered once.
- **An image that 404s:** `none`; it becomes its alt text when the copy is finished.
- **A copy over 20 MiB through its images:** the image that would cross the cap is `too_large`, and the copy keeps the rest.
- **Shutdown during the copy pass:** a fetch is aborted and left pending; a write in progress is undone at the next start.
- **Two writes of one copy** (a kick and the backfill both reaching one link): the second `saveCopy` finds the row and returns `exists`.
- **The folder deleted by hand while running:** writes fail and pause copies at the next check, reads say "missing", and nothing in the database is deleted.
- **A copy page for a link whose copy is still `saving`:** 404, as "no copy yet".

## Testing

Each test is written red first. The discriminating ones:

- **Child, text before copy:** a fixture child that sends `received`, `metadata` and `text`, then hangs past the deadline. The snapshot is recorded `ok` with its text, and no copy row or folder exists.
- **Child, copy:** a fixture page with relative links, a `<base href>`, `javascript:` and `data:` links, 32 distinct images (two duplicated), and text containing a literal `](images/01)`. The Markdown has absolute http(s) links only, `images/01` to `images/30` with no 31st, and the literal text escaped.
- **Save latency:** for the fixture article, the snapshot is recorded within a fixed budget with copies on, compared with copies off.
- **Shutdown:** a stop during a copy-pass image fetch leaves that image `pending` and no row in `saving`, and a stop during a backfill fetch leaves the link a candidate.
- **Marker after a rollback:** a database without the library row, pointed at a folder with a marker, pauses copies and deletes nothing.
- **Turndown input:** the linkedom-element path produces the same Markdown as the string path for the fixture. This settles the §1 assumption.
- **Write-once:** a copy exists; a second `saveCopy` of different Markdown for the same link returns `exists`, and `copy.md`'s sha256 is unchanged.
- **Backfill leaves the snapshot alone:** after a backfill of a link whose page now has a different title and text, the snapshot's title, description, image URL and text are byte-for-byte unchanged.
- **Tombstone:** a link whose copy was removed gets zero page fetches from the backfill (counting fetcher).
- **When full:** with the limit set just above current use, a new copy records `no_room`, writes no file under the root, and every existing copy's files are still there.
- **Race for the last bytes:** two `saveCopy` calls whose drafts each fit alone but not together. Exactly one is saved and the other is `no_room`, and used bytes stay at or under the limit.
- **31st image:** the image fetcher is never asked for the 31st URL.
- **Finishing:** stored images get their magic-byte extension, a `none` image becomes its alt text, and `md_bytes` matches the file's size.
- **Unconfirmed writes:** a crash between reserve and confirm (simulated by a store that throws after the write) is undone at start. No row stays `saving`, and no folder is left.
- **Safe paths:** a symlinked `images` folder, a symlinked `<linkId>`, and a root that is a symlink to a release folder are each refused, and nothing is written outside the root.
- **Marker:** a non-empty root with no marker, or another library's marker, pauses copies, and the sweep deletes nothing in it.
- **Sweep:** it deletes an orphan numeric folder older than 1 hour. It leaves alone a fresh orphan, `.DS_Store`, a "copy.md (conflicted copy)" file, a non-numeric folder and a row with a missing folder. It does nothing when the root is missing.
- **Rendering:** a copy containing:
  - raw `<script>`;
  - an `<img onerror>`;
  - `[x](javascript:alert(1))` and `[x](data:text/html,...)`;
  - a remote image;
  - `images/31`;
  - a relative link.
  The output has no `<script`, no `on…=` attribute, no `javascript:` or `data:` href, no remote `src`, and no image for `images/31`. The response's CSP equals the exact string above, its style hash matches `page()`'s style block, and the page has no `<script` at all.
- **Render budget:** the largest allowed `copy.md` (2 MiB of adversarial reference definitions and unclosed comments) renders within a fixed budget.
- **Owner isolation:**
  - B's `GET /links/<A's id>/copy` and `/copy/images/1` get 404 with no A text or bytes;
  - B's `POST /links/copy/remove` of A's id gets 404, and A's row and files remain;
  - a POST without a same-site Origin gets 403.
- **Remove and Undo:** after remove, the page 404s and `get_link`'s `savedCopy` is null. Restore within 60 s brings both back. After 60 s the files are deleted, the row is a 0-byte tombstone, and restore is refused.
- **Delete (#126):** after the purge, the folder and rows are gone. A soft-deleted link's copy page is 404 at once.
- **`get_link`:** `savedCopy` is `{ madeAt }` for a link with an `ok` copy, and null for `saving`, `removed`, `none` and no row. The output schema test passes in both protocol eras.
- **Settings:** a relative `AYE_SAVED_COPY_DIR`, a dir inside the release tree, `AYE_SAVED_COPY_LIMIT_GB=-1` and `abc` each refuse the start. The defaults are `~/.aye-links/saved-copies` and 1 GiB. `AYE_SAVED_COPY_LIMIT_GB=0` starts, makes no copy for a new link (no row, no file, the extractor not asked for one), and still serves and removes an existing copy. `readme.test.ts` finds both names in README.md.
- **Kept tools:** a link that is a kept tool at snapshot time gets no copy and a `none` row, and is not fetched by the backfill, even after it stops being a tool. A copy made before the link became a tool stays readable after it does. A suggested tool gets a copy.
- **Writability:** a root whose write check fails (a read-only temp folder) pauses copies, keeps serving existing copies, and resumes after the folder becomes writable, with no restart.
- **Pages:** cards with a copy have both menu rows, and cards without one have neither. The All links foot shows the 80%, full and paused lines at the right thresholds: neutral at 80%, amber (`needs-you`) when full or paused.
- **In the browser:** a Chrome render of the copy page at 1280px and at 390px, with images, and the menu rows on a card.

## README and ROADMAP updates

**README.md** (same PR, per AGENTS.md):
- a "Saved copies" item under "What it does": what is copied and what is not (no article, kept tools), never refreshed, where to read it, how to remove one, what happens when full;
- both settings in "Run it on your Mac", including:
  - how to put the folder in iCloud Drive or Dropbox, and that the synced service then stores the copies;
  - granting the Node binary folder access if the log says the folder can't be written;
  - that the folder is not in the database backups;
- the `get_link` row: "and whether a saved copy exists".

**ROADMAP.md** (same PR):
- the Later row's "an archived copy of each page (#135)" becomes "a saved copy of each page (#135)". The owner asked for this in "the next PR that touches ROADMAP" (#135, 2026-10-17 renaming comment). So it belongs in the first PR that touches ROADMAP.md, which may be the one landing this spec or #128's, and the build PR does it only if it is still undone;
- a dated decision-log entry recording the rulings above, this spec as the design, and that #135's rulings override the 2026-10-10 spec's "Not stored now: full-page archives" (ruling). The 2026-10-10 spec is a dated record that AGENTS.md says is not updated, so the override lives in the ROADMAP entry and the old spec's text stays as it is.

**AGENTS.md:** the folder map's `fetch/` line ("page snapshots and preview images") gains "and saved copies". `store/` (SQLite persistence) gains "and the saved-copy folder". **src/fetch/AGENTS.md:** `extract-copy.ts` joins the list of child files, and the protocol line names `copy` after `text`.
