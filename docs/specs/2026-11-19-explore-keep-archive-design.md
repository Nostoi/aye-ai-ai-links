# To explore, To keep, Archive: what Today is for

Dated 2026-11-19. Owner decisions from the session of that date; Claude's calls are marked.

## Why

The owner, who designed Home, could not say what Today's buttons did or why Today exists:

- **Open it** silently marks a link surfaced, so Home leaves it out for 14 days.
- **Not now** ("Not suggested for two weeks") gives no sense of what it is "not now" against.
- **Done with it** made the owner nervous: does the link leave All links, tags and spaces? (It leaves their main lists and goes to the "Done and put away" view; search still finds it.)
- **Put it away** reads like Not now, and differs from Done with it only in that a later focus note sharing its words can bring it back.
- Every active link that is not kept handy can show on Today, including the Bills space's links, which never go stale and should never be surfaced.
- The owner has never felt like opening a forgotten link Today showed them.

The problem worth solving is not forgetting (search and Ask AI find things well) but two others: clutter, and links the owner meant to explore that silently never got a decision.

## The model

Every link carries the owner's **intent** for it, worded as intent, never as a settled state, because a "settled" state that turns out not to be settled feels bad.

| Intent | Meaning | Today | Tidy |
|---|---|---|---|
| **To explore** | Saved, maybe to read, try or watch. Every new link starts here. | Shown | Asked about once it has sat a while |
| **To keep** | Something to hold on to and return to: bills, accounts, docs, a tool. | Never | Never (only if its page seems gone) |

**Archive** is the one way to let a link go: out of the main lists of All links and every space, into each one's Archived view, still found by search and Ask AI. It replaces Done with it and Put it away.

**The guarantee:** every To explore link reaches a decision (Keep or Archive), or is asked about again. Nothing is resurfaced by age alone on Home, and no archived link comes back on Home.

## Today

Today shows To explore links, with three verbs on each card:

- **Keep**: the link becomes To keep. Today and Tidy never ask about it again.
- **Skip**: not now; Today shows it again in two weeks. The small line says so.
- **Archive**: out of your lists, still found by search.

**Open** only opens the link. It records the opening (as every opening is recorded) and changes nothing else: no hidden 14-day rest.

Every action shows the Undo bar, as now.

## Tidy

Tidy asks about To explore links saved at least 30 days ago and not opened in 30 days, five at a time, with the same three verbs. Tidy also asks about any link whose page seems gone, whatever its intent: Today no longer has a gone row.

## AI guesses

An AI may set intent with a source, as it does a why: "stated" or "asked" when the owner gave it, "inferred" otherwise. An inferred To keep is shown as "To keep (a guess)". A link with no guess is To explore (owner, 2026-11-19: if it's wrong, Today shows it and the owner fixes it; a wrong To keep is silent).

## Decided by the owner

- Today is for To explore links; Tidy is where long-unanswered ones and gone pages get asked about.
- Intent is set on each link, not on a space.
- Words: **To explore / To keep**; buttons **Keep / Skip / Archive**. Rejected: reference, to read, to use, to finish, to come back to, evergreen, Keep/Maybe, Undecided/Kept, Later. Pairs must match in grammar, and buttons are verbs.
- The default intent is To explore.
- Done with it and Put it away become one Archive; archived links never come back on Home.

## Approaches considered for storing intent

1. **A field on each link** (`intent`, with its source). Chosen (Claude's recommendation, accepted): it labels a guess the way a why is labelled, and it is not a topic.
2. **A special "keep" tag.** Reuses tag pages, but puts a kind of link among the owner's topics and spaces, where it can be renamed, merged or deleted by accident.
3. **Intent per space.** Rejected by the owner: a space can hold both kinds.

## Landing order

Three PRs, each usable alone:

1. **One Archive.** Put-away links become archived. Put it away, Done with it and the came-back rule go; "Done and put away" views become "Archived". MCP: `update_link`'s `putAway` and the `came_back` digest reason go.
2. **Intent.** The field and its source, the edit dialog's control, MCP `save_link` / `update_link` / output schemas, the export, and a one-time guess for existing links.
3. **Today and Tidy.** Today shows To explore links with Keep / Skip / Archive; Open stops marking surfaced; Tidy takes the gone row and the To explore rule.

## Claude's calls (the owner may overrule any)

- **Field name** `intent: "explore" | "keep"` with `intentSource`, on the wire as on the link.
- **A link kept handy is To keep.** Keeping a link handy sets intent to To keep with the same source; Not handy anymore leaves intent alone.
- **Existing links:** every link kept handy becomes To keep (its handy source); every other active link starts To explore, then one AI pass (when `AYE_AI_` is set up) guesses To keep for obvious ones, as inferred.
- **Today's order:** links matching a current focus entry first (with their "mentions X" reason), then newest saved first. Newest first because a fresh save is the intent most worth acting on; old ones go to Tidy. At most three cards, as now.
- **Skip** reuses `snoozedUntil` (two weeks). Tidy's Skip waits as Tidy's Keep does today (180 days, `tidyKeptAt`), since a Tidy question is a bigger one; the small line under each says which.
- **The ⋯ menu**, mildest first: Keep or Explore it (whichever the link isn't), Archive, Keep handy, Edit, Remove saved copy, Delete link. Today's Skip is on the card only. Six items.
- **`get_digest`** picks only To explore links, by Today's rule.
- **Export version 4** (the format is already at 3) adds `intent` and `intentSource`. PR 1 stays on version 3 and writes `putAwayAt: null`; reading treats any old `putAwayAt` as archived.
- **Event log:** Archive records `archived`; Keep and Explore record `intent_changed`. Old `put_away` and `stale` events stay as history; Stats count them all as set aside.

## Settled after the builder check (Claude's calls)

- **Today's filter** is only: active, To explore, not skipped (`snoozedUntil` past), page not gone. The digest's reason gate and the 14-day surfaced cooldown no longer apply to Today, and `get_digest` uses the same filter and no longer marks links surfaced, so nothing hides a link silently. `lastSurfacedAt` stops affecting selection.
- **Opening never changes state.** Opening an archived link (from search, a saved copy or MCP `opened`) leaves it archived; Bring it back is the only way back. This retires opening's put-away reactivation.
- **Tidy has no five-link minimum.** It is offered when at least one link qualifies, and a session is up to five. Tidy still skips links Home shows above it.
- **Skip is one action everywhere:** two weeks, `snoozedUntil`, event `not_now`. Tidy respects it, so a link skipped on Today stays out of Tidy too. Skip no longer marks a link surfaced. Tidy's 180-day Keep wait goes: a link kept in Tidy within the last 180 days (`tidyKeptAt`) becomes To keep, stated, and the field is retired.
- **Handy:** a kept tool is To keep, so its cards never offer Keep. The shelf keeps its own questions (Still using it?, its gone tile), and Tidy skips kept tools, so nothing is asked twice. Archive on a handy link leaves its tool row as it is today (the shelf lists only active links).
- **Intent writes follow the why's rule:** an AI may set intent where there is none recorded or replace an inferred one, never one the owner stated or answered. The owner's Keep, Explore it, and a Tidy or Today choice are "stated". A guess shows as "To keep (a guess)" on list rows and in the edit dialog; confirming it there makes it stated.
- **Undo:** `StateChange` gains intent and its source, so Archive's and Keep's Undo restore them.
- **MCP:** `putAway` and `came_back` are removed in PR 1, not kept for compatibility; agents read the tool list on each connection.
- **The existing-links guess** is a one-off, resumable pass like the summary pass, run when the AI connection is set up. PR 3 (Today) deploys only after it has run on the server. With no AI, every link starts To explore, as the default ruling accepts.
- **Today's cards:** up to three To explore links in today's layout (featured card, then Also today rows); the tray goes when empty.

## Today from day to day (owner, 2026-11-19, option A)

The same cards stay until the owner decides: the newest undecided links (focus matches first) remain on Today until Keep, Skip or Archive. Opening a card changes nothing about which cards show; once a card has been opened, it adds a small line, "Opened. Keep it or archive it?". Rejected: a daily rotation (a link can drift in and out undecided, the problem this design solves) and opened cards stepping aside (a hidden effect of opening).

## Non-goals

- No meaning match for nudges (#68 stays its own work).
- No change to Handy, spaces, search or Ask AI beyond the Archived wording.
- No counters of undecided links on Home (no guilt counters).

## Anti-goals (failure even if it works)

- A button whose effect outside Today is unclear from its words.
- A To keep link surfaced on Home.
- A link archived that the owner cannot find again.
- A To explore link that sits forever with no question asked.

## Left to the builder

The mockup decides layout and words of the small lines. The plan decides the migration's SQL, the event kinds' exact names and test structure.
