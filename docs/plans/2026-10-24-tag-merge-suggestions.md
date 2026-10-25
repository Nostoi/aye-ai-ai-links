# Suggested Tag Merges: Implementation Plan (#251)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Tags page suggests pairs of tags the owner might combine. The owner keeps one with a button (an ordinary #240 merge, with Undo) or turns the pair down with **Not these** (with Undo).

**Spec:** `docs/specs/2026-10-24-tag-merge-suggestions-design.md`. Read it with this plan; it governs where they differ.

**Tech stack:** TypeScript, Node 22, better-sqlite3, Hono, Vitest, Biome.

## Global constraints

- **One PR** on branch `issue-251-tag-suggest`, which carries the spec and this plan.
- **`npm run check`** must pass before every push. For focused runs use `npx vitest run <file>`.
- **Tests first.** Watch each new test fail for the intended reason before writing the code.
- **Doors hold no rules.** The route calls core and translates its result. The 1.5 s wait is the route's (it is about the page, not the rule).
- **Core depends on interfaces.** `tag-suggest.ts` imports the `TagSuggestStore` and `NameVectors` interfaces, never Sqlite or the model.
- **Owner scoping lives in `store/`.** Every new store method takes `owner`.
- **Migration:** append one SQL migration to `MIGRATIONS` in `src/store/migrations.ts`; confirm its number with `MIGRATIONS.length` (the live DB is at `user_version` 23).
- **New web POSTs** join `CHECKED_PAGES` (`src/app.ts`) and `WRITE_ROUTES_TESTED` (`src/mcp/isolation.test.ts`), each with a two-owner test.
- **Page rules** (`src/web/AGENTS.md`): render through `page()` and theme tokens; controls at least 44px tall; no amber; Undo through `showUndo`, never a confirmation step; a row takes one action at a time.
- **Every page embeds the theme CSS**, so a CSS change rewrites the `src/web/__ask_off__/` snapshots: regenerate them with `npx vitest run src/web/ask-off-bytes.test.ts -u` and check the diff is only your CSS.
- **README** (Tags page entry) and a dated **ROADMAP** decision-log entry land in this PR.

## Review focus

1. **Twins share links and are still suggested; meaning pairs that share a live link are not** (Task 2).
2. **Dismissal follows keys:** it survives merge Undo and delete Undo of either tag; a rename to a new key ends it; owner B's identical keys are untouched (Tasks 1 and 2).
3. **The page never hangs:** an embedding that never settles leaves the Tags page rendered without the section within the wait (Task 3).
4. **No stale suggestion on the page:** after Keep, every suggestion naming either tag leaves the section (Task 3).

---

### Task 1: Migration, `TagSuggestStore`, SQLite and fake

**Files:**
- Modify `src/store/migrations.ts`: append
  ```sql
  CREATE TABLE tag_merge_dismissals (
    owner_id TEXT NOT NULL REFERENCES users(id),
    key_a TEXT NOT NULL,
    key_b TEXT NOT NULL,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, key_a, key_b),
    CHECK (key_a < key_b)
  );
  ```
- Create `src/core/tag-suggest-store.ts`:
  ```ts
  export interface TagSuggestStore {
    /** Pairs of the owner's tag keys that are both on at least one live (deleted_at IS NULL) link, each as [a, b] with a < b. */
    sharedPairs(owner: OwnerId): Promise<[string, string][]>;
    /** The owner's dismissed pairs, each [a, b] with a < b. */
    dismissedPairs(owner: OwnerId): Promise<[string, string][]>;
    /** Records a dismissal; the keys may come in either order. Repeating it is harmless. */
    dismissPair(owner: OwnerId, a: string, b: string, at: Date): Promise<void>;
    /** Removes a dismissal, keys in either order. Removing a missing one is harmless. */
    undismissPair(owner: OwnerId, a: string, b: string): Promise<void>;
  }
  ```
- Create `src/core/tag-suggest-store-contract.ts` (modelled on `tag-edit-store-contract.ts`), run by `src/store/sqlite-tag-suggest.test.ts` and `src/core/tag-suggest-store.test.ts`.
- Create `src/store/sqlite-tag-suggest.ts`; `FakeStore` (`src/core/fake-store.ts`) implements the interface over its own tag and link state.
- Create `src/store/tag-suggest-migration.test.ts` (modelled on `tag-edits-migration.test.ts`).
- Modify `src/deps.ts`: `tagSuggest: new SqliteTagSuggestStore(db)`.

**Contract must pin:** a hidden (deleted, in its Undo window) link doesn't make a pair shared; owner B's links and dismissals never show for owner A; a key pair is stored sorted whichever order it arrives in; dismiss twice and undismiss a missing pair don't throw; a dismissal of `a`/`b` survives `mergeTag` + `undoTagChange` of either (Sqlite test, using `SqliteTagEditStore`).

### Task 2: Name vectors and the core rule

**Files:**
- Create `src/core/tag-suggest.ts`:
  - `export interface NameVectors { vectorOf(name: string): Promise<Float32Array> }`.
  - `export const MERGE_SUGGEST_MIN = 0.75` with a one-line comment pointing at the spec's table.
  - `export const MERGE_SUGGEST_MAX = 5`.
  - `export function spellingTwins(a: string, b: string): boolean`: lowercase, drop everything but letters and digits (Unicode-aware), then equal, or equal once a final `s` is dropped from one.
  - `export async function suggestTagMerges(deps: { store: LinkStore; tagEdits: TagEditStore; tagSuggest: TagSuggestStore; names: NameVectors }, owner): Promise<{ a: { tag: Tag; links: number }; b: { tag: Tag; links: number } }[]>`: tags from `listTagsWithCounts`, only those with links > 0; twins first (shared links allowed); then pairs with cosine ≥ `MERGE_SUGGEST_MIN` that aren't shared; minus dismissed; ordered twins, then score high to low, ties by the two names; first `MERGE_SUGGEST_MAX`. Within a pair, `a` is the tag with more links (ties by name).
- Create `src/core/tag-suggest.test.ts` with `FakeStore` and a stub `NameVectors` returning chosen unit vectors (so scores are exact): threshold edges (0.7499 out, 0.75 in), shared-link exclusion, twins despite sharing, zero-link tags excluded, dismissed excluded in either key order, ordering and cap, owner B's tags never paired with A's.
- Create `src/search/name-vectors.ts`: `createNameVectors(embedder: Embedder): NameVectors`. One name per `embedDocuments([name])` call; a `Map<string, Promise<Float32Array>>` cache so concurrent asks share one embedding; a rejected promise is dropped from the cache so a later view retries. Test in `src/search/name-vectors.test.ts` with a counting fake embedder (one call per name, shared while pending, retried after a rejection, one name per call).
- Modify `src/deps.ts`: `names: createNameVectors(embedder)` (the same embedder as search).

### Task 3: The Tags page

**Files:** `src/web/http.ts`, `src/web/tags-page.ts`, `src/web/theme.ts`, `src/app.ts`, `src/mcp/isolation.test.ts`, the Tags route and page tests, `README.md`, `ROADMAP.md`, regenerated `src/web/__ask_off__/` snapshots.

- **GET /tags:** races `suggestTagMerges` against a 1.5 s timer (a named constant). On timeout or rejection, log one line (`[tags] suggestions skipped: …`) and render with none. Do not cancel the embedding; it fills the cache. Test: a `NameVectors` stub that never resolves still gets a 200 Tags page without the section, within the wait (use a short injected wait or fake timers, following how other route tests shorten waits).
- **POST /tags/suggestions/dismiss** and **/tags/suggestions/undismiss**, body `{ a: string, b: string }` (keys), answer 204. Core gets `dismissTagPair` / `undismissTagPair` in `tag-suggest.ts` that pass through `tagKey` of each name. Both join `CHECKED_PAGES` and `WRITE_ROUTES_TESTED` with a two-owner test (B's dismissal of the same keys leaves A's suggestion showing).
- **The section** (`tags-page.ts`), above the list, only when there are suggestions: heading **Tags you might combine**; each suggestion a row with both names and counts ("game art · 5 links and Game Assets · 2 links") and three buttons **Keep {a}**, **Keep {b}**, **Not these**. Keep runs the page's existing `merge(row, into)` for the two tag rows (looked up with `rowFor`), under the same row hold, and shows its Undo bar. Not these posts dismiss, removes the suggestion, and shows the Undo bar ("Won't suggest {a} and {b} again."), whose Undo posts undismiss and puts the suggestion back where it was.
- **Stale suggestions:** whenever a row is merged away, merged into, deleted or renamed on the page (by a suggestion or by the Edit panel), every suggestion naming that tag's key leaves the section; the section hides when empty. Hook this where `sync()` already runs. An Undo doesn't bring a suggestion back.
- Theme CSS for the section uses existing tokens; buttons at least 44px; neutral, no amber.
- README: one sentence in the Tags page entry. ROADMAP: a dated decision-log entry for #251 (rule, Tags page only, grouping left out).
