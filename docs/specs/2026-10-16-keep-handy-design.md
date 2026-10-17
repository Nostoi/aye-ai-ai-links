# Keep handy: design (2026-10-16)

Issue #125. Owner rulings are from the 2026-10-16 session and are recorded in #125's body and comments 6225169643 and 6225715918. This is a dated design record; later ROADMAP.md entries override it.

## Goal

Some saved links are tools the owner uses regularly, such as a school's attendance site or a lunch-order form, not reading. Today "Worth a look today" nudges them like forgotten reading. Keep handy:
- takes tools out of the reading nudges;
- puts them one click away on a Handy shelf;
- still catches a tool that has gone stale, by asking "Still using it?" one tool at a time.

## Stored data

Migration 12 adds the `link_tools` table. Existing tables are unchanged.

| Column | Meaning |
|---|---|
| `owner`, `link_id` | Primary key. The row is deleted with its link through a composite foreign key, as `link_tags` rows are. |
| `status` | `kept`, `suggested` or `declined` |
| `source` | `stated`, `asked` or `inferred` |
| `since` | When the link became a tool or suggestion (epoch ms) |
| `answered_at` | The last "Still using it" answer, or null |
| `wait_days` | 30, 60 or 120 |

A link with no row is an ordinary link. A `ToolStore` interface in `core/`, implemented by `SqliteStore` and `FakeStore` and sharing a contract test, takes the owner on every call. This is the same pattern as `SnapshotStore`.

## Rules (`core/tools.ts`)

Every rule lives here. The web door and the MCP door only translate requests into calls to it.

- **Keep handy** sets `kept` with the given source and `wait_days = 30`. It works from any status, including `declined`, because it is the owner's request.
- **`since`** is set to now whenever the status changes, so a late Yes to a suggestion, or a re-kept link, is not due at once.
- **Suggest** is for an inferred keep only. It does nothing when the link is `kept` or `declined`; otherwise it sets `suggested`.
- **Answer a suggestion.** Yes sets `kept` with source `asked`. No sets `declined`.
- **Not handy anymore** sets `declined`, so no agent re-suggests the link.
- **Last check** is the later of `answered_at` and `since`. **Clock start** is the latest of `lastOpenedAt`, `answered_at` and `since`.
- **Current wait** is 30 days when `lastOpenedAt` is at or after the last check (an opening in the same millisecond counts) (any opening resets the wait to 30 from that opening); otherwise it is the stored `wait_days`.
- **Due** means a `kept` tool on an active link with `now − clock start ≥ current wait` days. An archived link is never due.
- **Still using it**, answered while the tool is due: `wait_days = min(2 × wait_days, 120)` when nothing was opened since the last check, otherwise `wait_days = 30`. Answered while it is not due, the wait is unchanged except that an opening since the last check sets it to 30; nothing doubles, so a repeated or unprompted answer can't jump the wait. In every case `answered_at = now`. (Corrected 2026-10-16 before implementation: the first draft compared `lastOpenedAt` with the clock start, which always doubled, and ignored openings when checking due, against the #125 ruling.)
- **No write on opening.** An opening of any kind moves the clock start through `lastOpenedAt`: a web opening (#124) or `update_link` with `opened: true`. Neither path needs to know about tools (#125 comment 6225715918).

## Digest (`core/digest.ts`)

- A `kept` tool gets no reading reason: no `no_why`, `not_opened_recently`, `never_surfaced` or `focus_words`. The surfaced claim enforces this too, so a link kept between selection and claim is neither returned nor marked surfaced.
- PR 2 keeps a due tool out of home's ordinary Worth a look cards (`worthALook` reads `previewDigest`); it shows on the shelf instead.
- A due tool is a separate item with reason `still_using_check` and its days since `lastOpenedAt` (null when never opened). At most one appears per digest, and it takes one of the 5 slots.
- It uses the same surfaced claim and 14-day cooldown as other picks.
- Suggested and declined links are ordinary links in the digest.

## MCP

- **The `handy` input.** `save_link` and `update_link` take an optional `handy`:
  - `keep` with `stated` or `asked` keeps the link; with `inferred` it suggests it;
  - `still_using` (`stated` or `asked`) records the answer;
  - `not_handy` (`stated` or `asked`) declines it.
  - A repeat `save_link` keeps its existing contract (it only fills a missing why), so marking an existing link goes through `update_link`.
- **The `handy` output.** Link output gains `handy`: null or `{status, source, due}`. `tools/list` already accepts added fields (#39 entry).
- **`get_digest` gains `still_using_check`.** Adding a reason value is a breaking change for a validating client holding an earlier `tools/list` (#39 entry); this is accepted and noted in the PR.
- **Guidance:**
  - an owner who says they use a link regularly → `keep` with `stated`;
  - a link that only looks like a tool (a login page, form or dashboard) → `inferred`;
  - ask "Is this something you'll use regularly?" at most once per save, and only for tool-like pages;
  - for a still-using item, report the days since the last recorded opening and never say the owner hasn't used it, since bookmark clicks are not seen.

## Web page

**Home order:** the search box, the Handy shelf, Worth a look today, Your spaces.

**The shelf:**
- **Tiles:** one row of up to 8 kept tools on active links (an archived link leaves the shelf, and its Undo brings it back), most recently opened first, with never-opened tools ordered by `since`. A tile shows the title and site, styled like home's small cards.
- **Clicks** open the link in a new tab and post `/links/opened` through #124's `openedScript`; they do not mark the link surfaced.
- **Show all** expands the rest in place.
- **On a phone** (below the site's 600 px breakpoint), the row keeps all 8 tiles and scrolls sideways, owner ruling 2026-10-16. The next tile shows partly at the edge, so it's visible that the row scrolls. Show all still follows.
- **A due tile** shows "Still using?" with **Yes** (still using it) and **Done** (archives the link, with an Undo bar).
- **Suggestions** are faded tiles at the end with "Keep handy?" and Yes or No.
- **Add** opens a search over the owner's links; picking one keeps it handy.
- **Each tile's menu** has "Not handy anymore", with an Undo bar.
- **An empty shelf** shows one line, "Keep links you use often here", with Add.

**Elsewhere:**
- Search results, All links and space pages give each link a "Keep handy" text button, which reads "Handy · Not handy anymore" once the link is kept.
- Worth a look today gets a fourth button, Keep handy, on large and small cards.

**Routes:**
- `POST /tools/keep`, `/tools/not-handy`, `/tools/still-using`, `/tools/suggestion` and `/tools/undo`. Undo restores the row as it was, only while the row is still what the action wrote. It has no time limit in core, like home's conditional Undo (2026-10-14 #95, and the 2026-10-16 ruling on Undo of I'm done). The Undo bar itself closes within 45 s.
- Each is in `CHECKED_PAGES` and the isolation route guard, and each calls `core/tools.ts`.

## Testing

- **Red first.**
- **Store:** the contract covers owner isolation and deletion with the link.
- **Rules:** with an injected clock: due at 30 days and not at 29; doubling 30 → 60 → 120 and capped; reset by a web or MCP opening; an inferred suggest never overriding kept or declined; archived never due.
- **Digest:** no reading reasons for kept tools; at most one `still_using_check`; the cooldown applies.
- **MCP:** every `handy` value × source; output schemas through the `tools/list` enumeration; guidance wording.
- **Web:** two owners, cross-origin and no session on every route; order and the 8 cut; the due marker, suggestions, Undo, the per-page buttons and the Worth a look button; shelf clicks don't mark the link surfaced.

## Landing

1. **Store and rules:** migration 12, `ToolStore`, `core/tools.ts` and the digest's exclusion of kept tools. It also carries every core read and action PR 2 and PR 3 need (the shelf list, the suggestions, the due tool for the digest, the `handy` view of links, and conditional Undo), so those two PRs can be built in parallel without editing core (owner, 2026-10-16). Owner-invisible on its own. Carries this spec and the ROADMAP entry.
2. **MCP:** `handy` input and output, `still_using_check`, guidance, and README. Tools can be marked through an AI from here on.
3. **Web:** the shelf, the controls, and README. Closes #125. PR 2 and PR 3 are built in parallel after PR 1 merges; whichever merges second brings `main` in before its final review.

## Not in scope

- A drag-to-reorder shelf; the owner may want it after trying recency order.
- Pairing tools with dead-link checks (#128).
- Recording openings of links an AI hands out (#133).
