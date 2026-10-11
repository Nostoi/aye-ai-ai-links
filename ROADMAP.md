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

- **2026-10-11:** MCP door (#5).
  - **`save_link` returns the owner's existing tags and active projects**, so agents reuse tags (owner). A project counts as active unless it is marked done.
  - **Agents can create projects (owner).** A tag input may say `kind: project`. It applies only when the tag is new; an existing tag keeps its kind, and the returned link shows the kind the tag actually has. Changing an existing tag's kind will come in two places (owner): phase 4's web tag management and an agent tool (#23).
  - When one save names a tag twice, the kind comes from the mention with the strongest source, or the first mention on a tie. This keeps a guessed project from being recorded as stated.
  - **`save_link` has no `note` field (owner).** The agent turns what the owner said into a `stated` why, which changes spec §5.
  - **Spec §11 checks:**
    - MCP SDK v2 servers do have an `instructions` field (`@modelcontextprotocol/server` 2.3.1).
    - OpenAI's MCP guide says ChatGPT respects `readOnlyHint` and treats tools without it as writes needing confirmation. Behaviour in the app is still for the phase 1b spike.
- **2026-10-11:** Keyword search (#4). An FTS5 table (`link_search`) over title, summary, why and tag names, kept current by database triggers inside the store's own transactions. Search words are OR-ed and ranked with bm25, so a half-wrong memory still finds links. Archived links are included in results. Stated limits: all owners share one index, so another owner's links can change the order of yours but never which links you get back (revisit before multi-user hosting, phase 3); results are current links, so a link edited after ranking can come back with text that no longer matches; with stemming, prefixes match stems (`runn` finds nothing, `run` and `running` do), which phase 4's search-as-you-type must revisit.
- **2026-10-11:** SQLite store (#3). Plain SQL on better-sqlite3, with migrations tracked by `PRAGMA user_version`. Link and tag ids are integers, shown as decimal strings; dates are stored as epoch milliseconds. The tag catalog is per owner, and link–tag rows carry composite foreign keys so they cannot cross owners. Owners are created by `SqliteStore.ensureUser`, outside `LinkStore`. Profile-notes and focus-log tables wait for phase 2 (owner). PR B landed at ~600 lines, over the ceiling, so that its tests stay with the code (owner).
- **2026-10-10:** Duplicate links (owner, #2). Two URLs are the same link after ignoring scheme/host case, default port, tracking parameters, trailing slashes and `#` anchors; `#/` and `#!` app routes, query order, http vs https and `www.` still count. URLs with credentials are refused. Saving an existing link returns it unchanged, except that a why is filled in if the link has none. Details: #2.
- **2026-10-10:** Tags (#2). Tag names match ignoring case and extra spaces; a tag keeps the casing it was first saved with. When one save names a tag twice, the stronger source wins (stated, then asked, then inferred). Blank tag names are refused.
- **2026-10-10:** Ruleset "main: require green CI" requires the `check` status on `main`, with no bypass. This supersedes the next entry's note that a direct push to `main` skipping the hook goes unchecked.
- **2026-10-10:** Phase 0 tooling is npm, TypeScript strict, Biome, Vitest, and a native git hook via `core.hooksPath`. CI runs `npm run check` on pull requests only, so a direct push to `main` that skips the hook goes unchecked; work goes through pull requests.
- **2026-10-10:** The ~400-line pull request ceiling is waived for the phase 0 pull request (owner).
- **2026-10-10:** The phase 1b ChatGPT spike may briefly expose a **throwaway toy server** (no real data, one dummy write tool) through Funnel, then turn Funnel off. This is the only exception to "no Funnel before auth", which still applies in full to the real app (spec §8, §10).
- **2026-10-10:** The owner is the admin of the ChatGPT Business workspace, so developer mode can be enabled.
- **2026-10-10:** Repo is private until phase 4 is done, then public.
- **2026-10-10:** Spec approved by the owner; phase 0 started.
