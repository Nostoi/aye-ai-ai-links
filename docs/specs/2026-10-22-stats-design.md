# Stats (#161)

Owner conversation, 2026-10-22. Mockups: https://claude.ai/artifact/8ipFottawVm8f3o6DEQ6h8 (private to the owner); the owner chose **A**. Builds on the in-app AI connection (`docs/specs/2026-10-19-in-app-ai-design.md`) and its timed pass pattern (`docs/specs/2026-10-22-saved-summaries-design.md`).

## Why

The owner wants to see what they save, what they actually read and what they let go, over a window they choose, and to hear what an AI makes of it. In their words, it is "mostly for fun", and "might be good for sense of self awareness".

On 2026-10-22 the live library had 46 links, all saved since 2026-10-11. Of those, 18 had a recorded opening, 15 were in the lists and never opened, 16 were marked stale, 4 had been answered "not handy anymore", and 16 were on Not now. The tags with the most links were chorequest (14 saved, 7 opened), hypie warriors (10, 5), token-grounding-prototype (8, 1), Valor South Austin (6, 5) and game development (6, 4).

**What the database can't answer today.** For anything except saving, it keeps a link's current state, not its history. `last_opened_at` holds only the latest opening. `state` and `put_away_at` say whether a link is out of the lists now, and only "Put it away" leaves a date; "It's stale" leaves none. `snoozed_until` holds only the current Not now. That means "saved in the last month" is exact, "opened in the last month" can only mean "last opened in the last month", and "set aside in the last month" can't be answered at all. The owner chose to add a small history log from now on (below).

## Goals

- A **Stats section on the profile page**, laid out like mockup A:
  - a window switch;
  - four counts;
  - a breakdown by project and topic;
  - the AI's reading at the bottom, marked as a guess.
- A **history log** that records openings and set-asides as they happen, so each window counts what happened in it.
- A **read-only MCP tool** that returns the same stats and the stored reading. Ask AI gets it automatically, because the in-app chat uses the MCP tools in process (`src/ai/tool-session.ts`).
- A **reading pass** on a regular schedule: the server's one AI connection writes "what this might say about you" from the stats and stores it. It only runs when the `AYE_AI_` settings set up an AI.

## Non-goals

- **Worth a look doesn't change.** Using stats as a pick signal may come later, once the owner has seen real numbers. This work adds no digest reason.
- No charts beyond the per-tag bar. There's no timeline or trend graph.
- No owner editing of the reading. The owner can't confirm or correct it like a profile note; the next pass replaces it.
- An MCP agent can't write the reading. The tool is read-only (controller's call: keeps one writer and one style).
- The log isn't exported in this work (controller's call). The export stays at version 3. A later change can add it with a version bump.
- No backdating beyond what's stored (see Backfill).
- No stats on Home, All links or anywhere else.

## Anti-goals

- **Guilt counters leak out.** A "not opened yet" number shows on Home, in a list, or in a nudge. It belongs on the profile only.
- **The reading reads as fact.** It must always show as a guess, with who wrote it and when.
- **Windows claim more than the log knows.** A count for a period the log doesn't cover looks complete.
- **The app needs an AI.** With no `AYE_AI_` settings, the counts, breakdown and tool all work, and the reading is simply absent.

## Owner decisions (2026-10-22)

1. **Where:** a section on the profile page ("What your AIs know about you"), plus the stats available to AIs when asked.
2. **Layout:** mockup A, which puts numbers first, then the per-tag breakdown, then the reading.
3. **"No guilt counters" exception.** The section shows a "not opened yet" count. The owner chose A knowing that. Rule 6 in `src/web/AGENTS.md` still governs Home and the lists; the profile's Stats section is the exception, because the owner only sees it when they go looking. This settles the open conflict in ROADMAP's 2026-10-18 entry.
4. **History log**, from now on.
5. **The reading is rewritten on a regular schedule**, not only when asked.
6. **Not now isn't "set aside".** It means "later", not "no". This departs from #161's text, which listed Not now under "said I'm not reading". The owner accepted it in the design playback.
7. **Stats are first for looking at.** Feeding them into Worth a look is a later, separate decision.

## The history log

**New table `link_events`** (one migration, 21), link-keyed:

| column | meaning |
|---|---|
| `owner_id`, `link_id` | FK `(owner_id, link_id) → links(owner_id, id) ON DELETE CASCADE` |
| `kind` | `opened`, `put_away`, `stale`, `not_now`, `not_handy` |
| `at` | ms timestamp |
| `backfilled` | 1 for rows the migration seeded, else 0 |

Index on `(owner_id, at)`. Several rows per link are expected.

**Written in `store/`, in the same transaction as the state change**, so no door or core rule can skip it. This follows "owner scoping lives in `store/`" and keeps doors free of rules. Each row's trigger:

- **`opened`:** a write that sets `last_opened_at`. That covers `POST /home/opened`, `POST /links/opened` and MCP `update_link {opened:true}`, which all go through `buildPatch`.
- **`put_away`:** a write that stamps `put_away_at` (`putAwayLink`). That's the card's Put it away, Tidy up, and MCP `update_link {putAway:true}`.
- **`stale`:** a write that moves a link to `archived` with `put_away_at` null. That's It's stale (`archiveLink`), Tidy up's It's stale, the saved copy's end buttons, and MCP `update_link {state:'archived'}`.
- **`not_now`:** a write that sets `snoozed_until` to a future time. That's Home's Not now (`snoozeLink`) and MCP `update_link {snoozedUntil}`.
- **`not_handy`:** a `link_tools` write that moves a row to `declined`. That's `notHandy`, `answerSuggestion(false)` and MCP `not_handy`.

The full list of writers is in the 2026-10-22 code survey. The builder should confirm it against `SqliteLinkStore.update`/`updateIf` and `updateToolIf`, and give the store contract tests one case per kind.

**Undo removes what its action wrote.** An Undo that restores a link's prior state (`undoStateChange`, `unsnoozeLink`, `restoreTool`) deletes, in the same write, the event that the undone action wrote. So an undone Put it away leaves no `put_away` row. "Bring it back" is not an Undo, and it deletes nothing: the counts below look at current state, so a link brought back simply stops counting as set aside. Openings have no Undo. Matching the event to its action is the builder's call; the action's own timestamp is one way.

**Deleted links:** the cascade removes their rows on purge, and reads join `links` with `deleted_at IS NULL`. The table registers in `src/store/hidden-link-coverage.test.ts`, with a case in `link-removal.test.ts`.

**Backfill (in the migration):**

- one `opened` row per non-null `last_opened_at`;
- one `put_away` row per non-null `put_away_at`;
- one `not_handy` row per `declined` `link_tools` row, at its `since` (a status change resets `since`, so it is when the link was declined);
- one `not_now` row per non-null `snoozed_until`, at `snoozed_until − SNOOZE_MS`.

All are marked `backfilled = 1`. A stale link has no date, so it gets no row; it counts only in "All time" (below). The migration file holds its own copy of `SNOOZE_MS`'s value, because migrations call no app code.

**Tracking start** is the migration's run time, stored in the migration (controller's call: a one-row `meta` value or the earliest non-backfilled row; the builder picks). The page needs it for the "before tracking began" note.

## The counts

Every count is distinct links, not events, and excludes deleted links. The **window** is one of: last 30 days, last 90 days, last 365 days, or all time. "Last month" means the last 30 days (controller's call).

| Count | Rule |
|---|---|
| **Saved** | `saved_at` in the window |
| **Opened** | has an `opened` event in the window. **All time:** has any `opened` event or a `last_opened_at` |
| **Not opened yet** | saved in the window, in the lists (`state = 'active'`), and never opened (no `opened` event, `last_opened_at` null) |
| **Set aside** | out of the lists now (`archived`) or `declined` in Keep handy, **and** its latest `put_away`/`stale`/`not_handy` event is in the window. **All time:** every link that is set aside now, with or without an event |
| **Put off with Not now** | has a `not_now` event in the window. Shown as one small line under the four counts, not as a fifth card (controller's call; the owner's decision 6 keeps it out of "set aside") |

**By project and topic:** for each tag on a link saved in the window, show how many were saved and how many of those have ever been opened, most saved first. Show the top 8, then "and N more" (controller's call). The bar is a two-tone track with opened in dark and not opened in light, as in mockup A, with "14 saved · 7 opened" beside it. The tag's kind isn't shown. A project with `kindSource: inferred` isn't labelled a guess here, because the counts aren't guesses.

**What "opened" can't see.** An opening from a browser bookmark or outside the app isn't recorded (README, "Go through everything"). The section says so in one small line.

**Before tracking began.** When a window starts before tracking began, a small line under the counts says: "Openings and set-asides before <date> are partly counted: only the last opening, and only Put it away and Not handy, were stored." The exact wording is the builder's, in plain English. The note goes once the window lies wholly after the start.

## The profile section

`GET /profile` gains the section below Notes and Working on lately, with the heading "Your library". The window switch is four plain links (`?window=30|90|365|all`), so it works without script. Each link is at least 44px tall, and the current one is marked like mockup A's filled pill. The default is all time (controller's call, matching the approved mockup). An unknown `window` value falls back to the default.

- **Four count cards in a 2×2 grid:** Saved, Opened, Not opened yet, and Set aside (with the subline "done, stale, put away or not handy"). Under them, the Not now line and any notes.
- **"By project and topic":** the bars described above.
- **"What this might say about you":** the stored reading, followed by a grey line: "A guess by <writtenBy>, <date>". With no AI connection, or before the first pass, the heading and box are left out.
- Colors stay neutral. Amber isn't used, since nothing here "needs you". Tags get no space color (controller's call: the bars are about counts, not spaces).
- Everything renders through `page()` and theme tokens and makes no outside requests. `/profile` is already in `CHECKED_PAGES`. Its `READ_ROUTES` entry gets a marker from the new section, seeded for owner A, and owner B must not see it.

`src/web/AGENTS.md` rule 6 gets the exception written next to it, in the PR that adds the section.

## The MCP tool

**`get_stats`**, read-only.

- **Input:** optional `window` (`30`, `90`, `365`, `all`; default `all`).
- **Output:** the four counts, the Not now count, the per-tag rows (name, kind, saved, opened), `trackingSince`, and `reading` (`{text, writtenBy, writtenAt, source: "inferred"}`, or null).

Its guidance says the reading is a guess, and that "opened" misses openings outside the app. It joins the `changes.test.ts` read table and gets an `outputSchema`. The README lists it.

## The reading pass

`src/core/stats-reading-pass.ts` has the same shape as the summary pass: `start`, `quiesce`, `stop` and `sweep`, an injected `now`, conditional writes, and in-memory backoff. It is started in `start-server.ts` only when `chat` exists. The model call lives in `src/ai/`.

- **When:** it checks every hour (controller's call). It writes a new reading when there is none, or when the last one is at least **7 days** old (controller's call; the owner asked for "a regular schedule" and accepted weekly as the working guess) **and** the stats changed since. "Changed" is a hash of the stats input, stored with the reading.
- **Input:**
  - the all-time and last-30-days stats, including the per-tag rows;
  - the tag kinds;
  - `recentFocus`.
  - Titles, whys or page text go in only if the builder finds the reading needs them; the default is counts and tag names only (controller's call: small, cheap, and enough for patterns in topics, projects and habits).
- **Prompt:** two to four plain sentences about patterns in topics, projects and habits. Written as a guess ("maybe", "seems"), never as a judgment. No advice, no scolding about unread links. A length cap is the builder's call.
- **Storage:** new owner-keyed table `stats_readings` (`owner_id` PK, `text`, `written_by`, `written_at`, `input_hash`). There is one row per owner, replaced each time. `written_by` is the AI connection's name (`AYE_AI_NAME`, or the model). It is owner-keyed, not link-keyed, so it stays outside the hidden-link check. It isn't exported in this work.
- **Not a profile note.** Profile notes are what AIs read before guessing a link's why. Keeping the reading out of them stops a guess built on counts from feeding back into new guesses (controller's call).

## Landing sequence

The owner waived the ~400-line PR ceiling. Each PR is still one outcome.

1. **The log:** migration 21 (`link_events` and the backfill), the store writes and Undo deletions, the hidden-link registration, and contract tests. Nothing reads the log yet.
2. **The counts:**
   - the stats queries in `store/`, behind an interface;
   - the rules in `core/stats.ts`;
   - the profile section without the reading;
   - `get_stats`;
   - the rule-6 exception in `src/web/AGENTS.md`;
   - the README.
3. **The reading:** `stats_readings`, the pass, the section's reading box, and `get_stats`'s `reading`. Also a README line saying it needs the AI settings.

## Left to the builder

- How an Undo finds the event its action wrote.
- Where the tracking start is stored.
- The exact wording of the notes and the reading prompt, and the reading's length cap.
- The stats store interface's shape.
- The bar layout at phone width. It must not scroll sideways, and tag names wrap or truncate.
