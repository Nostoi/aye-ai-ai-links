# AGENTS.md

Instructions for any AI agent (Claude Code, Codex, ChatGPT, others) working on this repository.

## Mission

Aye-AI-AI Links is a personal link library that AI assistants run for you. Save a link by telling any AI about it; find it later by describing it vaguely; get nudged back to links that matter to what you're doing now. A calm, visual web page shows everything.

The design of record is `docs/specs/2026-10-10-aye-ai-ai-links-design.md`.

## Session routine

**At the start of every session:**

1. Read `ROADMAP.md`. It names the current phase and the decisions made since the spec.
2. List the open issues for the current phase's milestone:
   `gh issue list -R Nostoi/aye-ai-ai-links --milestone "<current milestone>"`
3. Pick up the issue in progress, or the next one. If GitHub is unreachable, say so and work from `ROADMAP.md` alone.

**During the session**, keep the issue you're working on current: tick its checklist, comment on decisions and blockers.

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
- **Doors hold no rules.** `mcp/`, `api/` and `web/` only translate requests. Every rule (dedupe, why labelling, digest selection) lives once in `core/`.
- **Core depends on interfaces.** `core/` uses `store/`, `search/` and `fetch/` through interfaces, never their implementations.
- **Owner scoping lives in `store/`.** Every data call takes the owner; no door can skip it.
- **The calling agent does the AI work.** The server never calls an AI model API and needs no API keys.
- **Label guesses.** Anything an agent inferred (a why, a tag, a profile note) is stored with its source and shown as a guess.
- **Safe fetching.** The page fetcher refuses private, loopback and link-local addresses, including after redirects.
- **No Funnel before auth.** The real app is not exposed publicly until login and owner-isolation tests pass (phase 3). See `ROADMAP.md` for the one dated exception.
- **Tests discriminate.** A test must fail when the behaviour it protects breaks. Write it red first.
- **Small, focused files** with one clear purpose each.

## Folder map

Folders marked *(planned)* don't exist yet; create them in the phase that needs them.

```
aye-ai-ai-links/
├─ AGENTS.md  README.md  ROADMAP.md  LICENSE
├─ docs/
│  ├─ specs/      dated design records
│  └─ design/     approved visual references (layout A only)
├─ .githooks/     pre-push runs `npm run check`
├─ .github/       CI: `npm run check` on pull requests
└─ src/ (planned)
   ├─ core/       rules and use cases
   ├─ store/      SQLite persistence (swappable)
   ├─ search/     keyword + meaning search
   ├─ fetch/      page snapshots
   ├─ auth/       sessions, agent keys, OAuth
   ├─ mcp/        AI connector door
   ├─ api/        JSON API door
   ├─ web/        web page door
   └─ server.ts
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

- **Branch per issue**, pull request into `main`, and `npm run check` passing before push.
- **Folder `AGENTS.md` files** are added only when a folder has rules that don't apply elsewhere (e.g. `src/web/` design rules, `src/mcp/` tool-description style). Keep them short. Update them in the same change that changes the rule.
- **AGENTS.md only.** Do not add `CLAUDE.md` or `CLAUDE.local.md` anywhere in the repo. Claude Code reads `AGENTS.md` only when no `CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or above it (Claude Code v2.1.277+). To confirm, an interactive session shows a line such as `no CLAUDE.md found; AGENTS.md loaded: <path>`. A `CLAUDE.md` in a folder above the clone also blocks it.
- **Secrets** go in `.env` (git-ignored), never in the repo.
