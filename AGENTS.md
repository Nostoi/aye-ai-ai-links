# AGENTS.md

Instructions for any AI agent (Claude Code, Codex, ChatGPT, others) working on this repository.

## Mission

Aye-AI-AI Links is a personal link library that AI assistants run for you. Save a link by telling any AI about it; find it later by describing it vaguely; get nudged back to links that matter to what you're doing now. A calm, visual web page shows everything.

The design of record is `docs/specs/2026-10-10-aye-ai-ai-links-design.md`.

## Session routine

**At the start of every session:**

1. Read `ROADMAP.md`. It names the current phase and the decisions made since the spec.
2. Run `gh api "repos/Nostoi/aye-ai-ai-links/milestones?state=all" --jq '.[] | "\(.number) | \(.title) | open \(.open_issues) | closed \(.closed_issues)"'` and find the line whose title is exactly `ROADMAP.md`'s current phase. None: `ROADMAP.md` is wrong; fix it from this list.
3. Open 0, closed >0: phase done. Advance `ROADMAP.md`'s phase and phase table, add a dated decision-log entry, repeat from step 2. Open 0, closed 0: no tasks filed; split its headline into issues or ask the owner.
4. Else run `gh api "repos/Nostoi/aye-ai-ai-links/issues?milestone=<number>&state=open&sort=created&direction=asc" --jq '.[] | select(.pull_request == null) | "#\(.number) \(.title) | assignees: \([.assignees[].login] | join(","))"'` (`<number>` is that line's first field) and work the owner-named issue, else the assigned one, else the lowest-numbered unblocked unassigned one and assign it (`gh api -X POST repos/Nostoi/aye-ai-ai-links/issues/<n>/assignees -f 'assignees[]=Nostoi'`). One session at a time unless the owner assigns parallel sessions their issues. If GitHub is unreachable, say so and work from `ROADMAP.md` alone.

**During the session**, keep the issue you're working on current: tick its checklist, comment on decisions and blockers. Use only `gh api` (REST) for GitHub, never `gh issue` or `gh pr`: they use GraphQL, which cloud sessions block with a 403.

**Before stopping:**

1. Update the issue: what changed, what's left, what's blocked.
2. If a phase finished or a decision was made, update `ROADMAP.md` in the same branch as the work.
3. If `ROADMAP.md` and the issues disagree, the newer dated entry wins; fix the stale one and say so.

## Where each fact lives

| Fact | Home |
|---|---|
| Goal, phases, current phase, decision log | `ROADMAP.md` |
| Tasks and their progress | GitHub issues, one milestone per phase |
| Working rules, folder map, commands | this file |
| Rules that apply to one folder only | that folder's `AGENTS.md` |
| Design rationale (dated, not updated) | `docs/specs/` |
| What the project is, for visitors | `README.md` |

Write a fact in its home and link to it from elsewhere; don't copy it.

## Guiding principles

- **Simplest thing that fully works.** No speculative features, layers or settings. Each phase ships something usable.
- **Doors hold no rules.** `mcp/`, `api/` and `web/` only translate requests. Every rule (dedupe, why labelling, digest selection) lives once in `core/`. The exception is rules about who may call and as whom: the web login, agent keys, app connections and their tokens (admission, consent, disconnect, the OAuth error text) and the recorded `savedBy`. They belong in `auth/`. A new signed-in web POST must be added to `CHECKED_PAGES` in `src/app.ts`, which refuses requests from other sites.
- **Core depends on interfaces.** `core/` uses `store/`, `search/` and `fetch/` through interfaces, never their implementations.
- **Owner scoping lives in `store/`.** Every data call takes the owner; no door can skip it.
- **The calling agent does the AI work.** The server never calls an AI model API and needs no API keys.
- **Label guesses.** Anything an agent inferred (a why, a tag, a profile note) is stored with its source and shown as a guess. A tag's kind is the exception: only an inferred project is shown as a guess, since every tag starts as a topic (`ROADMAP.md`, 2026-10-14).
- **Safe fetching.** The page fetcher refuses private, loopback and link-local addresses, including after redirects.
- **Nothing public before auth.** The real app is not exposed to the internet until login and owner-isolation tests pass (phase 3). See `ROADMAP.md` for the one dated exception.
- **Tests discriminate.** A test must fail when the behaviour it protects breaks. Write it red first.
- **Small, focused files** with one clear purpose each.

## Folder map

Folders marked *(planned)* don't exist yet; create them in the phase that needs them, and drop the mark.

```
aye-ai-ai-links/
├─ AGENTS.md  README.md  ROADMAP.md  LICENSE
├─ docs/
│  ├─ specs/      dated design records
│  └─ design/     approved visual references (layout A only)
├─ .githooks/     pre-push runs `npm run check`
├─ .github/       CI: `npm run check` on pull requests
├─ deploy/        LaunchAgent plist and `deploy.sh`
└─ src/
   ├─ core/       rules and use cases
   ├─ store/      SQLite persistence (swappable)
   ├─ search/     keyword + meaning search
   ├─ fetch/      page snapshots and preview images, through one guarded request (has its own `AGENTS.md`)
   ├─ auth/       agent keys, the caller identity, the web login and OAuth: better-auth, its lock, routes and client admission
   ├─ http/       request rate limiting and the request log
   ├─ cli/        the `keys` command for agent keys, the `owner` command for the web login, and the model prefetch
   ├─ mcp/        AI connector door
   ├─ api/        JSON API door (planned)
   ├─ web/        web page door: login, home (the search question, its picks and your spaces), search results, space pages, stored images, tags, the profile, apps and agent keys, and the OAuth error page
   ├─ app.ts          mounts every door on one HTTP app
   ├─ deps.ts         builds store, search, images and profile on one database
   ├─ config.ts       reads the server's `AYE_` settings
   ├─ start-server.ts opens both databases, runs the auth migrations, starts the server and snapshot runner
   └─ server.ts       process entry point: signals and shutdown
```

Tests sit next to the code they test: `foo.ts` → `foo.test.ts`.

## Commands

Use Node 22 (`nvm use` reads `.nvmrc`).

| Command | What it does |
|---|---|
| `npm install` | Install dev tools and enable the git hook |
| `npm run check` | Typecheck, lint and test; the same command runs before push and in CI |
| `npm test` | Tests only |
| `npm run format` | Apply Biome formatting and safe fixes |

## Working rules

- **Branch per issue**, pull request into `main`, and `npm run check` passing before push. Merge only when CI is green.
- **Folder `AGENTS.md` files** are added only when a folder has rules that don't apply elsewhere (e.g. `src/web/` design rules, `src/mcp/` tool-description style). Keep them short. Update them in the same change that changes the rule.
- **AGENTS.md only.** Do not add `CLAUDE.md` or `CLAUDE.local.md` anywhere in the repo. Claude Code reads `AGENTS.md` only when no `CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or above it (Claude Code v2.1.277+). To confirm, an interactive session shows a line such as `no CLAUDE.md found; AGENTS.md loaded: <path>`. A `CLAUDE.md` in a folder above the clone also blocks it.
- **README in the same PR.** A PR that changes what a user can do, how they set it up or connect an AI, or moves a feature out of "Still to come", updates `README.md` in the same PR. `src/readme.test.ts` catches a missing tool, an `AYE_` setting read in `src/`, or a `src/` folder or top-level `src/*.ts` file the folder map gets wrong (a new one updates the map in the same PR); the rest is on the PR author and its reviewers.
- **Secrets** go in `.env` (git-ignored), never in the repo.
