# Dead-link checks: design (2026-10-17)

Issue #128. The owner's rulings are from the 2026-10-17 session, recorded in #128 comment 6241000784. That comment is binding, and this design implements it. The pairing with #135 (the saved copy) is from #128 comment 6225434952 and #135 comment 6241001150. This is a dated design record; later ROADMAP.md entries override it.

Points the rulings left open are marked **Assumption**. Each is now settled: A3 and the shelf tile's colour by the owner (2026-10-17), and A1, A2 and A4 to A7 by the controller, who accepted them as written (controller ruling, 2026-10-17).

## Goal

Saved links rot: a page is taken down, or a site's name lapses. Today nothing notices. The page is fetched once at save time. Final snapshot statuses hold a null `next_fetch_at` (`hasConsistentSchedule`, src/core/snapshot-store.ts), so nothing fetches it again. Dead-link checks:
- check every saved link again now and then, through the same guarded request rules as snapshots;
- flag a link only on clear signals, so a login wall or a flaky server never reads as gone;
- show a flagged link quietly on its cards, and ask about one at a time on Worth a look;
- let the owner archive it ("I'm done with it") or say "It still works", both with Undo;
- leave a place for the saved copy (#135), which a dead link will offer.

## Non-goals

- Spotting a redirect to another site, or a parked domain (deferred by the ruling). A soft 404 (a 200 page that says "not found") is the same kind of signal and is also out of scope.
- A new snapshot status, or any change to snapshots. A check never re-fetches the page's text, title or image.
- An MCP action for "It still works", and a `get_digest` reason for a dead link. Neither was ruled. Agents can already archive a link with `update_link`.
- Counts of dead links anywhere: no totals, badges or "3 links seem gone".
- Settings. The cadence and politeness limits are constants in core, not `AYE_` settings.

## Stored data

Migration 14 adds the `link_checks` table. Existing tables are unchanged; snapshots and `link_images` are not touched.

| Column | Meaning |
|---|---|
| `owner_id`, `link_id` | Primary key. Deleted with its link through a composite foreign key, `ON DELETE CASCADE`, as `link_tools` rows are |
| `checked_at` | When the last check started (epoch ms) |
| `result` | The last check's verdict: `alive`, `dead` or `unknown` ("couldn't check") |
| `detail` | What the last check got, for logs and tests: `http:404`, `network:ENOTFOUND`, `http:403`, `timeout`, `refused:address`, … Null for `alive` |
| `first_dead_at` | The first dead check since the last alive one, or null |
| `flagged_at` | When the link was flagged as gone, or null |
| `still_works_at` | The owner's last "It still works", or null |

CHECKs: `result IN ('alive','dead','unknown')`; `flagged_at IS NULL OR first_dead_at IS NOT NULL`.

**No backfill, and no change to saving.** A link with no row has never been checked. The due read treats its `saved_at` as its last check, so a new link is first checked a week after it was saved. By then its snapshot has finished: the snapshot's retries add up to about 31 hours (`RETRY_DELAYS_MS`). On the first start after deploy, every link saved more than a week ago is due. The runner works through them one at a time (see Politeness), which takes a few minutes for the live library.

**Store interface (core/link-check-store.ts).** `LinkCheckStore` is implemented by a new `SqliteLinkCheckStore` (src/store/sqlite-link-checks.ts) and by `FakeStore`, with a shared contract test, as `LinkEditStore` is. Every method takes the owner, except the first:
- `dueChecks(cutoffs, limit)`: the cross-owner maintenance read for the check runner. It is documented the way `pendingImages` (src/core/image-store.ts) is. `cutoffs` is `{ active: Date, archived: Date }`, worked out by core. It returns `{ owner, linkId, url }` for links whose last check (or `saved_at`, with no row) is at or before the cutoff for their current state. Oldest first, ties by id, at most `limit`. Core supplies the cutoffs, so the store holds no cadence rule.
- `getCheck(owner, linkId)` returns the row, or null.
- `listChecks(owner)` returns every row of the owner's, keyed by link id, for card views from one read (as `listTools`).
- `updateCheckIf(owner, linkId, expected, next)`: the conditional write, compared by value as `updateToolIf` and `sameTool` do. It returns `{ check, applied }`, or null when the link is absent, foreign or never issued.

`dueSnapshots` is not the only cross-owner read: `pendingImages` and the vector index's `indexPage` and `retireModels` cross owners too. `dueChecks` is one more of that kind: maintenance for a background pass, returning nothing to any door.

## The rule for "dead" (core/link-check.ts)

Every rule lives here; the runner and the doors only call it.

**Verdict of one check**, from the checker's outcome (below):

| Outcome | Verdict |
|---|---|
| A 2xx answer, after any redirects | `alive` |
| `http_error` 404 or 410 | `dead` |
| `network_error` with code `ENOTFOUND` (the name doesn't resolve), when the guard below allows it | `dead` |
| `http_error` 401 or 403 (a login wall), any other 4xx (400, 405, 408, 429, 451, …), any 5xx | `unknown` |
| `timeout`, any other `network_error` (`EAI_AGAIN`, `ECONNREFUSED`, `ECONNRESET`, TLS codes such as `CERT_HAS_EXPIRED`), `refused` (address, scheme, redirects) | `unknown` |
| `aborted` (shutdown) | nothing is recorded |

The final answer decides, so a redirect chain that ends in 404 is dead. A chain whose later hop names a site that doesn't resolve also ends in `ENOTFOUND` and counts as dead (**Assumption A1**, settled: controller ruling, 2026-10-17). The guarded request reports both the same way, and either way the link no longer leads anywhere.

**Offline guard (Assumption A2, settled as written: controller ruling, 2026-10-17).** With no network, `dns.lookup` may also fail as `ENOTFOUND`. This is unverified: it is recalled macOS behaviour, not checked here. If it holds, an offline server would see every name as gone. The ruling treats anything that isn't a clear signal as "couldn't check". So `ENOTFOUND` counts as `dead` only when the runner got an HTTP answer (any status) from some other host in the same sweep or in the previous 24 hours. Otherwise it is `unknown` with detail `network:ENOTFOUND:unconfirmed`. The runner keeps the time of its last HTTP answer in memory, so after a restart a dead name waits for some other answer first.

The guard covers a long outage and a restart. It does not cover a short outage soon after an answer: that can record one false dead check. That alone never flags, since flagging needs a second dead check at least 7 days later.

**Flagging** (`applyCheck(current, verdict, at)`; `at` is when the check started):
- **alive** clears the streak and the flag: `first_dead_at` and `flagged_at` become null. One successful check clears it (ruling).
- **unknown** changes neither the streak nor the flag. Couldn't check is never dead, and it doesn't break a streak either.
- **dead** is dropped when `still_works_at` is not null and not before `at`: a check that started before the owner's "It still works" says nothing about the link now. Otherwise it sets `first_dead_at` to `at` if it was null, and flags (`flagged_at = at`) when the link isn't flagged and `at − first_dead_at ≥ 7 days`. Two dead checks at least 7 days apart (ruling).
- In every case `checked_at = at`, and `result` and `detail` are written.

**It still works** (`stillWorks(owner, id)`): only on a flagged link, otherwise `conflict` ("This link isn't marked as gone. Reload the page."). It clears the flag and the streak: `flagged_at = null`, `first_dead_at = null` and `still_works_at = now` (**A3**, settled: owner, 2026-10-17). The link is flagged again only after two new dead checks at least 7 days apart. The rule on `still_works_at` in "dead" above means a check already running when the owner clicked can't undo the click or start a streak from before it.

**Undo of It still works** (`restoreCheck`) follows `restoreTool`'s rule (src/core/tools.ts). It puts back the earlier `flagged_at`, `first_dead_at` and `still_works_at` only while the row still equals, by value, what It still works wrote. Otherwise it is `conflict` ("This link was checked since, so it stays as it is.") and nothing changes. A check in between moves `checked_at`, so Undo conflicts. An earlier row no action could have written is refused as `invalid_input`: `flagged_at` after now, `flagged_at` set with `first_dead_at` null, or `flagged_at` less than 7 days after `first_dead_at`. Like the other Undos, it has no time limit in core; the Undo bar closes within 45 s.

**Gone** (`isGone(check)`): `flagged_at` is not null. One helper, used by every reader below.

**Cadence** (ruling): `CHECK_ACTIVE_DAYS = 7` for active links (Keep handy tools on active links included), and `CHECK_ARCHIVED_DAYS = 30` for archived ones ("monthly", **Assumption A4**, settled as written: controller ruling, 2026-10-17). It follows the link's state at the time of the due read. So a link made active again is checked within a week of its last check, and a kept tool on an archived link is checked monthly (**Assumption A5**, settled as written: controller ruling, 2026-10-17). Neither interval is under 7 days, so a link's next dead check always counts toward the flag.

## The check runner (core/link-check-runner.ts)

A separate runner, not the snapshot runner. It never calls a `SnapshotStore` method, so `recordSnapshot` and the nulling in `snapshotRecord` (src/core/snapshot-outcome.ts:122-130) are out of its reach. That is why checks keep their own record: a failed snapshot attempt clears the snapshot's text, title and image.

`createLinkCheckRunner({ checks, checker, now, log, pollMs, gapMs, hostGapMs })`, with the same `start`, `quiesce`, `stop` and `sweep` shape as the image pass (src/core/image-indexer.ts):
- **Sweep** every `pollMs` (default 60 s). It reads up to 20 due links with the cutoffs `now − 7 d` and `now − 30 d`.
- **One check at a time**, apart from the snapshot runner's 2 slots and the image pass.
- **Per check:** read the row (`getCheck`), check the URL, judge, `applyCheck`, then `updateCheckIf(expected = the row read)`.
  - If the owner changed the row meanwhile (not applied), it reads the row again and applies the same verdict once more: the check's result is still a fact.
  - A null answer means the link was deleted, and it moves on.
- **Every check writes its row**, except one aborted by shutdown. So every link's `checked_at` moves on, and no link stays due forever to crowd real checks out of the oldest-first sweep.
  - A link that isn't a web address (`isWebUrl` false) is never requested: it is recorded `unknown` with `refused:scheme`.
  - So is a URL the guarded request refuses before any request (credentials, invalid), with its refusal.
- **Sweeps never overlap.** A sweep of 20 checks spaced 10 s apart outlasts the 60 s poll, so the next sweep starts only after the current one ends, as the image pass's do.

**Politeness:**
- At least `gapMs` (default 10 s) between checks.
- The same host is not checked again within `hostGapMs` (default 60 s); the runner takes the next due link on another host.
- A GET whose body is discarded unread; see the checker.
- Its own User-Agent purpose: `checks that pages its owner saved still exist` (`userAgent`, src/fetch/user-agent.ts).

Restarts lose nothing, because what is due comes from the stored `checked_at`. One server process runs one runner, so no lease is needed. The write is conditional on the row, so a race with the owner's action is caught.

**Shutdown** (`start-server.ts`'s order):
1. The check runner quiesces with the snapshot runner, the indexer and the image pass.
2. The HTTP drain.
3. Its `stop()` aborts the check in flight and writes nothing; the link stays due.
4. The checker closes with the other fetchers.

`StartOptions` gains a `linkChecker` seam, as `imageFetcher` has.

### The checker (src/fetch/link-checker.ts)

A new `LinkChecker` interface in core/fetch.ts: `check(url, signal) → { kind: "ok"; finalUrl } | FetchFailure`, plus `close()`. Its implementation is built on `createGuardedRequest` (src/fetch/guarded-request.ts), the one rule set every remote fetch uses: public addresses only, checked again on every redirect hop, at most 5 redirects, and a 15 s deadline. Its `read` discards the 2xx body (`discard`) and returns `ok`. Non-2xx answers are already `http_error` with their status, and a lookup failure is `network_error` with its code (`ENOTFOUND` from the system resolver, or from `guardedLookup` for an empty answer).

It does not reuse `PageFetcher`, for two reasons:
- That would read up to 5 MB of every page weekly.
- A page over 5 MB comes back as `too_large`, which would make a living page `unknown` forever.

GET, not HEAD: many servers answer HEAD wrongly (405, or 404).

## What each door shows

### Core reads

- **The digest** (`core/digest.ts`). `select` leaves out gone links, so they get no reading reason in `previewDigest` or `getDigest` ("Dead links leave the ordinary reading nudges"). `DigestDeps` gains `checks: LinkCheckStore`.
  - `claimSurfaced` gains `exceptGone`, which the store enforces in the claim's SQL beside `exceptKeptTools` (src/store/sqlite-store.ts). A link flagged between selection and claim is then neither returned nor marked.
- **Keep handy** (`core/tools.ts`). A gone kept tool is not due for "Still using it?". The dead check replaces that question (ruling).
  - `isDue` gains the link's check: `isDue(link, tool, check, now)` is false when `isGone(check)`.
  - So `dueTool` (the digest's `still_using_check`), `listShelf`'s `due` and `handyView`'s `due` all agree. Each caller passes the row from one `listChecks` read.
  - `ShelfItem` gains `gone: boolean`. `listShelf` puts gone tiles first with due ones, so neither is cut from view.
- **Worth a look** (`core/worth-a-look.ts`). `worthALook` returns `{ links, gone }`:
  - `gone` is at most one active, gone link: the earliest flagged, ties by id.
  - Kept tools are left out of it, as they are left out of Worth a look's reading picks. A gone tool is asked about on its shelf tile, where "Still using it?" was (ruling). Showing it in both places would let one surface go stale after an action on the other.
  - When there is one, it takes one of the `WORTH_SIZE` (3) slots, and the reading picks fill the rest (**Assumption A6**, settled as written: controller ruling, 2026-10-17).
  - It is a preview: nothing is marked surfaced, so the same link is asked about until it is answered. One at a time, no count.
- **Views.** `goneView(check)` returns `{ since: flagged_at, checkedAt: checked_at }` for a gone link, else null. Every door shows gone links through it.

### Web

Spec §6 and src/web/AGENTS.md apply: amber only for "needs you", no counters, and Undo instead of asking first.

- **Cards** (search results, All links, space pages, and the done pages `/all/done` and `/spaces/done`): a gone link's card gets one quiet line in `--soft`, "This page seems gone". It is neutral, never amber or `needs-you`. One builder, `goneLine(link, view)` in a new `src/web/gone-line.ts`, is used by all the card builders.
  - **Active cards** carry two small text buttons after the line: **It still works** and **I'm done with it** (**Assumption A7**: the ruling lists the actions without placing them; settled as written: controller ruling, 2026-10-17).
  - **Done pages** show the line only. They have no Undo bar or card scripts today, and "I'm done with it" is already true there.
- **Worth a look**: the gone link is a small card, the last in the side column, or alone when there are no reading picks. It is never the lead: size means importance, and this is a chore.
  - It is amber (`needs-you`, ruling), as is a gone tool's tile on the Handy shelf (below). It shows the title (opening it is recorded as now), the line "This page seems gone", and **I'm done with it** and **It still works**.
  - No Not now and no Keep handy on it.
- **Handy shelf**: a gone tool's tile shows the line "This page seems gone" with **It still works** and **I'm done with it** where "Still using?" would be.
  - The tile is amber (`needs-you`), like today's "Still using it?" tile (src/web/handy-shelf.ts), because it replaces that ask (owner, 2026-10-17).
  - Its actions are the shelf script's: "I'm done with it" is the existing `done` act (`/home/archive`, with Undo). "It still works" posts the new route and refreshes the shelf, as the shelf's other acts do.
- **Undo bars**:
  - I'm done with it: "Moved out of your list.", through the existing `/home/archive` and `/home/unarchive`.
  - It still works: "Marked as working.", with Undo through the new route below.
- **Pictures, titles and the snapshot** are unchanged: the card keeps showing what was fetched at save time.

### MCP

- **Link output gains `gone`**: null, or `{ since, checkedAt }`, two ISO timestamps. `linkOutput` is used by the output schemas of `save_link`, `update_link`, `get_link`, `search_links`, `list_links` and `get_digest` (src/mcp/server.ts, checked 2026-10-17), so all six carry it. In `get_digest` it is null unless a check flags the link between its claim and the answer, because gone links are left out of the digest. It is added beside `handy` in `linkOutput` (src/mcp/output-schemas.ts) as a strict object, and the door adds it through `goneView` as it adds `handy`.
  - `tools/list` already lets objects carry added fields (`advertisedOpen`, ROADMAP #39), so clients holding an older tool list keep working.
  - `snapshot.status` is unchanged (ruling).
- **No new input, and no new digest reason.** A gone link is absent from `get_digest`, as from every reading nudge.
- **Guidance** (src/mcp/guidance.ts):
  - a link with `gone` "seems gone": say so, and never that it is certainly dead;
  - offer to archive it with `update_link` (`state: "archived"`) if the owner is done with it;
  - for a kept tool that seems gone, don't ask "Still using it?".

## Routes

| Route | Body | Does | Answers |
|---|---|---|---|
| `POST /links/still-works` | `{ id }` | `stillWorks` | 200 `{ check, previous }`: the row written and the row it replaced |
| `POST /links/still-works/undo` | `{ id, check, previous }` | `restoreCheck` | 204, or 409 with the conflict message |

- "I'm done with it" uses the existing `/home/archive` and `/home/unarchive`, which are already guarded.
- Both new routes:
  - join `CHECKED_PAGES` in src/app.ts, so a foreign Origin is refused (and a missing one on POST);
  - join `WRITE_ROUTES_TESTED` in src/mcp/isolation.test.ts, each with a two-owner test: B naming A's link gets 404, and A's `link_checks` row is unchanged;
  - read the body with `jsonBody` before `session`, as every POST does.
- No new GET route; the line renders inside existing pages.

## The #135 slot

A dead link will offer its saved copy (#128 comment 6225434952). #135's rulings put the copy at `/links/:id/copy`, reached from the card's ⋯ menu and from a dead link's card (#135 comment 6241001150). The place for it is `goneLine`: when the link has a saved copy, the line gains a **Read the saved copy** link to `/links/:id/copy`. Until #135 lands no link has a copy, so the line renders nothing there: no disabled control and no placeholder text. #135 adds the copy argument to `goneLine` and the Worth a look card. It needs nothing from this design beyond the guarantee already stated: checks never write snapshots, so a check can't overwrite what #135 copies.

## Errors and edge cases

- **Login walls** (401/403) are `unknown` forever. Links 12, 20 and 21, the login-walled SharePoint pages, are never flagged.
- **A server error, timeout or TLS error** never flags, and never breaks a streak.
- **The server offline**: guarded by A2. Over a long outage, dead names are `unknown`, not dead.
- **A site that sends 404 to bots but works in a browser** is flagged, and after "It still works" it is flagged again only after two new dead checks at least 7 days apart (A3). A per-link "stop checking" was not ruled.
- **The link is deleted during a check**: `updateCheckIf` returns null and nothing is written. When #126's soft delete lands, `dueChecks` must leave soft-deleted links out; that is #126's change to make.
- **The owner acts during a check**: the write isn't applied, and the runner applies its verdict to the new row once (above).
- **Archiving a gone link** keeps the flag; the line shows on the done pages, and the monthly check can still clear it. Undo makes it active again, still flagged.
- **"It still works" on a link no longer flagged** (another tab, or a check cleared it): `conflict`, and the page's alert shows the message.
- **Many gone links**: Worth a look shows one, and the others show only on their cards. No count appears anywhere.
- **A `save_link` repeat** of a gone link returns the existing link with its `gone`, unchanged.
- **A link that is not a web address** (`isWebUrl` false) is never requested.
- **Clock**: every rule takes `now` from deps, so tests inject it.

## Testing

Each test is written red first. The ones that discriminate the contract:

- **Verdicts** (`link-check.test.ts`), one row each:
  - `alive`: 200 and 204, and a 200 after a redirect.
  - `dead`: 404, 410, `ENOTFOUND` with a recent answer.
  - `unknown`: 401, 403, 400, 405, 429, 500, 503, timeout, `ECONNREFUSED`, `EAI_AGAIN`, `CERT_HAS_EXPIRED`, `refused:address`, and `ENOTFOUND` with no answer in 24 h.
- **Flagging**, with an injected clock:
  - dead at T and again at T + 7 d − 1 ms is not flagged; at T + 7 d it is;
  - dead, unknown, dead (≥ 7 d) flags;
  - dead, alive, dead (7 d after the first) does not;
  - flagged then alive clears; flagged then unknown stays.
- **It still works**:
  - it clears the flag;
  - clicking it clears `first_dead_at` as well as the flag;
  - one dead check after it does not flag; a second one at least 7 days later does;
  - a dead check that started before the click is dropped and starts no streak;
  - Undo restores the flag and `first_dead_at`;
  - Undo after a check in between conflicts and leaves the row as the check wrote it;
  - a non-producible earlier row is refused.
- **Checks never touch snapshots** (state assertion): a check that ends in 404 or `ENOTFOUND`, on a link whose snapshot is `ok`, leaves every `snapshots` column and its `link_images` row byte-identical. A mutation that routes the check through `recordSnapshot` fails it.
- **Store contract** (`FakeStore` and SQLite):
  - `dueChecks` cutoffs: an active link checked 7 d − 1 ms ago is not due, at 7 d it is; an archived link at 30 d; a link with no row is due from `saved_at`;
  - it returns both owners' due links;
  - every other method is owner-scoped: B's calls neither read nor change A's rows;
  - rows are deleted with the link;
  - `updateCheckIf` refuses on a changed row.
- **Runner**, with a fake checker:
  - never more than one check at once;
  - `gapMs` between checks, and the same host skipped within `hostGapMs`;
  - `stop()` aborts the check in flight and writes nothing;
  - a conflict re-applies the verdict once;
  - a link that isn't a web address is recorded `unknown` with `refused:scheme`, is not requested, and is no longer due afterwards;
  - a sweep still running when the poll fires is not joined by a second one.
- **Checker** (`link-checker.test.ts`, with a loopback test server and the injected address rule):
  - 404 is `http_error` 404, and a fake resolver's not-found is `ENOTFOUND`;
  - a redirect to a private address is refused;
  - a 200 whose body never ends still returns `ok` well within the deadline. This tells discarding the body apart from reading it.
- **Digest and tools**:
  - a gone link gets no reason and is not in `previewDigest`;
  - a link flagged between selection and claim is not marked surfaced;
  - a gone kept tool is not `still_using_check`, its `handy.due` is false, and its shelf tile shows the gone ask instead of "Still using?".
- **Worth a look**:
  - at most one gone card, the earliest flagged, taking one of the 3 slots;
  - an archived gone link and a gone kept tool never appear;
  - `needs-you` is on the Worth a look gone card and the gone tool tile only, never on ordinary cards;
  - no digit-bearing count text about gone links on any page.
- **Web**:
  - the line on search, All links, space and done cards, never with `needs-you`;
  - the buttons on active cards only;
  - both routes: 403 for a foreign Origin, refused without a session, 404 for another owner's link with A's row unchanged;
  - Undo bars.
- **MCP**:
  - `gone` is null and an object through the output schema of every link-returning tool, checked through the `tools/list` enumeration;
  - an older strict client still parses;
  - the guidance wording.

## README and ROADMAP

- **README.md**, in the PR that ships the web and MCP doors (README rule in AGENTS.md):
  - under "What it does": the library checks saved links weekly (archived ones monthly) and marks one that seems gone, with "It still works" and "I'm done with it";
  - agents see `gone` on links;
  - login-walled pages are never marked.
  - No new `AYE_` setting and no new `src/` folder or top-level file, so `src/readme.test.ts` needs no change.
- **AGENTS.md** folder map: `fetch/`'s line gains "link checks", since it then holds more than snapshots and preview images.
- **ROADMAP.md**:
  - A decision-log entry dated 2026-10-17 for #128. It links this spec, lists the rulings by reference to comment 6241000784, and records A3 and the shelf tile's colour as owner rulings and A1, A2 and A4 to A7 as controller rulings, all 2026-10-17.
  - The Later row's "an archived copy of each page (#135)" becomes "a saved copy of each page (#135)", as #135 comment 6240109297 asks of the next PR that touches ROADMAP.

## Landing

Two PRs, both closing into #128:
1. **Store, rules, runner and checker.** Migration 14, `LinkCheckStore`, `core/link-check.ts`, the runner and its start-server wiring, the checker, and the digest and Keep handy exclusions. It carries this spec and the ROADMAP entry, and it starts checking and flagging. No door shows `gone` yet, but gone links already leave the reading nudges: the digest and Worth a look's reading picks.
2. **Doors.** MCP `gone` and guidance, the web line, Worth a look's gone card, the shelf tile, both routes, and README. Closes #128.
