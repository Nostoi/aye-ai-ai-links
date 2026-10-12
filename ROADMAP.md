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

- **2026-10-11:** Snapshot store (#30, first of three pull requests: store and migration).
  - **Interface.** Snapshots have their own `SnapshotStore` in `core/`, like `ProfileStore`, rather than more methods on `LinkStore`. `SqliteStore` and `FakeStore` implement both. `dueSnapshots` is the one cross-owner read.
  - **Claim lease.** `leaseSnapshot` sets `next_fetch_at` to the lease end and returns `{url, attempts, claim}`, where the claim is that end time in milliseconds. `recordSnapshot` writes only while `next_fetch_at` still equals the claim, so a job that outlived its lease writes nothing once the snapshot has been leased again, and a finished snapshot cannot be written twice.
  - **Search text.** A separate `snapshot_search` index, with its own triggers on `snapshots`, holds the page's own title and description plus its extracted text (owner ruling, Q4). `link_search` is unchanged. Keyword search lists owner-field matches first, in their existing order, then links matched only by page text, so page length never lowers the owner's own matches. Existing links get a `pending` snapshot.
  - **Links.** `Link.snapshot` carries status and page fields, never the text; `getSnapshotText` reads it. `NewLink` omits `snapshot`, and saving a link creates its `pending` snapshot in the same transaction.

- **2026-10-11:** Change a tag's kind (#23). This supersedes the MCP door (#5) entry's "will come" line.
  - **Tool.** `update_tag {name, kind}` changes an existing tag between topic and project and returns `{tag}`. It never creates a tag. The description tells agents to use it only when the owner says so. Hints, wording and sources: `docs/specs/2026-10-11-update-tag-sources.md`.
  - **Rule.** It lives in `core/tag-kind.ts`, so phase 4's web tag management (#12) can call it. Names match like all tags (ignoring case and extra spaces), and the tag keeps its first casing.
  - **Project status.** Any change of kind clears "done". Changing a project to a topic and back therefore reopens it; the tool has no status argument, and the description says so. Asking for the kind a tag already has changes nothing. Setting or reopening status is #12's, and it must go through a core rule that refuses a status on a topic.
  - **Races.** The store writes only while the kind is still the one core read (`updateTag(owner, key, patch, expectedKind)`). If it moved, core reads once more and applies the rule again; a second miss is a `conflict` error.
  - **Freshness.** Calls that start after `update_tag` returns see the new kind. A search that ranked its results before the change can still return the old kind, the limit already accepted in the keyword search (#4) entry.
  - **No migration.** The `tags` columns already existed. There is still no source stored for a tag's kind, so a kind set by an inferred `save_link` mention is not labelled as a guess; that is an owner decision, not made here.
- **2026-10-11:** Tailnet service (#7).
  - **Shape.** A per-user LaunchAgent (`com.aye-links`) runs `dist/server.js` on `127.0.0.1:3002`, and `tailscale serve --https=8444` publishes it on the tailnet. It runs while the account is logged in; sleep settings are the owner's.
  - **Deploys.** `deploy/deploy.sh <ref>` builds and tests each commit in `~/.aye-links/releases/<sha>`. Only on success does it stop the service, back up the database, switch the `~/.aye-links/current` symlink and bootstrap the plist again. A failed build leaves the running install untouched. The key CLI runs from `current`, so one build serves both.
  - **Rate limit.** 120 requests a minute per identified caller (`owner/agent`); a request without a valid key is not limited and always gets 401. It runs inside the `/mcp` mount, after the Host and Origin checks and after the key check, so an exhausted bucket never hides a 403, and failed key guesses cannot use up an agent's allowance. Over the limit gets 429 with `Retry-After` and JSON-RPC code -32000. MCP 2026-07-28 `schema.ts` ("MCP error codes") leaves -32000 to -32019 to implementations and keeps -32002 reserved for resource not found. The SDK uses -32000 for its own HTTP rejections.
  - **Shutdown.** On SIGTERM or SIGINT the server stops accepting connections, waits up to 10 s for in-flight requests, then closes the MCP handler and the database. The plist's `ExitTimeOut` is 20 s.
  - **Unverified until the real-client check:** the `Origin` that Claude Code and Codex send, and whether both accept the stateless 2025 serving.

- **2026-10-11:** Agent keys (#6).
  - **Keys.** A key is `aak_` plus 32 random bytes. Only its SHA-256 digest is stored (migration 3, `agent_keys`), and each owner and agent has one live key.
  - **Each request looks its key up again**, so a revoked key is refused from the next request that starts after the revocation.
  - **Where the code lives.** Key storage is in `store/key-store.ts`, owner-scoped except for the lookup by hash. Generation, hashing and bearer parsing are in `auth/`.
  - **Owner record.** Creating a key creates its owner. The default owner id is `owner`, and phase 3's login must link the logged-in user to it, or the existing links won't show (#11).
  - **The CLI** (`npm run keys -- create|list|revoke`) runs from a `tsc` build in `dist/`. A failed build writes nothing.
  - **Older builds lock out.** After migration 3, older builds refuse the database, so the server and the CLI are deployed from one build (#7).
  - **MCP authorization.** Static keys depart from the MCP authorization spec's SHOULD for HTTP servers. Phase 3 decides whether agent keys become OAuth tokens or stay a separate path.

- **2026-10-11:** MCP door (#5).
  - **`save_link` returns the owner's existing tags and active projects**, so agents reuse tags (owner). A project counts as active unless it is marked done.
  - **Agents can create projects (owner).** A tag input may say `kind: project`. It applies only when the tag is new; an existing tag keeps its kind, and the returned link shows the kind the tag actually has. Changing an existing tag's kind will come in two places (owner): phase 4's web tag management and an agent tool (#23).
  - When one save names a tag twice, the kind comes from the mention with the strongest source, or the first mention on a tie. This keeps a guessed project from being recorded as stated.
  - **`save_link` has no `note` field (owner).** The agent turns what the owner said into a `stated` why, which changes spec §5.
  - **Spec §11 checks:**
    - MCP SDK v2 servers do have an `instructions` field (`@modelcontextprotocol/server` 2.3.1).
    - OpenAI's MCP guide says ChatGPT respects `readOnlyHint` and treats tools without it as writes needing confirmation. Behaviour in the app is still for the phase 1b spike.
  - **MCP decisions rest on the current documentation (owner).** Each one is cited in `docs/specs/2026-10-11-mcp-door-sources.md`:
    - The server speaks the 2026-07-28 revision, and also the 2025 handshake that Codex still sends.
    - It validates Origin.
    - Every tool sets all four hints.
    - Claude Code and Codex use a per-agent bearer key. That deliberately departs from the spec's SHOULD for OAuth until phase 3.
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
