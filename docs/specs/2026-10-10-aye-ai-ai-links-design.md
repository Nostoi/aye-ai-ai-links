# Aye-AI-AI Links — design

- **Date:** 2026-10-10
- **Status:** awaiting owner review
- **Scope:** whole project, phases 0–4. This is a dated design record. Live state (current phase, decisions made later) lives in `ROADMAP.md`; working rules live in `AGENTS.md`.

## 1. Problem and goal

The owner saves links in many places and then forgets them: where they are, when they were saved, why, and what they were about. Sometimes only a vague memory remains ("that sleep thing from spring").

Aye-AI-AI Links is a personal link library that AI assistants run for you:

- **Save by talking.** Give any AI a link and a short note. It files the link where you'll find it, using what it knows about you, and records *why* you saved it.
- **Find by talking.** In any chat: "any links I saved that help with this?" The AI searches your library and uses what it finds.
- **Get nudged.** Digests bring old links back when they match what you're doing now.
- **See it calmly.** A simple, visual web page designed for an ADHD brain.

**Success looks like:** the owner saves from ChatGPT or Claude on the phone, or from Claude Code or Codex on the computer, and later finds a half-remembered link by describing it vaguely, without remembering where or when it was saved.

**Constraints:**

- open source (MIT);
- AI-agent agnostic;
- no paid AI API keys;
- free-tier friendly;
- self-hosted at home and movable to other hosting;
- simple, DRY and SOLID, not over-engineered.

## 2. Decisions

| Topic | Decision |
|---|---|
| Users | Single owner first. Multi-user *foundation* only: every row has an owner and every query is scoped to it. No signup flow, sharing, teams, or billing. |
| Who does the AI work | The agent saving or searching the link. The server stores, fetches, searches and selects; it never calls an AI model API. |
| Hosting | An always-on MacBook at home, reached through Tailscale. Public HTTPS via **Tailscale Funnel** from the start of phase 3. Packaged so it can move to any host. |
| Stack | TypeScript on Node; Hono with server-rendered JSX; SQLite (better-sqlite3) with FTS5; sqlite-vec plus a local embedding model for meaning search; MCP TypeScript SDK v2; better-auth for login and OAuth. |
| Organization | Tags, not folders. Tags are *topics* or *projects*. Pinned tags act like folders on the web page. |
| Agent knowledge of the owner | A shared profile in the app (notes plus a focus log) that every agent reads and updates. Each AI's own memory is a personal extra, not a synced copy. |
| Agent instruction files | `AGENTS.md` only, no `CLAUDE.md`. Claude Code reads `AGENTS.md` when no `CLAUDE.md` exists (v2.1.277+; verified in the Claude Code docs, 2026-10-10). |
| Project tracking | `ROADMAP.md` tracked in git; tasks as GitHub issues with one milestone per phase. No TASKS.md. |
| Repo | GitHub, MIT, **private until phase 4** is done, then public. |
| Checks | Local first: one `npm run check` command (typecheck, lint, tests), run by a git pre-push hook. GitHub Actions runs the same command on pull requests as a backstop. |

## 3. Architecture

One process. One core holds all rules; three thin "doors" translate requests into core calls.

```
            ┌── mcp/   AI connector (ChatGPT, Claude, Codex, Claude Code)
 requests ──┼── api/   JSON API (scripts, future share-sheet)
            └── web/   the web page
                  │
               auth/   web sessions, per-agent keys, connector OAuth
                  │
               core/   rules: save, dedupe, why, tags, profile, digest selection
                  │
     ┌────────────┼─────────────┐
  store/       search/        fetch/
  SQLite       keyword +      page snapshot
  (swappable)  meaning
```

Rules:

- **Doors hold no rules.** Every rule (what counts as a duplicate, how the why is labelled, which links a digest picks) lives once in `core/`.
- **`core/` depends on interfaces, not implementations,** for `store/`, `search/` and `fetch/`. This makes testing easy and lets a Postgres store replace SQLite later without touching the rest.
- **Owner scoping is enforced in `store/`.** Every data call takes the owner. No door can forget it.

Scale: a single SQLite file on one server comfortably fits this workload. The ceiling is one machine (no horizontal scaling or failover); the escape hatch is a Postgres implementation of the `store/` interfaces. It is not built now.

## 4. Data

★ marks values labelled with their **source**: `stated` (owner said it), `asked` (agent asked, owner answered), or `inferred` (agent guessed).

**User:** id, display name, created_at. Login records come from better-auth.

**Link**

- `url` and `url_key` (normalized URL). The pair (owner, url_key) is unique: saving it again returns the existing link, not an error.
- `title`, `summary` (one or two lines written by the agent).
- `why` ★, which may be **missing**. Missing whys are surfaced gently later.
- Snapshot: page title, description, main image URL, readable text, `fetched_at`, `fetch_status`.
- History: `saved_at`, `saved_by` (agent or web), `last_opened_at`, `last_surfaced_at`, `snoozed_until`.
- `state`: active or archived.

**Tag:** name, `kind` (topic or project), color, `pinned`. Projects also have a description and active/done. Link–tag joins carry a source ★.

**Profile note:** text ★, the agent or person who wrote it, updated_at. Editable and deletable on the web page.

**Focus log entry:** text, written by, created_at. Short and dated ("researching home batteries").

Not stored now: full-page archives, per-click event history, sharing.

## 5. Agent interface (MCP)

| Tool | Purpose | Read-only |
|---|---|---|
| `save_link(url, note?, why?, why_source?, summary?, tags?)` | Dedupe, fetch the snapshot, save. Returns the link plus a snapshot excerpt, profile, existing tags and active projects. | no |
| `update_link(id, …)` | Set summary, why, tags; archive, snooze, mark opened. | no |
| `search_links(query, filters?)` | Keyword and meaning search over title, summary, why, tags and snapshot text. Filters: tag, project, date range. | yes |
| `get_link(id)` | Everything about one link, including snapshot text. | yes |
| `get_digest()` | Links worth revisiting, each with a reason. Marks them surfaced. | no |
| `get_profile()` | Profile notes, projects, recent focus. | yes |
| `update_profile(…)` | Add, edit or remove notes; add focus entries. | no |

**Saving.** When the agent already knows the summary, why and tags, it saves in **one call**. Otherwise it saves first (the link is safe immediately), thinks, then calls `update_link`. Unfiled links show as "needs filing" on the web page. Because ChatGPT asks the user to confirm each write tool call, the one-call path is preferred.

**The why rule:**

- stated in the note → `stated`;
- otherwise ask once → `asked`;
- if declined or a bad moment, infer from the profile, focus log and chat → `inferred`.

Inferred values are always shown as guesses.

**Agent guidance ships with the connector.** It lives in one source file in `mcp/` and is used for the server's built-in instructions (if SDK v2 supports them; see §10) and the tool descriptions. Each AI's own memory should hold one pointer: "the owner keeps links in Aye-AI-AI Links; check it when saved links could help."

**Digests:**

- **On request** in chat.
- **Optionally on a schedule** through Claude routines or ChatGPT tasks (see §10).

Selection is deterministic: recent focus matches, long-unopened links, missing whys, never-surfaced links. It excludes snoozed and recently surfaced links. The agent writes the nudge.

The JSON API in `api/` exposes the same operations.

## 6. Web page

Layout **A, "Calm desk"**, approved 2026-10-10. The reference mockup is `docs/design/home-calm-desk-mockup.html`; only option A applies, and its photos are placeholders.

1. A question at the top: "What are you trying to remember?" A big search box that accepts vague descriptions.
2. **Worth a look today:** one large card (image, reason in plain words, saved date and why, three buttons: *Open it*, *Not now*, *I'm done with it*), plus up to two smaller cards.
3. **Your spaces:** pinned tags as picture tiles.
4. Everything else ("All links", newest first, with images) is one click away.

Design rules:

1. **Room to breathe:** big text, generous space, few things per screen.
2. **Size = importance:** the one thing worth attention is the biggest thing.
3. **Color means one thing each:** every space owns one color everywhere; **amber only ever means "needs you"**; everything else is neutral.
4. **Pictures jog memory:** real page images, shown large.
5. **Ask, don't make you dig:** open on a question; search understands vague memories.
6. **No guilt counters:** no unread totals; small, finishable nudges.

Light and dark mode. The page also covers profile editing, tag management (pin, color, project status) and agent key management.

## 7. Errors

- A failed page fetch never blocks a save. It records `fetch_status` and retries later.
- A duplicate returns the existing link and its saved date.
- Errors are written for agents to act on, with a suggestion where possible.

## 8. Security

- **Login everywhere** except the login page.
- **Agent access:**
  - per-agent keys, revocable individually;
  - OAuth 2.1 for ChatGPT and Claude connectors, with **CIMD** (client metadata documents) preferred and dynamic client registration as a fallback, following the current MCP spec;
  - PKCE S256 and protected-resource metadata, as ChatGPT requires.
- **Owner scoping** is enforced in `store/` and covered by isolation tests through every door.
- **Safe fetching:** the fetcher refuses private, loopback and link-local addresses, including after redirects, so links cannot probe the home network.
- **Secrets** live in environment variables, never in the repo. Basic rate limiting.
- **Funnel stays off** until the login and isolation tests pass (phase 3). The phase-1b ChatGPT spike is the one exception (§10).

## 9. Testing and checks

- **`core/`:** fast unit tests against a fake store.
- **`store/`:** tests against real SQLite.
- **Isolation tests:** owner A can never read or change owner B's data through any door. Required before Funnel.
- **Door tests:** the same request through MCP, API and web returns the same core result.
- **`fetch/`:** tests against saved fixture pages, with no live network, including the private-address refusal.
- **`npm run check`** runs typecheck, lint and all tests. A pre-push hook runs it, and CI runs it on pull requests.

## 10. Phases

| Phase | Outcome |
|---|---|
| 0 · Setup | Private GitHub repo, MIT license, README, root AGENTS.md, ROADMAP.md, milestones, `check` script, hook, CI. |
| 1 · Save & find | Core, SQLite store, keyword search, MCP over the tailnet with agent keys. Claude Code and Codex can save, search and get links. |
| 1b · ChatGPT spike | A throwaway toy MCP server (no real data, one dummy write tool), briefly exposed via Funnel, then turned off. If ChatGPT requires OAuth even for this test, the spike moves to the start of phase 3. |
| 2 · Smart | Snapshots, meaning search, profile, focus log, digests. |
| 3 · Phone | Web login, OAuth, isolation tests, then Funnel on. ChatGPT and Claude apps connect. |
| 4 · Calm desk | The web page. The repo goes public afterwards. |
| Later | Import/export, dead-link checks, share sheet or bookmarklet, phone notifications, scheduled digests. |

The ChatGPT spike answers:

1. Can a developer-mode connector with a write tool be added in the owner's Business workspace?
2. Does that need a workspace admin?
3. Does it work in the ChatGPT phone app?
4. Does a no-auth connector allow write tools?

## 11. Unverified premises

These were checked against current docs on 2026-10-10 but are not settled. Each must be resolved by its check before the phase it blocks.

| Premise | Status | Check that settles it | Blocks |
|---|---|---|---|
| ChatGPT Business allows developer-mode connectors with write tools | Official page says yes for Business on web | ChatGPT spike | 3 |
| Business developer mode needs no admin, or the owner is the admin | Unknown | ChatGPT spike | 3 |
| ChatGPT custom connectors work in the mobile app | Unconfirmed | ChatGPT spike | 3 |
| Read-only tool annotations (`readOnlyHint`) suppress ChatGPT's write confirmation | Unverified | Apps SDK docs, then the spike | 1 |
| Claude connectors added on the web work in the Claude mobile app | Secondary source only | Test after phase 3 | 3 |
| MCP SDK v2 server has an `instructions` field | v1 had it; v2 not confirmed | Read the v2 types | 1 |
| better-auth MCP / OAuth / CIMD plugins are stable enough | Maturity not established | Docs and changelog review; spike in phase 3 | 3 |
| Claude routines and ChatGPT tasks can use custom connectors | Partly (routines documented; tasks unclear) | Test after phase 3 | Later |
| Codex cloud supports MCP | Not documented | Codex docs at the time | Not relied on |
| Each AI's own memory cannot be read by other apps | Assumed | Not load-bearing; design does not sync | None |
| sqlite-vec (pre-v1) stays usable | Pre-v1, "expect breaking changes" | Pin the version; it sits behind `search/` | 2 |
| Tailscale Funnel works on the always-on MacBook | Requires the open-source Tailscale variant on macOS; `*.ts.net` names only | Set up in phase 1b | 1b |

Connector auth settings cannot be changed after adding (Claude). Moving hosts later means re-adding connectors once.

## 12. Project documents

Each fact has one home:

- **`README.md`:** for visitors. What it is, why, setup, connecting each AI, license.
- **`AGENTS.md` (root):** mission, guiding principles, folder map, commands, and the session routine. At the start, read `ROADMAP.md` and the open issues for the current milestone. Before stopping, update both.
- **Folder `AGENTS.md`:** only where a folder has its own rules (e.g. `web/` design rules and colors, `mcp/` tool-description style). Kept short; updated in the same change that changes the rule.
- **`ROADMAP.md`:** goal, phases, current phase, decision log. The only living copy of phase status.
- **GitHub issues:** one per task, with a milestone per phase.
- **This spec:** the dated design record.

```
aye-ai-ai-links/
├─ README.md  AGENTS.md  ROADMAP.md  LICENSE
├─ docs/specs/  docs/design/
└─ src/
   ├─ core/  store/  search/  fetch/  auth/
   ├─ mcp/   api/    web/
   └─ server.ts
```

Tests sit next to code (`*.test.ts`).

## Sources (fetched 2026-10-10)

- Claude Code memory / AGENTS.md: https://code.claude.com/docs/en/memory
- Tailscale Funnel: https://tailscale.com/kb/1223/funnel
- ChatGPT developer mode: https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt
- ChatGPT connector auth: https://developers.openai.com/apps-sdk/build/auth
- Claude custom connectors: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude routines: https://code.claude.com/docs/en/routines
- MCP TypeScript SDK v2: https://github.com/modelcontextprotocol/typescript-sdk
- better-auth MCP plugin: https://www.better-auth.com/docs/plugins/mcp
- sqlite-vec JS: https://alexgarcia.xyz/sqlite-vec/js.html
- Hono JSX: https://hono.dev/docs/guides/jsx
