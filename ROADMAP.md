# Roadmap

**Goal:** save links by talking to any AI, find them again from a vague memory, get nudged back to the ones that matter now, and see them on a calm, visual page. Full design: `docs/specs/2026-10-10-aye-ai-ai-links-design.md`.

**Current phase:** Phase 1 · Save & find

Tasks live in GitHub issues under each phase's milestone: https://github.com/Nostoi/aye-ai-ai-links/milestones

## Phases

| Phase | Outcome | Status |
|---|---|---|
| Phase 0 · Setup | Repo, README, AGENTS.md, this roadmap, `npm run check`, pre-push hook, CI | done |
| Phase 1 · Save & find | Core, SQLite store, keyword search, MCP over the tailnet with agent keys. Claude Code and Codex can save, search and get links | not started |
| Phase 1b · ChatGPT spike | Throwaway toy MCP server answers: can ChatGPT Business add a write-tool connector, does it work on mobile, does no-auth allow writes, do read-only annotations skip confirmation | not started |
| Phase 2 · Smart | Page snapshots, meaning search, profile, focus log, digests | not started |
| Phase 3 · Phone | Web login, OAuth (CIMD, DCR fallback), owner-isolation tests, then Tailscale Funnel on. ChatGPT and Claude apps connect | not started |
| Phase 4 · Calm desk | The web page (layout A). Repo goes public afterwards | not started |
| Later | Import/export, dead-link checks, share sheet or bookmarklet, notifications, scheduled digests | — |

## Decision log

Newest first. Each entry is dated; later entries override earlier ones and the spec.

- **2026-10-10:** Duplicate links (owner, #2). Two URLs are the same link after ignoring scheme/host case, default port, tracking parameters, trailing slashes and `#` anchors; `#/` and `#!` app routes, query order, http vs https and `www.` still count. URLs with credentials are refused. Saving an existing link returns it unchanged, except that a why is filled in if the link has none. Details: #2.
- **2026-10-10:** Phase 0 tooling is npm, TypeScript strict, Biome, Vitest, and a native git hook via `core.hooksPath`. CI runs `npm run check` on pull requests only, so a direct push to `main` that skips the hook goes unchecked; work goes through pull requests.
- **2026-10-10:** The ~400-line pull request ceiling is waived for the phase 0 pull request (owner).
- **2026-10-10:** The phase 1b ChatGPT spike may briefly expose a **throwaway toy server** (no real data, one dummy write tool) through Funnel, then turn Funnel off. This is the only exception to "no Funnel before auth", which still applies in full to the real app (spec §8, §10).
- **2026-10-10:** The owner is the admin of the ChatGPT Business workspace, so developer mode can be enabled.
- **2026-10-10:** Repo is private until phase 4 is done, then public.
- **2026-10-10:** Spec approved by the owner; phase 0 started.
