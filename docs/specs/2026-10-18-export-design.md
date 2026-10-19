# Export: design (2026-10-18)

Issue #130. The owner's rulings are #130's comment of 2026-10-18 ("Owner rulings, 2026-10-18 (in session)"), which is binding. The same comment lists defaults the controller took from the research, any of which can be changed. This revision also applies the controller's rulings on the solution-choice challenge (`.claude/reviews/solution-choice-130-9fecd570345e43dab9581866af81a1dea744e22a.md`, REVISE). Import (#131) follows this export's contract. This is a dated design record; later ROADMAP.md entries override it.

Statements marked **Assumption** are this design's choices, not rulings. Statements marked **Unverified** were not checked against code, docs or a run.

## Change to the issue's default, for the owner

The ruling says the zip is "a plain download link". This design makes it **two steps**. The owner presses **Prepare export**, the server builds the zip in a private folder, and then the page offers **Download**. Three reasons (controller ruling):
- Cloudflare Tunnel buffers responses that aren't server-sent events, by default (Cloudflare's tunnel troubleshooting page, as cited by the challenge; **Unverified** here), so a live stream gets no backpressure from a slow phone.
- Cloudflare answers 524 when the origin sends no response headers for about 100 seconds (**Unverified** here), so one GET that builds and then serves fails for a large library.
- Building to a file makes cancellation, ReadGate fairness and a known `Content-Length` simple.

The links-only JSON stays one plain download link. The controller will put this change to the owner.

## Goal

The server is one home Mac. `deploy.sh` backs up the two databases only when it deploys, onto the same machine (`deploy/deploy.sh:270-280`). The saved-copy folder is "not in the database backups" (README, `AYE_SAVED_COPY_DIR`), although the owner may put it in a synced folder such as iCloud Drive. Export is the only export of the library: something the owner can download and keep elsewhere. From the Apps and keys page the owner gets:
- **a zip** with every link and the owner's data in a versioned `links.json`, the pictures, the saved copies as Markdown with front matter, and a `bookmarks.html` any browser can import;
- **a small JSON download**: the same `links.json`, without files.

## Non-goals

These follow the controller defaults in the ruling comment.
- An MCP tool or CLI command.
- Scheduled exports, and pushing to a cloud folder.
- Import. #131 reads this format; this design fixes the format.
- Compression. Entries are stored, not compressed, since pictures are already compressed.

## What is left out, and why

| Left out | Why |
|---|---|
| Page snapshot text | The saved copy holds the article (owner default). With copies off (`AYE_SAVED_COPY_LIMIT_GB=0` stops new copies, README) or for a page with no article, the zip then holds no article text for that link. The snapshot's title, description and image URL stay, as `page` |
| The search log | Tuning data, not the library (controller default) |
| Meaning vectors and keyword indexes | Rebuilt from the links (controller default) |
| Agent keys, sessions, app connections, the auth database | Secrets and sign-in state (controller default) |
| `link_edits` | One-step Undo state for the edit dialog (`migrations.ts:219-241`) |
| Snapshot fetch state and the copy pass's bookkeeping | Scheduling state; import starts its own fetches |
| `tags.description` | Nothing writes it. The only SQL that names it in `src/store/sqlite-store.ts` is the read in `TAG_COLUMNS` (line 59) |
| Notes removed but still in their Undo window | `listNotes` returns live notes only (`removed_at IS NULL`, `src/store/profile-store.ts:51`) |
| Copies that are `saving`, `none`, `failed`, `no_room` or `too_large` | Nothing to hand out. Import's copy pass decides these again |
| Link ids, url keys, tag ids, note and focus ids | Internal. Links are identified by `url` and tags by `key` |

## Routes

| Route | What it does |
|---|---|
| `POST /export/prepare` | Starts a build for the session's owner. Answers 202, or 409 `already_preparing` while that owner's build runs |
| `GET /export.zip` | Serves the owner's finished zip, or 404 when none is ready |
| `GET /export.json` | Builds and sends the JSON at once; it is small |

All three:
- **Session only:** `requireSession`, as `/connections` uses it (`src/web/http.ts:723`). Agent keys and OAuth tokens only reach `/mcp`.
- **In `CHECKED_PAGES`** (`src/app.ts:48-90`). That list drives the allowed-hosts check (`src/app.ts:153-158`) and the Origin check: a foreign Origin is refused on any method, a missing one only on POSTs (`src/app.ts:159-168`). So `POST /export/prepare` can't be started from another site. A same-site link click on a GET passes. Another site can still link to a GET; the Lax session cookie comes along on that top-level navigation, as it does for the Save page (`src/web/http.ts`). It can start a download but never read it. **Assumption:** that is acceptable, as it is for `/images/:id`.
- **Headers on the downloads:** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Content-Disposition: attachment; filename="aye-links-2026-10-18.zip"` (or `.json`). The date is the build's `exportedAt` in UTC (**Assumption**, open question 1). The zip is `application/zip` with `Content-Length`; the JSON is `application/json; charset=utf-8`.

**Route names, settled:** the ruling comment's default names one route, `GET /export`. The controller's later instructions name these. This design uses the later ones.

No attachment or file response exists in the app yet. The picture routes send whole bodies with `Content-Disposition: inline` (`src/web/http.ts:115`, `:696`, `:720`).

**Serving the file.** `GET /export.zip` opens the file, reads its size from the open descriptor, and streams that descriptor as the body, using Hono 4.13.13's `c.body`, which accepts a `ReadableStream` (`node_modules/hono/dist/types/context.d.ts:13`). @hono/node-server 2.1.4 writes the headers at once and copies the stream, waiting for `drain` (`node_modules/@hono/node-server/dist/index.mjs:757-787`, `:896-958`). It cancels the reader when the connection closes (`:758-762`). A build that replaces the file meanwhile renames a new file over it; the open descriptor keeps reading the old one, so a download in progress stays whole.

## Builds

`src/core/export-builds.ts` holds the build rules. It keeps one state per owner, in memory:
- `idle`;
- `preparing`, with `startedAt`;
- `ready`, with `exportedAt` and `bytes`;
- `failed`, with `at`.

- **One build per owner at a time.** `start(owner)` answers `started` or `already_preparing`. Another owner's build doesn't block it, and nobody learns that another owner is exporting. **Assumption:** per owner rather than one server-wide slot (open question 2).
- **The file** lives in `<dirname(AYE_DB)>/exports/`, which is `~/.aye-links/data/exports/` in the README's setup. The folder is created with mode 0700, and each file is `<first 32 hex characters of sha256(owner id)>.zip` with mode 0600. A build writes `<name>.zip.tmp-<random hex>`, flushes it with `fsync`, and renames it over the old file. So the previous export stays downloadable until the new one is complete. No new `AYE_` setting.
- **Cleanup** (`src/store/export-folder.ts`):
  - At start-up the server empties the folder, since build states live in memory and are lost on restart.
  - A `ready` build schedules a 24-hour timer (unref'd) that deletes its file and returns the state to `idle`.
  - `GET /export.zip` also refuses and deletes a file older than 24 hours, in case the timer ran late after the Mac slept.
  - A failed build deletes its temporary file.
- **Disk:** a build needs free space about the size of the zip, briefly twice that while it replaces an old one. A write error (such as `ENOSPC`) fails the build and deletes the temporary file.
- **Stopping:** the build checks a stop flag before every store read and every file read, including before it queues for the ReadGate. Shutdown sets the flag before the database closes (`closeAll`, `src/start-server.ts:135-150`). It doesn't wait for a read in progress: a read that then fails on the closed database is caught, the build ends as failed, and start-up deletes the leftover file.
- **Logs:** `[export] ready: <links> links, <files> files, <bytes> bytes, <ms>ms`, or `[export] failed: <reason>`. No titles or URLs.

## The Apps and keys page: "Your data"

A new last section on `/connections` (`src/web/connections-page.ts`), `<section id="your-data">`, rendered on the server from the owner's build state:

| State | Shows |
|---|---|
| `idle` | "Download everything you've saved: links, pictures, saved copies and a bookmarks file." **Prepare export** (primary button) |
| `preparing` | "Preparing your export…" (`role="status"`) |
| `ready` | **Download** (a link to `/export.zip`) with "1.2 GB, prepared 18 Oct 14:05. Kept for 24 hours." and **Prepare again** |
| `failed` | "The last export didn't finish." **Try again** |

Under every state sits the plain link **Links only (.json)** to `/export.json`.

**Mechanism: the smallest one the web door has.** There is no polling anywhere in `src/web/`. The page already posts with `fetch` and then calls `location.reload()` (`src/web/connections-page.ts:101`), and home's `refreshShelf` reads the page again and swaps in one section (`src/web/handy-shelf.ts:148-173`). The button posts `/export/prepare` and then swaps in a fresh `#your-data` from `GET /connections`, the same way. While the section shows `preparing`, the script repeats that swap every 5 seconds and stops once it shows anything else. A whole-page reload isn't used, because it would clear a half-typed agent-key name. A 409 swaps in the section too, which then shows "Preparing…". The section has no counts. On a phone the download goes to the browser's downloads (**Unverified** for iOS Safari with a large zip).

## The manifest: `links.json`, version 1

One JSON object. Dates are UTC ISO-8601 strings with milliseconds (`Date.toISOString()`). `null` means none. Every key is always present, except `picture` (see `includesFiles`).

```json
{
  "format": "aye-links-export",
  "version": 1,
  "exportedAt": "2026-10-18T14:02:11.408Z",
  "includesFiles": true,
  "links": [
    {
      "url": "https://example.com/home-batteries",
      "title": "Home batteries, compared",
      "summary": "Compares three home battery systems by cost per kWh.",
      "why": { "text": "Sizing the battery for the cabin", "source": "stated" },
      "tags": [
        { "key": "cabin", "name": "Cabin", "source": "stated" },
        { "key": "energy", "name": "energy", "source": "inferred" }
      ],
      "state": "active",
      "savedAt": "2026-10-01T09:30:00.000Z",
      "savedBy": "claude-code",
      "lastOpenedAt": "2026-10-12T18:00:41.002Z",
      "lastSurfacedAt": null,
      "snoozedUntil": null,
      "page": {
        "title": "Home batteries, compared", "description": "A look at three systems.",
        "imageUrl": "https://example.com/og.jpg", "fetchedAt": "2026-10-01T09:30:04.120Z"
      },
      "tool": null,
      "check": {
        "checkedAt": "2026-10-15T03:00:00.000Z", "result": "alive", "detail": null,
        "firstDeadAt": null, "flaggedAt": null, "stillWorksAt": null
      },
      "picture": { "own": null, "page": "pictures/1-page.jpg" },
      "copy": {
        "status": "ok", "madeAt": "2026-10-01T09:31:10.000Z", "file": "copies/1/copy.md",
        "images": ["copies/1/images/01.jpg", "copies/1/images/02.png"]
      }
    },
    {
      "url": "https://tools.example.org/regex",
      "title": "Regex tester", "summary": null, "why": null, "tags": [],
      "state": "active", "savedAt": "2026-09-20T08:00:00.000Z", "savedBy": "owner",
      "lastOpenedAt": null, "lastSurfacedAt": null, "snoozedUntil": null, "page": null,
      "tool": {
        "status": "kept", "source": "stated", "since": "2026-09-20T08:00:00.000Z",
        "answeredAt": null, "waitDays": 60
      },
      "check": null,
      "picture": { "own": "pictures/2-own.png", "page": null },
      "copy": { "status": "removed", "madeAt": null, "file": null, "images": [] }
    }
  ],
  "tags": [
    { "key": "cabin", "name": "Cabin", "kind": "project", "kindSource": "stated",
      "color": "teal", "pinned": true, "projectStatus": "active" },
    { "key": "energy", "name": "energy", "kind": "topic", "kindSource": "inferred",
      "color": null, "pinned": false, "projectStatus": null }
  ],
  "notes": [
    { "text": "Building an off-grid cabin", "source": "stated",
      "writtenBy": "claude-code", "updatedAt": "2026-10-02T10:00:00.000Z" }
  ],
  "focus": [
    { "text": "Picking a battery", "source": "stated",
      "writtenBy": "claude-code", "createdAt": "2026-10-03T07:45:00.000Z" }
  ]
}
```

Rules:
- **Links** come in `listLinks` order, the order the store issued their ids (`src/core/store.ts:101-105`), in every state. A link's position, starting at 1, is its number `n` in file paths. `n` holds only within one file.
- **Link fields** are `Link` (`src/core/types.ts:47-63`) without `id`, `urlKey` and the snapshot's status. With each tag's `kind` and `kindSource` from `tags`, a link converts back to a `NewLink` (`types.ts:80`). So #131 can restore the why and its source, every tag source, the state and every date exactly (controller default: re-importing restores whys, sources and tags as they were).
- **Tags** on a link keep attachment order and their own `source`. Spaces are pinned tags with a colour (`store.ts:81-92`), so `tags` carries them.
- **`page`** is the snapshot's title, description, image URL and fetch time, or null when nothing was fetched. It is informational only.
- **`tool`** is the Keep handy row (`src/core/tool-store.ts:7-15`) or null. **`check`** is the dead-link check row (`src/core/link-check-store.ts:8-20`) or null.
- **`picture`**: `own` is the picture the owner set and `page` the fetched one, each a path in the zip or null. Each is read by its own explicit read, never one that falls back to the other (see Core).
- **`copy`** is null, or has one of these statuses:
  - `ok`: `madeAt`, `file` and the `images` written;
  - `missing`: an `ok` copy whose file was gone or whose folder check failed;
  - `unreadable`: a read threw or passed its deadline;
  - `removed`: the owner removed it, including a purged tombstone. Import must record it so the link never gets a new copy (removal ruling, ROADMAP.md 2026-10-18, "Removing a copy").
  For every status but `ok`, `file` is null and `images` is `[]`.
- **`notes`** are live notes, oldest first. **`focus`** is the whole focus log, oldest first.
- **`includesFiles`** is true in the zip's `links.json`. In `/export.json` it is false, each link has **no `picture` key**, and `copy` keeps its status and `madeAt` from the ledger with `file: null` and `images: []`. That JSON can say `ok` or `removed`, never `missing` or `unreadable`, since it reads no files. Tombstones survive a links-only export (controller ruling 5).
- **Version 1 stays.** A reader refuses an unknown `format` or a higher `version`. Adding a key is a new version. #131 follows this contract rather than changing it.

**Assumption:** one zod schema for version 1 lives in `src/core/export-format.ts`, used by the exporter's tests and by #131.

**Size.** `links.json` and the zip's central directory grow with the library, unlike the capped files. Rough figures for 10,000 links:
- `links.json` at about 1 KB per link is about 10 MB;
- `bookmarks.html` is a few MB;
- with half the links holding a copy of 5 pictures, about 45,000 entries. Each central-directory record is 46 bytes plus a name of about 25 bytes, so the directory is about 3 MB on disk, and its in-memory records are on the order of 10 MB (**Unverified** per-object overhead).

That is fine for a build that runs once in a while in the background, and it is never held per download.

## The zip layout

```
pictures/1-page.jpg
pictures/2-own.png
copies/1/images/01.jpg
copies/1/images/02.png
copies/1/copy.md
links.json
bookmarks.html
```

- Every name is ASCII: digits, fixed words, and an extension from `IMAGE_EXT` (`src/core/saved-copy.ts:136-141`). So no UTF-8 name flag is needed, and titles never reach a name.
- **Files come first; `links.json` and `bookmarks.html` come last.** Readers use the central directory, so order doesn't matter to them. Writing the manifest last makes it describe exactly what the zip holds.
- Picture files are `pictures/<n>-own.<ext>` and `pictures/<n>-page.<ext>`. Copy files are `copies/<n>/copy.md` and `copies/<n>/images/NN.<ext>`, the names the saved-copy folder uses (`src/store/copy-folder.ts:12`).

### `copy.md` with front matter

The saved-copy design leaves front matter to export (`docs/specs/2026-10-17-saved-copy-design.md:9`, `:26`):

```markdown
---
title: "Home batteries, compared"
url: "https://example.com/home-batteries"
saved: "2026-10-01T09:30:00.000Z"
copied: "2026-10-01T09:31:10.000Z"
tags: ["Cabin", "energy"]
why: "Sizing the battery for the cabin"
why_source: "stated"
---

```

then the Markdown.
- Every value is written with `JSON.stringify`, which YAML reads as a double-quoted string or a flow list, so `:`, `#`, `---` and line breaks stay inside one value.
- `title` is the link's title, else the page's, else the URL.
- `why` and `why_source` are null when there is no why. `why_source` keeps a guess labelled outside the app, as AGENTS.md's "Label guesses" requires.
- **Unverified:** how Obsidian and Joplin map these keys.

**The 2 MiB cap is on the stored copy** (`MAX_COPY_MARKDOWN_BYTES`, `saved-copy.ts:10`). An exported `copy.md` can pass it by its front matter. #131 must strip the front matter (the first `---` block) before checking the cap.

**Unfinished copies** still hold `images/NN-<nonce>` references (`saved-copy.ts:165-166`). Export runs core's `finishedMarkdown` (`saved-copy.ts:173`) on the copy in memory, with the images it read. Each read image becomes `images/NN.ext`; any other reference becomes its alt text. A finished copy is written unchanged, so a picture file that has gone missing leaves its reference dangling. Export never rewrites a finished copy's text: the nonce exists so that page text which looks like a reference is never touched (ROADMAP.md 2026-10-18).

### `bookmarks.html`

The Netscape bookmark format:

```html
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
<DT><H3 ADD_DATE="1760796131">Aye-AI-AI Links</H3>
<DL><p>
<DT><H3>Cabin</H3>
<DL><p>
<DT><A HREF="https://example.com/home-batteries" ADD_DATE="1759311000" TAGS="Cabin,energy">Home batteries, compared</A>
<DD>Sizing the battery for the cabin
</DL><p>
<DT><A HREF="https://tools.example.org/regex" ADD_DATE="1758355200">Regex tester</A>
<DT><H3>Done</H3>
<DL><p>
</DL><p>
</DL><p>
</DL><p>
```

- **Folders:** one top folder, "Aye-AI-AI Links". Inside it is a folder per space (pinned tag) holding that space's active links, then active links in no space, loose, then a "Done" folder holding each archived link once. A link in two spaces appears in both space folders (**Assumption:** acceptable).
- **Attributes:** every tag name goes in `TAGS`, comma-separated, with commas removed from the names. `ADD_DATE` is `savedAt` in Unix seconds. The why goes in `<DD>`. **Unverified:** which browsers read `TAGS`.
- **One physical line per entry.** Chromium's importer parses line by line (the challenge cites its `content_bookmark_parser_utils.cc`; **Unverified** here). The current title rules keep a newline. So for this file only, every run of CR, LF, tab, U+0085, U+2028 and U+2029 in a title, tag name, folder name or why becomes one space, before escaping.
- **Escaping:** text and attribute values are HTML-escaped. The web door's `escapeHtml` is in `src/web/page.ts:4`, which core must not import, so it moves to core (**Assumption**). URLs are only ever `http:` or `https:` (`src/core/url-key.ts:44-48`), and the renderer refuses any other scheme too.

## Core: `exportLibrary`

New core files, behind interfaces:
- `src/core/export-format.ts`: the version-1 types, the zod schema, the manifest builder and the front matter;
- `src/core/export.ts`: what is exported, in what order, and what a missing or removed file becomes;
- `src/core/export-builds.ts`: build states, one per owner, the stop flag and expiry;
- `src/core/bookmarks-html.ts`;
- `src/core/zip.ts`: the writer.

```ts
export type ExportDeps = {
  store: Pick<LinkStore, "listLinks" | "listTags">;
  tools: Pick<ToolStore, "listTools">;
  checks: Pick<LinkCheckStore, "listChecks">;
  profile: Pick<ProfileStore, "listNotes" | "listFocus">;
  images: Pick<LinkImageReader, "pictureInfo" | "image">;
  copies: Pick<SavedCopyReader, "listCopies" | "copyInfo" | "readCopy" | "copyImage">;
  gate: ReadGate;
  now: () => Date;
};
export function exportManifest(deps: ExportDeps, owner: OwnerId): Promise<ExportManifest>; // JSON
export function writeExport(deps: ExportDeps, owner: OwnerId, sink: ZipSink, stop: StopFlag): Promise<ExportSummary>;
```

`ZipSink` is `{ write(bytes: Uint8Array): Promise<void> }`; the store's export folder implements it over a `FileHandle`, awaiting each write.

**Store reads.** New and changed reads each get a contract test and a fake:
- **New `ProfileStore.listFocus(owner)`:** the whole focus log, oldest first. Today the only read is `recentFocus(owner, limit)`, newest first (`src/core/profile-store.ts:54-55`).
- **New `SavedCopyReader.listCopies(owner)`:** the owner's `ok` and `removed` rows with status and `madeAt`. `copyInfo` and `readCopy` see only `ok` rows (`src/store/saved-copies.ts:637-680`).
- **`LinkImageReader.image(owner, id, which)` gains `which: "own"`:** it reads `owner_images` only. Today the default reads the owner's picture and **falls back to the fetched one** (`src/store/sqlite-image-store.ts:84-99`), which is right for display. Export, though, must never label a page picture as the owner's: if the owner chooses "Use the page's picture" after `pictureInfo` was read, a fallback read would return the page's bytes as `own`. Export reads `"own"` and `"page"` explicitly, and an empty answer means no file.
- **No bulk picture-bytes read.** `pictureInfo` (`src/core/image-store.ts:65-66`) says which links have pictures, and the bytes are read one link at a time.

**Order of work in `writeExport`:**
1. Take `exportedAt = now()`. Read links, then the catalog, tools, checks, notes, focus, `pictureInfo` and `listCopies`.
2. For each link in order (checking the stop flag before every read below):
   1. Read its own and page pictures explicitly and write each one that is there.
   2. For a copy that `listCopies` called `ok`, the copy is taken **point in time, per link**:
      - read `madeAt` with `copyInfo`;
      - read `copy.md` and then each `ok` image the read named into memory, one `gate.run` each;
      - **read `copyInfo` again**. Only if it still shows the same `madeAt`, write the images, then `copy.md` with front matter, finished in memory when unfinished.
      - If the copy is gone or changed, write nothing for it and record `removed` (or `missing` when the ledger still says `ok` but a file is gone).
      Each file is under its cap: 2 MiB pictures (`MAX_IMAGE_BYTES`, `src/core/image-type.ts:90`), and at most 20 MiB for a copy and its images (`MAX_COPY_BYTES`, `saved-copy.ts:8`). So one link's files fit in memory.
   3. Yield to the event loop (`await setImmediate()` from `node:timers/promises`) before the next link.
3. Write `links.json`, then `bookmarks.html`, from the reads in step 1 and the outcomes of step 2. Then finish the zip.

**What point in time means.** A removal before a link's recheck leaves that copy out. A removal after the link's entries are written appears in the **next** export, not this one. The store already hides a copy removed during a single file read (`stillOk`, `saved-copies.ts:662-663`, `:696`). The recheck extends that to the whole link.

**Copy reads go through the existing gated reader.** `createCopyReader` (`src/core/copy-reading.ts:84-128`) wraps each read in `gate.run` with the 10-second deadline (`COPY_READ_TIMEOUT_MS`, `saved-copy.ts:13`) and answers `"unreadable"` on a throw or timeout. Export reuses that path, extended to `readCopy` without the `view` wrapper, and records `unreadable` without ending the build.

**Owner scoping** comes from the stores: every read takes the owner (`store.ts:17-18` and each interface's equivalent).

**Consistency.** The reads in step 1 are separate async store calls, so core can't put them in one SQLite transaction. `exportedAt` is taken first. A tool, check, picture or copy row for a link not in the list is dropped. A link's tag that the catalog read lacks is still written on the link, and #131 treats it as a topic. Files are read later than rows, and the per-link recheck settles copies.

## Fairness and cancellation

- **The ReadGate** allows one saved-copy file read at a time, first come first served (`copy-reading.ts:13-79`). A build takes it once per file. Since an owner has at most one build, at most one export read waits in the queue at a time for that owner, so a copy page opened during an export waits behind it and any other owner's build.
- **A timed-out read keeps the slot** until its own promise settles (`copy-reading.ts:18-23`). That is existing behaviour, and export doesn't change it.
- **Between links** the build yields with `setImmediate`, so requests are served between links. A link's own reads run back to back.
- **Stopping** is the stop flag, checked before each read and before queuing for the gate. A read already started finishes, and its result is dropped.
- **The download** is a file. A slow phone or a closed tab affects only the file stream, which node-server cancels on close.

## The zip writer

**Recommendation: hand-written, in `src/core/zip.ts`, with no new dependency.** It is pure and writes to a `ZipSink`, about 150 lines.

**Why not yazl 3.3.1.** I read its `index.js`, in the 3.3.1 tarball from `npm pack`, published 2024-11-23. The facts below are from that file:
- **`addBuffer` keeps every buffer until the end.** It stores a pump closure over the buffer on the entry (`index.js:101-113`) and keeps every entry in `self.entries` for the central directory (`:92`, `:241-244`). `setFileDataPumpFunction` (`:487-489`) never clears that closure. So adding a library's files one at a time holds them all in memory until the zip is finished.
- **It writes without backpressure:** `writeToOutputStream` ignores what `outputStream.write` returns (`:167-170`).
- **The lazy stream entry points avoid holding buffers,** but without a known CRC they set general-purpose bit 3 and write data descriptors (`:446-450`, `:552-568`), which this design avoids.
- **Its ZIP64 checks are per record and correct:** the entry check (`:491-498`), and the end record checks for count, central-directory size and central-directory start, each separately (`:311-330`). They are a good reference for the hand-written writer.

Using yazl with bounded memory would mean feeding it lazy streams and accepting data descriptors. The hand-written writer needs neither.

**How the writer works:**
- **Stored entries** (method 0), each whole before it is written, so the CRC and size go in the local header and no data descriptor is written (bit 3 clear).
- **CRC-32** comes from `zlib.crc32(data[, value])`, "Added in: v22.2.0" (Node 22 docs, read 2026-10-18). The repo requires `^22.19.0` (`package.json` `engines`) and pins 22.21.1 in `.nvmrc`, where `zlib.crc32("hello")` gives `3610a686` (run 2026-10-18).
- **Each write is awaited** on the sink, so memory holds one entry and the small central-directory records.
- **Times** are `exportedAt`, in DOS date and time.

**ZIP64 is decided record by record and field by field** (APPNOTE 4.4.23-24 and 4.5.3, per the challenge and yazl's checks; **Unverified** against the APPNOTE text here). A value at or above its field's maximum is written as the maximum, and the real value goes in a ZIP64 field:

| Field | Limit | When reached |
|---|---|---|
| A central-directory entry's local-header offset | `0xFFFFFFFF` | That entry gets a ZIP64 extra field (`0x0001`) holding the 8-byte offset, and "version needed" 45 |
| A central-directory entry's sizes | `0xFFFFFFFF` | The same extra field holds them, in APPNOTE's order, before the offset. Not reachable under the caps, but decided per field anyway |
| Entry count, in the end record | `0xFFFF` | ZIP64 end record and locator are written; the count field holds `0xFFFF` |
| Central-directory size | `0xFFFFFFFF` | Same, with that field at `0xFFFFFFFF` |
| Central-directory start | `0xFFFFFFFF` | Same, with that field at `0xFFFFFFFF` |

Any one of the last three triggers the ZIP64 end record and locator. Each of the three end-record fields is set to its maximum only if it reached that maximum itself. Local headers hold no offset, and no entry's size reaches 32 bits, so local headers never carry ZIP64 fields.

**All the triggers are reachable:**
- Pictures alone can pass 4 GiB without raising the copy limit: two 2 MiB pictures per link over a few thousand links.
- The entry count passes 65,535 with a few thousand copies of up to 30 images each (`MAX_COPY_IMAGES`, `saved-copy.ts:7`).
- The central-directory start alone can cross: the challenge's worked layout puts the last local header at 4,294,963,199, below the limit, and the central-directory start at 4,296,011,819, above it, with only 2,050 entries (relayed from the review, not recomputed here).

## README

- **PR 1** adds "Download your data" with the JSON download.
- **PR 2** describes Prepare export, Download, the 24-hour expiry, the contents, and the `exports` folder beside the database.
- **Wording:** it is the only export of the library; the database backups stay on the Mac and leave out saved copies, unless the copy folder is in a synced folder.
- **What `src/readme.test.ts` can catch:** no `AYE_` setting, tool or `src/` folder is added, so it has nothing new to check.

## Tests

Written red first. Each one names what breaking it would look like.

**PR 1: the manifest and the JSON download**
- **Owner isolation.** Owner B has distinctive data in every exported table, including a removed copy. A's `/export.json` holds none of B's text, URLs, tag keys or rows.
- **Round trip.** Every link parses with the v1 schema. Converting it to a `NewLink` with the catalog's kinds deep-equals the stored link without `id` and `snapshot`: tag order, every source, `kindSource`, every date to the millisecond.
- **Every state:** an archived link, a snoozed one and one with no snapshot appear.
- **Left out:** a note removed inside its Undo window; snapshot text; no `id` or `urlKey` key anywhere; no `description` key in any entry of `tags`. `page.description` is expected and present.
- **Tombstone kept:** a removed copy, and a purged one, come out as `copy.status: "removed"`, with `includesFiles: false`, no `picture` key, and `file` null.
- **`listFocus` contract:** the whole log, oldest first, owner-scoped, `[]` for an unknown owner.
- **Route:** signed out redirects to `/login`; a foreign Origin gets 403; the headers carry `no-store`, `nosniff` and the attachment filename from an injected clock.
- **Route guard:** `/export.json` has a `READ_ROUTES` entry in `src/mcp/isolation.test.ts` (`src/web/AGENTS.md`, "New routes").

**PR 2: builds, the zip and the page**
- **Validators.** A built fixture zip passes `unzip -t` and `python3 -m zipfile -t`. CI runs on `ubuntu-24.04` (`.github/workflows/check.yml`); **Unverified** that `unzip` is preinstalled. The test fails, never skips, when a validator is missing.
- **ZIP64, one case per trigger,** each checked with `unzip -l` and Python's `zipfile` (central directory and last entry):
  - **Entry count:** 65,536 tiny entries, a real archive, also through `unzip -t`.
  - **Central-directory start only:** the challenge's layout. It is written through a test sink that leaves all-zero bodies as holes in a sparse file, which read back as zeros. The test asserts that no central-directory entry has a ZIP64 extra field, the count and size fields are ordinary, and only the start field is `0xFFFFFFFF`.
  - **Local-header offset:** one more entry past the limit gets the extra field, and only that entry.
  - A full `unzip -t` over 4 GiB is a manual run, recorded in the PR.
- **Contents match the manifest:** every path in `links.json` is in the zip, and every file is named there. Picture bytes equal the stored bytes. `copy.md` is the front matter plus the stored Markdown.
- **Picture identity.** After `pictureInfo`, the owner chooses "Use the page's picture". The zip then has no `-own` file, and the page bytes appear only as `-page`.
- **Removal, point in time:**
  - removed while `copy.md` is read gives no copy files and `removed`;
  - removed between two image reads gives no copy files and `removed`;
  - removed after that link's entries are written: the files stay and the status stays `ok`, and the next export says `removed`.
- **Missing and unreadable:** a deleted `copy.md` gives `missing`; a gate timeout gives `unreadable`. The zip validates either way.
- **Unfinished copy:** one `ok` and one `pending` image give `images/01.<ext>`, the second reference as its alt text, and no nonce anywhere. **Finished copy:** text containing `![x](images/03.png)` as code is written byte for byte.
- **Front matter:** a title with `"`, `:`, a newline and `---` parses back to the same string, and `why_source` is present (**Assumption:** a YAML parser as a dev dependency, or an exact-output check).
- **`bookmarks.html`:**
  - every line holding `<A ` also holds `</A>`, with a title containing CR, LF, U+2028 and a tab;
  - a link in two spaces appears in both folders, and an archived link only in Done;
  - `<script>` is escaped;
  - a non-http URL is refused.
- **Builds:**
  - a second `POST /export/prepare` while preparing gets 409 and starts no second build, while another owner can start;
  - the file mode is 0600 and the folder mode 0700;
  - start-up empties the folder;
  - the 24-hour timer deletes the file, and a file past 24 hours is refused by `GET`;
  - a failed build leaves no temporary file;
  - a download started before a new build completes is byte-identical to the old file, and `Content-Length` equals the file size.
- **Stop:** setting the flag during a pending read means no later read starts, including one waiting to queue for the gate, and the build ends as failed.
- **Fairness:** during a build, a copy-page read through the same gate completes after at most the build's one queued read.
- **Route guard:** `/export.zip` gets a `READ_ROUTES` entry (a second owner gets 404, never A's bytes), and `/export/prepare` gets a `WRITE_ROUTES_TESTED` two-owner test.
- **Gate after deploy (controller ruling):** download a large export through the public address on a phone, and record the size, the time and that `unzip -t` accepts it.

## PR split

1. **The manifest and the JSON download.**
   - `export-format.ts`, `exportManifest`, `listFocus` and `listCopies`;
   - `/export.json` in `CHECKED_PAGES` and `READ_ROUTES`;
   - "Your data" with only the JSON link;
   - the README line;
   - a ROADMAP decision-log entry for this design's rulings, including the two-step change once the owner rules on it.
2. **Builds and the zip.** It closes #130.
   - `zip.ts`, `bookmarks-html.ts`, `export.ts`, `export-builds.ts` and `src/store/export-folder.ts`;
   - `image(…, "own")` and front matter;
   - `/export/prepare` (in `CHECKED_PAGES`, with `WRITE_ROUTES_TESTED`) and `/export.zip` (in `CHECKED_PAGES` and `READ_ROUTES`);
   - the build states on the page and the stop flag in `closeAll`;
   - the README section, the ROADMAP entry, and the gate after deploy.

## Risks

- **The ZIP64 offset cases** are tested through a sparse sink and one manual full run, not a full CI validation.
- **Disk:** a build briefly needs about twice the zip's size if an old export exists.
- **Duplicates:** a link in two spaces imports twice into a browser.
- **A start-up wipe** means a deploy discards a ready export, and the owner prepares again.
- **Delete (#126)** must include the exporter: a deleted link must leave the next export, and a ready export made before the deletion still holds it until it expires.
- **The tunnel and phone behaviour** is proven only by the gate after deploy.

## Open questions

1. The filename date: UTC (this design) or the server Mac's local date?
2. One build per owner (this design) or one across the server?
3. Should copy folders carry a title slug, so an Obsidian vault shows readable names? That brings non-ASCII names and the UTF-8 flag.
4. Should `/export.json` keep `notes`, `focus` and `tags` (this design), or hold links alone? The ruling calls it "links only".
5. Is 24 hours the right time to keep a ready export?
