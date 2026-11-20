# Explore tray: Keep / Skip / Archive, and Tidy takes gone pages (#340, part 3 of 3)

**Design:** `docs/specs/2026-11-19-explore-keep-archive-design.md`. The sections that govern are "Today", "Tidy", "Settled after the builder check", "Today from day to day (option A)" and "Claude's calls".

**How #339 landed:** `docs/plans/2026-11-19-intent.md` §6–7.

**Mockup:** `docs/design/today-explore-mockup.html`. It is untracked on this branch and gets committed with this PR.

**Sweep scope:** `command grep -rn` over `src/` (`*.ts`; tests and non-tests counted apart; the `__ask_off__` and `__tokens_expanded__` fixtures noted where they matter), `README.md` and `src/web/AGENTS.md`, at `6cb4e5a`. Spellings swept:
- selection: `lastSurfacedAt`, `last_surfaced_at`, `claimSurfaced`, `unclaimSurfaced`, `SURFACE_COOLDOWN_MS`, `dayRank`, `markOpened`, `gonePick`, `worthALook`, `previewDigest`, `getDigest`, `get_digest`, `dueTool`, `claimDueTool`;
- digest reasons: `never_surfaced`, `not_opened_recently`, `no_why`, `still_using_check`;
- removed in #338: `came_back`;
- snooze: `snoozedUntil`, `snoozed_until`, `snoozeLink`, `unsnoozeLink`, `SNOOZE_MS`, `"not_now"`, `NOT_NOW`, `notNow`, `Not now`, `not-now`;
- Tidy: `TIDY_SESSION`, `tidySession`, `tidyQueue`;
- Home's wording: `Worth a look`, `worth-`, `Today`/`today`, `"surfaced"`.

**Deploy gate (relayed from the coordinator, not observed here).** #339's intent pass finished on the server: 14 `keep`, 16 `not_keep`, 0 `failed`, 0 undecided, checked with F1/F2's `GROUP BY outcome` query joined to live links.

## 1. Benefit, and the case reachable today

**Reachable on `main` (OBSERVED in source):**
- **Home picks rotate by day** (`worthALook` shuffles with `dayRank`). An undecided link drifts in and out with no question asked.
- **Open hides a link for 14 days.** Open on a Home card calls `markOpened`, which runs `recordOpening` and then `claimSurfaced`, so the link leaves Home with no word said.
- **Not now hides a link too.** It marks the link surfaced and snoozes it.
- **`get_digest` uses links up.** Each call claims its picks, so an agent's digest can take a link off Home for 14 days.
- **Tidy only asks when five links qualify** (`tidySession`).
- **Tidy ignores a snooze.** `qualifying` has no `snoozedUntil` test, so a link the owner just put off can be asked about in Tidy straight away.
- **Gone pages are Home's job.** They get one gone row on Home (`gonePick`), and that row's ⋯ offers Keep it while promising "Today and Tidy up won't ask about it". `gonePick` has no intent filter, so the link is back on the next load. This is #339's R4.

**What this PR delivers:**
- Home's tray becomes **Explore**, holding To explore links only.
- Each card offers **Keep / Skip / Archive**.
- The cards stay put; nothing rotates and nothing is hidden by opening.
- **Open** only opens. An opened card says "Opened. Keep it or archive it?".
- **Tidy** asks about old To explore links, with Keep / Skip / Archive, and about pages that seem gone, with It still works / Archive. It is offered whenever at least one link qualifies.
- `get_digest` picks the same way and writes nothing.

## 2. Invariant map

### The mockup (OBSERVED, `today-explore-mockup.html`)

**Featured card, variant 2d** (`#v-2d`, the owner's pick):
- **Layout.**
  - Picture on the left, then the title, then the why under "You saved it for" with its reason line.
  - Then the grey line (site · Saved 2 days ago).
  - Then one row: **Open it**, the filled pill, followed by `.feature-quiet.three`, which holds three round `.slide` buttons in this order:
    - **Keep**: check in a circle, hint "Not asked again". The owner chose icon C, which is the same glyph as `intent.ts`'s `CHECK`.
    - **Skip**: a double chevron (`M6 6l6 6-6 6` / `M13 6l6 6-6 6`), hint "Back in two weeks".
    - **Archive**: the box, which is `done-link.ts`'s `ARCHIVE`, hint "Out of lists, still in search".
- **On hover screens wider than 600px:** `.feature-quiet.three{width:164px}`, with the buttons absolute at `right:116px`, `58px` and `0`. An opened button grows leftward over its neighbour, as the shipped pair does.
- **At 600px and below:** `.feature-quiet.three{flex-direction:column;align-items:stretch}`, and each `.slide` is full width and left-aligned. The three stack under Open it with their words always showing.
  - The cell's own note says "share the row". Its CSS and the owner's comment ("they stack on a phone") both say stack, and stack governs.
- **The ⋯ menu as drawn:**
  - Keep it ("Moves to To keep"), Archive ("Out of lists, still in search"), Keep handy, Edit, Remove saved copy, Delete link. That is six items.
  - This repeats Keep and Archive, which already sit on the card as buttons. See Q3.

**Also today row** (3R, the owner's choice):
- Picture, then the title, then the why (`.also-why`).
- On an opened link, under the why, `p.also-open` (13.5px, `--about`): "Opened. Keep it or archive it?".
- The ⋯ has seven items: **Skip** ("Back in two weeks"), Keep it ("Moves to To keep"), Archive, Keep handy, Edit, Remove saved copy, Delete link.
- The rows carry no verbs of their own.

**The opened line on the featured card** (4R):
- `p.opened` (`--text-3`, `--about`, "Opened." in `--ink` 600) sits between the grey line and the buttons, in its own grid area.

**The tray:**
- The sun icon stays, the spine word is **Explore**, and the hidden heading is "Explore".
- The "Also today" label is unchanged. See Q4.
- There is no gone row.

**The ⋯ on a To keep row:** Explore it ("Back on Today"), then Archive, then the rest.

**Tidy step (not ruled by the owner beyond gone pages):**
- An explore step shows Keep ("Moves to To keep. Not asked again."), Skip ("Back in two weeks.", drawn `.safe` with "If you're not sure") and Archive ("Out of your lists. Still found by search.").
- The gone step, with the fact "This page seems gone.", shows the same three. The owner overruled this: It still works / Archive.

### Readers and writers (OBSERVED unless marked)

**Explore's selection.**
- `select` in `core/digest.ts` filters on: not gone, not excluded, intent explore, not a kept tool, and `eligible` (active, not snoozed, outside the surfaced cooldown).
- It then gates on a reason: a focus match or an `ownReasons` hit (`no_why`, `not_opened_recently`, `never_surfaced`).
- It takes up to `FOCUS_SLOTS` (3) focus picks, then the rest in `rotation` order (least recently surfaced).
- Readers:
  - `previewDigest`, whose only caller is `worthALook` (`core/worth-a-look.ts`);
  - `getDigest`, whose only caller is `mcp/server.ts:774`.
- `worthALook`:
  - takes `gonePick` first;
  - excludes Handy's suggestions and the gone pick;
  - takes one focus lead, then shuffles the rest with `dayRank`;
  - slices to `WORTH_SIZE` (3) less one for a gone pick.
- Its only caller is `GET /` (`web/http.ts:925`).

**`lastSurfacedAt` and the cooldown.**
- **Written by:**
  - `claimSurfaced` (`digest.ts:180`), called from `markOpened` (`worth-a-look.ts:84`), `snoozeLink` (`:98`), `getDigest` (`:255`) and `claimDue` (`:326`);
  - the store's `claimSurfaced` and `unclaimSurfaced` (`store.ts:166/178`, `sqlite-store.ts:322/337`, `fake-store.ts:1064/1100`).
- **Undone by:** `unclaimSurfaced`, from `snoozeLink`'s failure path and `unsnoozeLink`.
- **Read by:** `eligible`, `rotation`, `ownReasons` (`never_surfaced`) and `dueTool`.
- **Carried on the wire, not as a rule:**
  - `export-format.ts:85/276/367`;
  - `mcp/output-schemas.ts:95` (a required `timestamp.nullable()`);
  - `mcp/handy.ts:63`;
  - `rowToLink`.
- **Raw SQL:** `last_surfaced_at` only in `sqlite-store.ts` and dated migrations.
- **Store-contract coverage:** `store-contract.ts:1294–1463` and `:2282–2312` (the hidden-link case), `tool-store-contract.ts:336–354`, `link-check-store-contract.ts:198–211`.
- **`SURFACE_COOLDOWN_MS`:** only in `digest.ts`, plus tests in `digest.test.ts` and `worth-a-look.test.ts`.
- **`dayRank`:** only `digest.ts:77`, with its one use at `worth-a-look.ts:69`.

**Not now, which becomes Skip.**
- `snoozeLink` and `unsnoozeLink` (`worth-a-look.ts:90/119`), behind the routes `/home/snooze` and `/home/unsnooze` (`http.ts:1405/1421`, `app.ts` `CHECKED_PAGES`, `isolation.test.ts:913–914`).
- **The snooze:** `SNOOZE_MS` is 14 days. It records the `not_now` event and unrecords it on Undo.
- **Other writers of `snoozedUntil`:** MCP `update_link` (`links.ts:296`, which records `not_now` at `:310`).
- **Readers:** `eligible`, `gonePick`, the store's claim, and the expectation (`sqlite-store.ts:960`).
- **Web:**
  - `not-now.ts`: `CLOCK`, `NOT_NOW_HINT`, `NOT_NOW_WORKING`, `NOT_NOW_ITEM`, act `snooze`;
  - `home-page.ts:98`, the slide;
  - `homeActs.snooze` (`:194`);
  - `editMenu`'s `notNow` (`edit-link.ts:50`).
- **Stats:** `stats.ts:108` `notNow`, `profile-stats.ts:34/77` ("Put off with Not now"), `ai/read-stats.ts:35`, `mcp/output-schemas.ts:166/176` (wire key `notNow`), and `guidance.ts:118`.

**Tidy's queue.**
- `qualifying` (`tidy-up.ts:24`) takes links that are: active, intent explore, saved and last opened at least `NOT_OPENED_MS` (30 days) ago, not a kept tool, not gone, and not in `skip`.
- There is **no snooze test**.
- `tidySession` returns null below `TIDY_SESSION` (5).
- **Caller:** `GET /` (`http.ts:949–950`) passes `aboveTidy`, which is everything Home shows above it, including the space cards' recent titles.
- **Web:**
  - `tidy-tray.ts`: the closed words "Five, one at a time.", and the finish line "That's five." when `count === TIDY_SESSION`;
  - `tidy-step.ts`: `CHOICES` (Keep, Archive) and the facts;
  - `tidy-script.ts`: `ACTS` keep/archive, `KEYS` 1/2, and `choose`, which needs `{before, after}` and posts its Undo as `{id, change}`.

**The gone row and band on Home.**
- `gonePick`, then `worthALook`'s `gone`, then `WorthCards.gone` and `goneRow` (`home-page.ts:136`), with its `.worth-gone` class and `goneScript("worth-cards")` (`:304`).
- CSS: `.worth-row .gone-band` (theme).
- Tests: `home-page.test.ts:1192` ("the Worth a look gone row"), `home-routes.test.ts:505`, `gone-band.test.ts:106` ("last child of an Also today row"), `worth-a-look.test.ts:149`.
- It still works is `/links/still-works`, which answers `{check, previous}`, and `/links/still-works/undo`, which takes `{id, check, previous}` (`http.ts:1547/1560`).
- Every other page keeps the band.

**The featured card and the rows.**
- **The featured card** (`home-page.ts:84`) has Open it, then the slide pair `snooze`/`archive`.
- **Its ⋯** is `editMenu` with `onCard` (`edit-link.ts:48–56`). That menu shows Keep it (or Explore it) and drops Archive.
  - `src/web/AGENTS.md`:39 still says it "starts at Keep handy". That is a stale claim left by #339.
- **A row** (`:108`) uses `editMenu` with `notNow`.
- **Scripts:**
  - `HOME_ACTS`: `snooze`; `keep`, which is Keep handy; `not-handy`.
  - The featured Archive goes through `archiveCard`.
  - `intentLinkScript(…, true)` listens only on `.card-menu button`.
  - `openedScript("worth-cards", "/home/opened")`.

**Opening.**
- `/home/opened` calls `markOpened`. `/links/opened` calls `recordOpening` (`http.ts:1327/1337`). The only difference between them is the claim.

**Event kinds** (unchanged, #339 A2):
- The kinds are `opened`, `put_away`, `stale` (Archive), `not_now` and `not_handy` (`types.ts:31`, `fake-store.ts:144`, the CHECK).
- Skip keeps `not_now`. This PR adds no kind.

**MCP `get_digest`.**
- `server.ts:757–785`:
  - annotations are `readOnlyHint: false` and `idempotentHint: false`;
  - it records a `surfaced` Change (`changes.ts:32`);
  - the panel draws that Change as "Marked N links as shown in today's picks." (`ask-panel.ts:329–331`).
- Reasons are in `output-schemas.ts:228–236`. `guidance.ts` `GET_DIGEST` (`:127–139`) says "Each call marks the links it returns as shown…".
- `still_using_check`:
  - comes from `claimDue`, which claims the tool surfaced;
  - `dueTool` orders tools by `rotation` and applies the cooldown.
- The Handy shelf's own Still using? doesn't read `lastSurfacedAt`. OBSERVED: its only readers are listed above.

**"Today" words** that become stale once the tray is Explore:
- `intent.ts:18/24/29/33/75`, `tray-spine.ts:8`, `home-page.ts:31/107/155/158/258`, `worth-a-look.ts:18`, `ask-panel.ts:331`, `theme.ts:276–277` (the `.also-today` class only);
- README `:24/:25/:26/:47/:49/:76/:79/:83`;
- `src/web/AGENTS.md` `:28/:33/:34/:35/:38–42/:43/:44/:46`.

### Claims

- **OBSERVED.** Home's GET is read-only by rule. The comment at `http.ts:921` reads "Reads only: a cross-site GET carries the Lax session cookie". Explore therefore cannot pin its cards by writing on load, and "stays until decided" must come from the selection rule alone.
- **OBSERVED.** `jsonBody` checks only the keys it names (`http.ts:234–249`). A tab loaded before deploy can still post `/home/unsnooze` with `claimedAt`/`previousSurfacedAt`, and those keys are ignored.
- **OBSERVED.** `/home/snooze`, `/home/archive`, `/home/keep` and `/links/still-works` answer three different shapes. Tidy's `choose` handles only `{before, after}`.
- **INFERRED.** Removing `never_surfaced` from the reason union is safe for a client holding an older `tools/list`, since the server only sends fewer values. Adding a reason kind would break that client (`output-schemas.ts:225` comment), so none is added.
- **UNVERIFIED.** The three-button hover layout's container-query thresholds. `theme.ts:302`'s 402, 301 and 223px were measured for two buttons (#304), and the mockup gives only the 164px width and the offsets. They must be measured again in a browser.
- **OBSERVED.** `FocusMatch.match` returns every matching link, best first (the `core/search.ts:61` contract). Explore can therefore use focus membership with no rank cut.
- **UNVERIFIED (pending the owner).** Order (A) or (B). Also the size of the undecided backlog on the server, which decides how long new saves wait under (A).
- **RELAYED.** The save rate of about 0.8 a day comes from the challenge's `get_stats` call, not from mine.

## 3. Decisions (owner rulings in section 6; the order (A)/(B) is still open)

1. **"Stays until decided", mechanically: a deterministic selection with no stored state.**
   - **Explore's filter:**
     - active;
     - intent explore;
     - not a kept tool (carried O1; kept even though core already refuses explore on a kept tool);
     - not gone;
     - not snoozed at now;
     - not one of Handy's shown suggestions.
   - **Explore's order: one sort key, `savedAt`, then id.** Focus matches come first and are sorted by that same key. The rest follow, sorted by it too. Up to `WORTH_SIZE` (3).
     - **Focus picks: membership only, never rank (challenge Obj 1).** A link is in the focus group if any current focus entry matches it, and the entry's words are kept for the reason line.
       - `FocusMatch.match` returns every matching link (OBSERVED, the `core/search.ts:61` contract). `select` drops the `FOCUS_MATCHES_PER_ENTRY` rank cut and the hit-rank order.
       - So a why, a summary, or an unrelated save that re-ranks bm25 cannot move a card. Only gaining or losing the focus words can, or an entry being added or ageing out.
     - **Whether `savedAt` sorts ascending or descending is pending the owner.** Both forms are written below so either can be built: it is the `dir` parameter of one comparator.
       - **(A) Oldest saved first.** The coordinator recommends this to the owner.
         - **Cards don't move.** They stay until decided, and new saves wait their turn.
         - **Skip's "Back in two weeks" is true.** `snoozedUntil` is never cleared when it runs out, and the link sorts by its old `savedAt`, so it returns to its place.
         - **Explore it's hint is true.** An old To keep link turned To explore sorts near the front.
         - **A link can still come in above the cards and push the third one down.** That happens when:
           - a skip runs out;
           - an Explore it on an old link;
           - Bring it back on an old link;
           - a new focus match.
         - **With Tidy:** Explore's cards are the oldest undecided links, which are mostly also Tidy's old unopened ones. Tidy skips Explore's cards (Q2b), so it asks about the next oldest. Both then work the backlog from its old end, and a link never appears twice.
         - **Until the backlog is cleared, new saves reach Explore only through a focus match.** INFERRED; the backlog's size on the server is not measured.
         - **With focus picks:** the one focus card is the oldest matching link.
       - **(B) Newest saved first.**
         - Fresh saves show at once.
         - **Cards turn over fast.** The coordinator relays a measured 24 saves in the last 30 days, about 0.8 a day. At that rate the non-focus cards turn over in about 4 days with no decisions, which is close to the rejected daily rotation. INFERRED from that relayed rate.
         - **Skip's hint must change** to "Tidy may ask again later", or similar.
         - **Explore it's hint must change** to "Explore or Tidy up may ask about it".
         - **With Tidy:** Explore and Tidy rarely overlap.
         - **With focus picks:** the focus card is the newest matching link.
   - **What goes:** no `dayRank`, no reason gate, no cooldown, no `lastSurfacedAt` read, no rank order for focus picks.
   - **Result:** the same cards show on every load until one is decided, or one of these moves them.
   - **Where a card leaves undecided:**
     - (B only) a newer save bumps the third card;
     - (A only) a link above re-enters, from the list under (A);
     - a focus entry is added or ages out. An agent can do this with an inferred `add_profile`;
     - the link's own text gains or loses the focus words;
     - the page goes gone, and then Tidy asks about it;
     - the link is kept handy, or an agent's handy suggestion lands among the shelf's two shown ones;
     - an agent's inferred To keep lands on a link with no intent source.
   - **Q1 (owner said yes):** accept those.
   - **Rejected:** pinning cards with a stored "on Explore since" mark. It needs a write on GET, which breaks the read-only rule above. A client POST after render (challenge alternative 4) adds state and a hidden effect, for less than A gives.
   - **Focus cap (Q7, owner said yes):** one focus card on Explore, the featured one. `get_digest` uses the same rule with `FOCUS_SLOTS` 3 and the same order, so the two share one ordering and differ only in slot counts.
2. **One selection function.**
   - `select` in `digest.ts` keeps the filter and the order, with `limit`, `exclude` and `focusSlots`.
   - `worthALook` becomes a thin call that returns `links` only (no `gone`). Renaming it `exploreCards` in `core/explore.ts` is optional: it touches `save-page.ts`'s import and a whole test file, and is not needed for the behaviour. Recommend: keep the names. The file and test names elsewhere in this plan (`explore.ts`, `explore.test.ts`) mean `worth-a-look.ts` and its test if the rename is skipped.
   - Remove `dayRank`, `rotation`, `eligible`'s cooldown, `ownReasons`' `never_surfaced`, `SURFACE_COOLDOWN_MS` and `gonePick`.
   - `reasons` stays as it is (focus, `no_why`, `not_opened_recently`) and may be empty. The featured card's `reason()` already falls back to the saved date.
3. **Skip reuses `snoozedUntil`.** No migration.
   - **The action:** `snoozeLink` drops its `claimSurfaced`/`unclaimSurfaced`. `Snooze` becomes `{ until }`.
   - **Duration and event:** two weeks (`SNOOZE_MS`), event `not_now`, as now. Undo is `unsnoozeLink`, unchanged apart from the claim.
   - **Routes:** `/home/snooze` answers `{until}`, and `/home/unsnooze` takes `{id, until}`. Old tabs' extra keys are ignored (claims above).
   - **Re-offering:** when the two weeks run out, the link is eligible again.
     - Under (A) it returns to its old place on Explore.
     - Under (B) Explore re-offers it only if it is still among the newest; otherwise Tidy does once it is old.
   - **Repeated Skips are allowed.** The spec's guarantee says "or is asked about again", and that is what a Skip gives.
   - **Rejected:** a new `skipped_at` field. It would hold the same fact as `snoozedUntil`, which the spec settled on.
   - **Tidy respects Skip, but only a bounded one (challenge Obj 4).**
     - Tidy leaves a link out only while `now < snoozedUntil <= now + SNOOZE_MS`, in both its old set and its gone set. The rule sits in core (`tidy-up.ts`).
     - A longer snooze is still asked about. For example, an agent's `update_link` `snoozedUntil: 2099-…`, which neither `buildPatch` nor `server.ts` caps (OBSERVED).
     - Explore still honours any snooze. No MCP contract change.
     - Red first: N5 and N15.
4. **Not now goes as a name.**
   - **Web:** `not-now.ts` becomes `skip.ts`, with `SKIP_ITEM` ("Skip", hint "Back in two weeks", the double-chevron icon), `SKIP_HINT` and `SKIP_WORKING` ("Skipping…"). The Undo bar says title "Skipped.", text "Back in two weeks.".
   - **Kept as internal names:** act `snooze` and the routes, so the act set and `CHECKED_PAGES` stay as they are.
   - **Stats words:**
     - `profile-stats.ts` says "Skipped: N", and its partial-count note says "Skip";
     - `ai/read-stats.ts` says "skipped N";
     - `guidance.ts:118` describes `notNow` as Skip;
     - the wire key `notNow` stays.
5. **Open only opens.**
   - Delete `markOpened`. Home's cards post `/links/opened` (`openedScript("worth-cards", "/links/opened")`).
   - Retire `/home/opened`: its route, its `CHECKED_PAGES` entry and its `isolation.test.ts` entry.
   - A tab from before the deploy then gets a 404 on one opening and loses that record. That is accepted.
   - Alternative: keep `/home/opened` as an alias of `/links/opened`. Not recommended, since it would be two routes for one fact.
6. **The opened line.**
   - **When it shows:** a card shows "Opened. Keep it or archive it?" when `link.lastOpenedAt !== null`, meaning opened at any time.
   - **Live update:** opening the card from the page shows it straight away. Home's script un-hides the card's `[data-opened]` element on the open link's click, beside `openedScript`, without waiting for the post.
   - **Markup:** on the featured card it is `p.opened` between the grey line and the buttons; on a row it is `p.also-open` under the why. Words and look are the mockup's.
7. **`lastSurfacedAt` (column, export, MCP): kept frozen (Q6, the coordinator's call).**
   - Keep the column and both wire fields. No rule writes or reads it any more.
   - Import still writes `last_surfaced_at` from the file (`sqlite-store.ts:691`), and the export and the MCP link carry it as data.
   - There is no migration and no export bump.
   - Remove the store's `claimSurfaced`/`unclaimSurfaced` and their contract cases.
8. **`get_digest`.**
   - **Selection:** the same filter and order as Explore (`select`, with the same `dir`), `DIGEST_SIZE` 5 with `FOCUS_SLOTS` 3, plus `still_using_check` as now. It writes nothing, and it has no ranking of its own.
   - **Annotations:** `readOnlyHint: true`, `idempotentHint: true`.
   - **Due tool:** `claimDue` and `claimDueTool` go. `dueTool` drops the cooldown and orders by `savedAt` asc, then id. The same due tool repeats until it is answered.
   - **Reasons:** `never_surfaced` leaves the reason union and the guidance.
   - **Guidance:**
     - it gains "reasons may be empty: a new To explore link";
     - it loses "Each call marks… uses links up";
     - it gains a line saying a repeat call returns the same links until the owner decides.
   - **The surfaced Change:** the `surfaced` kind leaves `changes.ts`, `server.ts` and `ask-panel.ts`.
9. **Tidy.** Both sets require: active, not under a bounded snooze (decision 3), not a kept tool, and not in `skip`. `skip` is Explore's cards and Handy's shelf and suggestions, not the space-card titles (Q2b).
   - **Old To explore links:** intent explore, saved and last opened at least 30 days ago (`NOT_OPENED_MS`, unchanged), not gone.
   - **Gone pages:** `isGone(check)`, any intent, any age.
   - **Order** (Q9, ruled yes): gone first by `flaggedAt` (as `gonePick` orders them), then old links oldest-saved first.
   - **Session:** up to `TIDY_SESSION` (5), and `tidySession` returns null only when nothing qualifies. This follows the spec's "no five-link minimum" and the issue's checklist, and supersedes ROADMAP 2026-11-19 #332's "only when a full five are left". The dated ROADMAP sub-bullet records that.
   - **`TidyLink`** gains `gone: boolean`.
   - **An explore step:**
     - choices Keep / Skip / Archive, keys 1/2/3;
     - lines: "Moves to To keep. Not asked again.", "Back in two weeks.", "Out of your lists. Still found by search.";
     - no "If you're not sure" marker and no `.safe` look, per `src/web/AGENTS.md`:44 (owner, 2026-11-19), confirmed in Q5.
   - **A gone step:**
     - the fact "This page seems gone." in place of the fit line;
     - choices **It still works** / **Archive**, keys 1/2;
     - It still works' line: "Clears the warning." No Keep. This settles R4 inside Tidy.
   - **The script.** `ACTS` gains `skip` and `works`, and each act names how to read its answer and build its Undo body:
     - keep: `{change}` → `/home/undo-intent`;
     - archive: `{change}` → `/home/undo-state`;
     - skip: `{until}` → `/home/unsnooze`;
     - works: `{check, previous}` → `/links/still-works/undo`.
   - **Keys** are read per step from its buttons' `aria-keyshortcuts`, not from one fixed map.
   - **Closed words** (Q8, ruled yes): "Clear out a few links?" / "One at a time. Nothing gets deleted." The finish heading is always "Done for now."; with no counts, design rule 6 holds.
10. **Home loses the gone row.** This goes in the same PR as Tidy's gone step, so gone pages are never left with nothing asking about them.
    - Remove `WorthCards.gone`, `goneRow`, `.worth-gone`, the Home `goneScript`, `.worth-row .gone-band` and the route's `gone`.
    - R4 then has no surface: no gone card on Home or in Tidy offers Keep it.
11. **The featured card is 2d.**
    - **The slides:** `slideButton("intent-keep", CHECK, "Keep", "Not asked again")`, `slideButton("snooze", SKIP_ICON, "Skip", SKIP_HINT)`, `slideButton("archive", ARCHIVE, …)`.
    - **Keep's path:** `intentLinkScript` widens from `.card-menu button` to any `button[data-act^=intent-]` in the root. The featured Keep then runs the one Keep it path, which slides the card out with Undo. `KEEP_WORKING` ("Keeping…") moves to `intent.ts` and is shared with Tidy.
      - Today's handler assumes a menu: it calls `menu.open = false` and, on failure, `menu.querySelector("summary").focus()`. With a slide `menu` is null, so both calls would throw.
      - The handler therefore guards `menu`, and on failure with no menu it focuses the card's ⋯ summary.
      - It passes `{ button: menu ? null : button, word: KEEP_WORKING }` to `whileBusy`, as `HOME_ACTS` does, so the slide shows its working word.
    - **After an edit in place (challenge Obj 5).**
      - The edit dialog's Save calls `showIntent` (`edit-dialog.ts:356`), which today toggles only the menu rows.
      - On Home, when an Edit Save makes an Explore card To keep, the card leaves Explore with the same `takeOut` and the same Undo as Keep. Its edit Undo brings it back, as a Keep Undo does. A To keep card on Explore with a live Keep slide would be stale.
      - Archive needs nothing new: the dialog has no state control.
      - Test: N16.
    - **CSS:** `.feature-quiet` gets a three-button variant: 164px, offsets 116/58/0, and the stacked phone rule. The Open it fade thresholds are measured again in a browser (UNVERIFIED above), and the measured values and their method go in `theme.ts`.
    - **Its ⋯** (Q3, ruled yes): drop both on-card actions. With `onCard` the menu also hides Keep it and Explore it, so it starts at Keep handy, which makes `src/web/AGENTS.md`:39 true again.
12. **Rows.** `editMenu`'s `notNow` becomes `skip`: seven items, Skip first. This is the owner's ruling and replaces the spec's "Skip is on the card only. Six items".
13. **Words that promise Today.**
    - **Menu hints** (mockup words, Q8 yes):
      - `KEEP_IT_ITEM` hint becomes "Moves to To keep";
      - `EXPLORE_IT_ITEM` hint becomes "Back on Explore" under (A). The mockup says "Back on Today", which is stale with the new name. Under (B) it becomes "Explore or Tidy up may ask about it";
      - Skip's hint is "Back in two weeks" under (A). Under (B) it becomes "Tidy may ask again later";
      - `ARCHIVE_HINT` becomes "Out of lists, still in search", which reaches every card and the gone band.
    - **Undo bars:** `KEEP_IT_UNDO` becomes "Marked To keep. Explore won't show it." and `EXPLORE_IT_UNDO` becomes "Explore may show it again.". Neither promises anything about Tidy, which asks about a gone page whatever its intent.
    - **The tray:** spine word "Explore", hidden heading "Explore".
    - **"Also today"** (Q4, ruled yes): "More to explore".
14. **Migrations: none.** Skip, the opened line and Tidy use existing columns.
15. **The guarantee, as actually delivered.** Every active To explore link is, at any time, in one of these:
    - **Shown on Explore:** first in the order, either (A) the oldest or (B) the newest, or the focus match.
    - **Skipped from the web:** back on Explore after two weeks under (A); under (B), back on Explore only if it is still among the newest.
    - **Snoozed further out (an agent's `snoozedUntil`):** hidden from Explore, but Tidy still asks about it (decision 3).
    - **Old:** saved and unopened for 30 days, so asked in Tidy.
    - **Gone:** asked in Tidy, whatever its age.
    - **Waiting:** neither new enough nor old enough. It reaches Tidy within 30 days of its last opening.

    Two gaps remain (Q2, owner said yes to both recommendations):
    - **(a)** A link opened at least every 30 days from elsewhere, and never among the newest, is never asked. Recommendation: accept this, since opening it is engagement.
    - **(b)** Tidy skips the space cards' recent titles (`aboveTidy`). `pickRecent` (`core/spaces.ts:42`) gives each pinned space its three newest active links not shown above it, whatever their age. So in any space with no new save in 30 days, those three are old and always shown as titles, and Tidy never asks about them. The same holds for a gone link among them. Recommendation: Tidy skips only Explore's cards and Handy (shelf and suggestions), not space-card titles. This narrows the 2026-11-15 "nothing twice" rule for a title line that carries no question.

## 4. Files by layer, and tests

### Files

**core/**
- `digest.ts`: `select`, `previewDigest`, `getDigest` and `dueTool` as in decisions 2 and 8; remove the claim code.
- `worth-a-look.ts`: becomes `explore.ts`. `exploreCards`; `snoozeLink`/`unsnoozeLink` without claims; remove `markOpened` and `gonePick`.
- `tidy-up.ts`: the two sets, the snooze test, no minimum, `gone` on `TidyLink`.
- `store.ts`, `fake-store.ts`, `store-contract.ts`, `tool-store-contract.ts`, `link-check-store-contract.ts`: remove `claimSurfaced`/`unclaimSurfaced`.
- `save-page.ts`: update its import path from `worth-a-look.js`.

**store/**
- `sqlite-store.ts`: remove the claim and unclaim methods.

**mcp/**
- `server.ts`: `get_digest` annotations, no `record`.
- `changes.ts`: drop `surfaced`.
- `output-schemas.ts`: drop `never_surfaced`.
- `guidance.ts`: `GET_DIGEST`, `notNow` words.

**ai/**
- `read-stats.ts`: words.

**web/**
- `home-page.ts`: 2d, rows, opened line, no gone row, spine word.
- `skip.ts`: was `not-now.ts`.
- `edit-link.ts`: `skip`, and `onCard` drops the intent rows.
- `intent.ts`: the widened selector, hints, Undo words, `KEEP_WORKING`.
- `done-link.ts`: `ARCHIVE_HINT`.
- `tidy-step.ts`, `tidy-tray.ts`, `tidy-script.ts`: decision 9.
- `tray-spine.ts`: the word.
- `theme.ts`: three-button CSS, the opened lines, remove `.worth-row .gone-band`, Tidy's three choices.
- `ask-panel.ts`: drop the surfaced line.
- `profile-stats.ts`: words.
- `http.ts`: `GET /` (no gone; `aboveTidy` per Q2b), the `/home/snooze` answer, the `/home/unsnooze` body, remove `/home/opened`.

**Other:**
- `app.ts` (`CHECKED_PAGES`), `mcp/isolation.test.ts`.

**Docs:**
- `README.md`: lines in the sweep.
- `src/web/AGENTS.md`: the menu bullet, trays, the featured card, rows, gone row, Tidy, busy list "Not now" → "Skip".
- `ROADMAP.md`: a dated sub-bullet under 2026-11-19.
- The spec: a new dated section "Owner rulings from the mockup, 2026-11-19 (#340)" with the six rulings and Q answers. Earlier text stays, since specs are dated and not updated.
- Commit the mockup.

### Existing tests to change (obsolete contract, with the reason)

**core:**
- `digest.test.ts`:
  - "getDigest claim", the cooldown cases in "eligibility"/"order", and `never_surfaced` in "reasons" go, because getDigest no longer claims and order is newest-first;
  - "dueTool"/"still_using_check" lose their cooldown and claim cases.
- `worth-a-look.test.ts`, which becomes `explore.test.ts`:
  - "gone pick" goes, because there is no gone pick;
  - "worthALook"'s day-shuffle cases become order cases;
  - "markOpened" goes, because it is deleted;
  - "Not now" loses its claim assertions.
- `tidy-up.test.ts`: the "gone left out" and five-minimum cases invert.
- `store-contract.ts:1294–1463`, `:2282–2312`, `tool-store-contract.ts:336`, `link-check-store-contract.ts:198`: deleted with the method.
- `store/link-removal.test.ts`: `worthALook`/`previewDigest` callers.

**web:**
- `home-page.test.ts`:
  - "the Worth a look gone row" goes;
  - the featured card's buttons and menu, rows' menu, spine word and heading change;
  - `/home/opened` becomes `/links/opened`.
- `home-routes.test.ts`:
  - "GET / with a link that seems gone" becomes "Home shows no gone card";
  - the `/home/opened` two-owner test goes;
  - `/home/snooze` and `/home/unsnooze` change shape.
- `gone-band.test.ts:106`: the Also today row case goes, since rows have no band.
- `edit-link.test.ts`, `intent.test.ts`: menu items and hints.
- `tidy-tray.test.ts`, `tidy-routes.test.ts`: choices, keys, closed words, no minimum.

**mcp:**
- `mcp/http.test.ts`, `changes.test.ts`, `output-schemas.test.ts`, `guidance.test.ts`: digest annotations, no `surfaced`, no `never_surfaced`, guidance text.

**Other:**
- `deps.test.ts`: getDigest claim.
- `ask-panel.test.ts`: surfaced line.
- `isolation.test.ts:912`: `/home/opened`.
- `__ask_off__` fixtures: regenerate with `vitest -u` and read the diff.

### New tests, red first

Each must fail on today's code for the stated reason.

| # | Test (file) | Red today because |
|---|---|---|
| N1 | Explore is stable: with at least six eligible links that all have a reason, two loads a day apart with no action (fake clock moved 1 day) show the same three ids in the same order; deciding the first brings the fourth up (`explore.test.ts`). Confirm it is red on today's code before changing core | `dayRank` picks a different three across days; with only three candidates it would only reorder them, so use six |
| N2 | Open leaves Explore unchanged, through the rendered page: the address the featured card's `openedScript` posts to (read from the rendered `GET /`) is posted for that card; the next `GET /` still shows it, now with the opened line, and `lastSurfacedAt` is unchanged (`home-routes.test.ts`) | the rendered target is `/home/opened`, which claims surfaced, so the card is gone on reload. Posting `/links/opened` directly would pass today and prove nothing |
| N1b | Focus stability on real FTS (`sqlite-store` + `FtsSearch`): one focus entry matches four or more To explore links saved 20+ days ago, and three newer links don't match. Record the featured id, call Tell me why on it with words outside the focus text, and reload: the featured id is the same. Repeat with six unrelated saves that share a focus word instead of the why (`explore-fts.test.ts`) | bm25 rank order plus the per-entry cut move the featured card (challenge probe: L2 −5.99 → −4.97, which flips it) |
| N3 | Order, one sort key: links saved on days 1, 2, 3, 4 with no focus give featured = day 1, rows = days 2, 3 under (A), or day 4, then days 3, 2 under (B). Focus matches come first in the same direction. A link with no reason (has a why, saved yesterday) is picked. Under (A), a link skipped and then past its two weeks returns to its old place (`explore.test.ts`) | rotation is oldest-touched first; the reason gate drops it |
| N4 | Skip writes no surfacing: `snoozeLink` leaves `lastSurfacedAt` as it was and records `not_now`; Undo clears the snooze and the event (`explore.test.ts`) | snoozeLink claims surfaced |
| N5 | Tidy respects Skip: an old To explore link snoozed until tomorrow is not in `tidyQueue`; a gone link snoozed likewise is not either; after the snooze it is (`tidy-up.test.ts`) | `qualifying` has no snooze test |
| N6 | Tidy asks about gone pages: a gone To keep link and a gone new To explore link are steps with `gone: true`, ordered first; a gone kept tool is not (`tidy-up.test.ts`) | gone links are excluded |
| N7 | No minimum: one qualifying link gives a session of one; none gives null (`tidy-up.test.ts`) | null below five |
| N8 | Home has no gone card: `GET /` with a flagged active link renders no `.worth-gone` and no Keep it for it, and Tidy's tray holds its step with It still works and Archive, no Keep (`home-routes.test.ts`) | the gone row is drawn with Keep it in its ⋯ |
| N9 | Tidy's gone step, end to end in the script harness: key 1 posts `/links/still-works`, Undo posts `/links/still-works/undo` with `{id, check, previous}` and the step returns. Key 3 does nothing on a gone step; on an explore step key 2 posts `/home/snooze` and its Undo `/home/unsnooze` with `{id, until}` (`tidy-tray.test.ts`) | no such acts or keys |
| N10 | `get_digest` writes nothing: two calls return the same ids; `lastSurfacedAt` and the `link_events` rows are unchanged; annotations are read-only and idempotent; no `surfaced` change is recorded (`mcp/http.test.ts`, `changes.test.ts`) | claims and records |
| N11 | The featured card is 2d: Open it, then Keep (`data-act=intent-keep`, check icon), Skip, Archive, in that order; pressing Keep posts `/home/keep` and takes the card out with Undo `/home/undo-intent`. Its ⋯ has no Skip and, if the owner accepts Q3's recommendation, no Keep it or Archive; the menu assertion follows Q3's answer (`home-page.test.ts`) | Not now / Archive pair; the menu handler ignores a slide |
| N12 | Rows' ⋯: seven items, Skip first ("Back in two weeks"), then Keep it ("Moves to To keep") (`home-page.test.ts`, `edit-link.test.ts`) | Not now first, old hint |
| N13 | Kept-tool exclusion stays (carried O1): a link written as intent explore with a kept tool row, seeded straight through the store, is not an Explore card and not a `get_digest` pick. Confirm by mutation: drop the `tools` filter and the test fails (`explore.test.ts`) | passes today; this is a regression guard, so its red proof is the mutation |
| N15 | Bounded snooze: a 40-day-old, never-opened To explore link given `snoozedUntil` 10 years ahead through `updateLink` is still in `tidyQueue`, while Explore leaves it out. One snoozed exactly `SNOOZE_MS` ahead is left out of both (`tidy-up.test.ts`) | first half passes today, since Tidy ignores snoozes; it is red against N5's unbounded fix, so write it alongside N5 and see it fail on an unbounded `qualifying` |
| N16 | An Edit to To keep on an Explore card: Save from the dialog with intent keep on the featured card takes the card out of `#worth-cards`, and its edit Undo brings it back (`home-page.test.ts` script harness) | the card stays with a live Keep slide |
| N14 | No Today promise survives: no rendered Home, list or Tidy page and no script constant contains "Today and Tidy up" or "won't ask about it" (`intent.test.ts`) | `KEEP_IT_ITEM` and its Undo say it |

### Verification before review

- `npm run check`.
- Run `command grep -rnE "claimSurfaced|SURFACE_COOLDOWN|dayRank|markOpened|gonePick|never_surfaced|/home/opened|NOT_NOW|Not now|Worth a look today|worth-gone"` over `src/` (non-test), `README.md` and `src/web/AGENTS.md`. Expect only dated migrations and the Stats wire key `notNow`.
- A browser check, light and dark, at 390px and 1280px, and with `hover:none`:
  - the 2d row and the measured fade thresholds;
  - the stacked phone buttons;
  - both opened lines;
  - Tidy's gone and explore steps with their keys;
  - the empty tray going.

## 5. One PR or a sequence

**One PR.**
- **Explore's selection and `get_digest` share `select`.** Changing one without the other would leave two orders for one fact.
- **Removing Home's gone row and adding Tidy's gone step must ship together.** Otherwise gone pages lose their question for the gap between deploys.
- **Skip is the same action on both surfaces.** Skip on Explore and Skip in Tidy use the same snooze.
- **There is no migration.** A revert is a plain `git revert`.

**Considered:** splitting the claim removal (store interface and contracts) into a follow-up. Rejected: dead store methods would outlive the rule that needed them and read as live.

## 6. Owner rulings (decided)

The owner answered "all yes" to Q1–Q9 (#340 comment 7040987391). Q6 was decided by the coordinator.

1. **Q1.** Cards may move without a decision, through the causes listed in decision 1.
2. **Q2.**
   - (a) A link opened often from elsewhere is accepted as a gap.
   - (b) Tidy skips only Explore's cards and Handy, not the space-card titles.
3. **Q3.** The featured card's ⋯ leaves out Keep it, Explore it and Archive, so it starts at Keep handy.
4. **Q4.** The rows' label is "More to explore".
5. **Q5.** Tidy's Skip has no marker.
6. **Q6.** `lastSurfacedAt` stays, frozen (decision 7).
7. **Q7.** Explore has one focus card; `get_digest` has three, on the same order.
8. **Q8.** The words in decision 13 and decision 9 are adopted. The Skip and Explore it hints follow whichever order is built.
9. **Q9.** In Tidy, gone pages come first, then old links.

**Still open with the owner:** order (A) oldest first or (B) newest first (decision 1). The coordinator recommends (A). The plan builds either: one `dir` and the hints in decision 13.

## 7. Challenge resolutions

The review is `.claude/reviews/solution-choice-6cb4e5a….md`, which returned REVISE. The coordinator's dispositions:

- **Obj 1, accepted.** Focus picks are a membership with no rank and no per-entry cut, sorted by the main key (decision 1). N1b runs on real FTS.
- **Obj 2 and Obj 3, pending the owner.** Both orders are written out (decisions 1, 3, 13 and 15). The coordinator recommends (A).
- **Obj 4, accepted.** Tidy honours a snooze only within `SNOOZE_MS` of now (decision 3). N15.
- **Obj 5, accepted.** An Edit that makes a card To keep takes it off Explore (decision 11). N16.
- **Obj 6, accepted.** Decision 7 is reworded: import still writes the column.
- **Open questions:**
  - **The digest for #132:** it follows the same order; that is for #132 to judge.
  - **A To keep page that is flagged gone again and again:** It still works answers it each time. Accepted as before, since the gone row looped the same way.
  - **Q7 "as Home has now":** inexact. "At most one" is new behaviour, now ruled.
