# Tidy up: letting old links go without losing them (#198)

Dated design record, 2026-10-21. Written from an owner conversation in session. The visual reference is `docs/design/tidy-up-mockup.html` (mockup B2), which the owner chose after a design critique. Its example links and projects are made up. Where it and this text differ, this text governs, because it carries the owner's later rulings (the ⋯ menu entry and the It's stale rename).

## Why

The owner saves far more than they revisit. Old links are hard to let go for one reason, in their words: "not knowing whether I want to keep it or knowing whether I'd need it. Fear of losing something important." In particular: "what if I have a future project and need to not forget about this and how do I remember that I have it?" They also said "some links genuinely go stale."

Today **I'm done with it** archives a link. Search still finds an archived link, but the digest and Worth a look never bring it back. So a link let go today is safe only if the owner remembers to search for it, which is the fear itself.

Research read in session supports the shape below:
- A middle option between keeping and deleting makes letting go easier. People avoid deleting because a loss feels larger than the gain (Bergman et al., CHI 2009, "GrayArea"; 84% of 70 preferred a demote option).
- Deleting tends to hurt later retrieval (Englefield & Beale, 2025).
- For ADHD, what is out of sight tends to be out of mind. Event-triggered reminders work better than date-triggered ones. This is coaching-level advice, not trial evidence.

## Goals

1. A short, finishable session that asks about old links one at a time, so letting go is a small task the owner chooses to start.
2. A safe middle choice, **Put it away**. It takes a link out of the lists and brings it back by itself when the owner starts something it fits.
3. Every choice says what it does. Each one shows a reassuring message with Undo afterwards.
4. Let-go language that doesn't feel final: **It's stale** replaces **I'm done with it** everywhere.

## Non-goals

- Deleting. Tidy up never deletes; Delete link stays in the ⋯ menu only.
- Counts, streaks, scores or "you have N old links" anywhere (design rule 6).
- Date-based reminders for put-away links. They come back on a match, never on a schedule.
- Making the match smarter than today's focus matching. That is #68's work.

## Anti-goals (a failure even if it works)

- A put-away link that silently never comes back while the screen promised it would. The promise must be worded so it matches what the app actually does (see "Coming back").
- A session that feels like a chore or a judgement: no guilt wording, and never more than five links per session.
- Anything that makes letting go feel irreversible. Undo always works, and nothing is lost.

## The owner's decisions

### Three outcomes for a link

| Choice | What it does | Its line in Tidy up | Message after |
|---|---|---|---|
| **Keep** | Nothing changes. Tidy up won't ask about it again for six months. | Stays in your lists, as it is now. | No bar; the next link comes in. |
| **Put it away** | The link leaves the lists, still saved. It comes back when the owner starts something it fits. | Out of your lists. Comes back when you start something it fits. | **Put away.** Out of your lists but still saved. If you start something it fits, it'll come back. *Undo* |
| **It's stale** | Today's archive, renamed. | Out of sight for good. Search still finds it. | **Let go.** You won't see it again unless you search for it. *Undo* |

- Put it away is the safe default. It is marked with a soft fill and "If you're not sure". It is not filled black, and it has no outline, so it never looks already picked.
- The owner wanted the message after Put it away, so people know what it does. The wording above is the agreed draft.
- The six-month Keep wait is Claude's call, shown on the mockup and not objected to.

### Renaming "I'm done with it" to "It's stale"

The owner: "it's stale feels less threatening and irreversible." The action is called **It's stale** everywhere the owner is offered it: the card ⋯ menu, Home's featured card and Also today rows, the gone row, the Handy tile's ⋯ menu, and Tidy up. Its Undo bar keeps the action's name. The README, `src/web/AGENTS.md` and the MCP tool descriptions change with it.

### Put it away is also in the ⋯ menu

Owner ruling. It goes right after It's stale. A card's menu grows to six items (seven on Home's Also today rows). This is a second exception to the five-item rule in `src/web/AGENTS.md`, and is recorded there and in `ROADMAP.md`. A put-away link's menu starts at Edit, like a stale link's.

### What counts as old

A link is asked about when all of these hold:
- it was saved at least 30 days ago;
- no opening of it has been recorded in the last 30 days;
- it is active (not stale, not put away);
- it is not on the Handy shelf;
- the owner hasn't chosen Keep for it in Tidy up within six months.

This is the same 30-day line the digest already uses (`NOT_OPENED_MS`), so "old" means one thing everywhere.

**Order:** links whose page seems gone come first, because they are the easiest to decide. Then the rest, oldest saved first.

### Where it starts

- At the bottom of Home, a quiet line: "Clear out a few old links? Five, one at a time. Nothing gets deleted." with **Start**. It appears only when at least five links qualify. The owner's library qualifies around mid-November 2026.
- A session is five links. Afterwards: "That's five. Done for now." with **Back home** and **Five more** (the latter only when five more qualify).
- **Stop here** leaves at any point. Choices already made stand.

### The screen (mockup B2)

One link at a time, centred, at most about 580px wide, the same on computer and phone (stacked on phone). From top to bottom:
1. **Tidy up** heading, five progress dots (with "Link 2 of 5" for screen readers), **Stop here**.
2. The card: a small picture square, title, grey line (space in its color, site), "Why you saved it" and the why.
3. Two fact lines:
   - When saved and opened, in plain words: "Saved in March. You haven't opened it since." / "Opened once, last May."
   - The fit line. Either "Might fit **<what you're working on>**, which you're working on.", or "Doesn't fit anything you're working on now.", or no line at all when the profile has nothing current.
4. **Open it to check**: opens the link in a new tab and records an opening, like every link (#124).
5. Three stacked choices, each with its line, in the order Keep, Put it away, It's stale. Keys 1, 2 and 3 pick them on a computer; the key hints are hidden on phones.

The design rules hold: no amber (nothing here "needs you"), the space keeps its color, controls are at least 44px tall, and the page makes no outside requests.

### Coming back

A put-away link comes back when the owner starts something it fits. "Starting something" is a **focus entry** in the profile ("what you're working on") created **after** the link was put away. "Fits" is the same matching the digest's `focus_words` reason uses today: a keyword match of the focus text, which is not proof of relevance.

When that happens, the link becomes eligible again for:
- **Home's Worth a look** (what counts most to the owner), with its reason: "You put this away in March. It fits <focus>." in the link's space color, or neutral without one;
- **the digest your AI gets**, with the same reason;
- **search**, where a put-away link ranks normally and is never faded. Only stale links fade.

The owner's words were "all three but home page is what counts."

Claude's calls on the details:
- **Back for good.** Once a newer focus entry matches it, the link is active again: back in its lists, with no special state. Its put-away date is kept, so Home can show "You put this away in March". The match is checked whenever Worth a look or the digest is built, so it needs no timer.
- **Back only by fitting.** While put away, a link gets no other digest or Worth a look reason, such as not opened recently or no why. Coming back through a match is the only way in.
- **First in line.** On the day a link comes back, it takes Worth a look's featured card ahead of ordinary focus matches, because Home is what counts most to the owner. After that it follows the normal rules: the cooldown, Not now and snoozes.
- **"Working on now"** for both the fit line and coming back is the digest's own window: focus entries from the last 30 days (`FOCUS_WINDOW_MS`).
- **Leaving the section.** Bringing a put-away link back by hand from **Out of your lists** makes it active, the same as a match does.

**Limit to be honest about:** a put-away link comes back only if the owner, or an AI, records what they're working on. The message says "if you start something it fits", not "when it's useful", and the README says how this works.

### Where put-away links are listed

Claude's call. All links and space pages already end with a faded **Links you're done with** section. It becomes **Out of your lists**, holding both stale and put-away links. Each row's grey line says **Put away** or **Stale**. It also needs a way to bring a link back, which the builder settles with the same Undo-style reversal the menu offers.

## Constraints

- Doors hold no rules. Eligibility, ordering, the Keep wait and coming back are `core/` rules. The web page only shows them.
- `store/` owns owner scoping. Put-away and stale are not deleted, so the hidden-link rule (`deleted_at`) does not apply.
- The Undo pattern stands: the action happens at once, and Undo reverses it with a second request (`src/web/AGENTS.md`).
- A card takes one action at a time (#208): Put it away joins `cardBusy`.
- A new signed-in POST joins `CHECKED_PAGES`. New routes pass the owner-isolation guard.
- Migrations follow the existing numbered sequence. The live library must survive one: its links, archived state and openings stay intact.

## Left to the builder

- How put-away is stored: a third value in `STATES`, or a separate field. Either way, today's archived links become stale links unchanged, and every reader of `state` (store, search, digest, Worth a look, export, MCP tools, the Save page's "Bring it back") gets the new case on purpose.
- How Keep's six-month wait is recorded.
- The wire value stays `archived` (Claude's call, for compatibility). The MCP tools and the export keep sending `"archived"` for a stale link, so connected AIs and old exports don't break; only the words the owner sees change. Put-away gets a value of its own on the wire.
- How AIs reach it: whether `update_link` can put a link away, and how list and search report it. Keep the MCP descriptions in their folder's style.
- The Tidy up route and its URL, and how a session holds its five links across choices and Undo.
- Splitting the work into PRs.
