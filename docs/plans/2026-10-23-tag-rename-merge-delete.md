# Rename, Merge and Delete a Tag: Implementation Plan (#240)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can rename, merge and delete a tag, on the Tags page and through any AI. Merge and delete have an hour-long Undo, and old space and search addresses keep working.

**Architecture:**
- **Undo is a receipt, not a hidden tag.** A merge or delete really repoints or removes the rows. It writes a per-owner receipt in `tag_changes` holding what Undo needs to put back. A hidden tag would need a filter on every tag reader (`listTags`, `TAG_SELECT`, `scope()`, `indexPage`, the FTS triggers), which is the delete-link problem again.
- **Old addresses** live in `tag_aliases`, which maps an old key to a tag id. A rename keeps the id, so chains resolve for free.
- **Rules live in `core/tag-edit.ts`**: the merge settings, the rename-onto-existing outcome, the Undo window and address resolution. The store applies what core decides, in one transaction per action.

**Tech stack:** TypeScript, Node 22, better-sqlite3, Hono, the MCP SDK, Vitest, Biome.

**Spec:** `docs/specs/2026-10-23-tag-rename-merge-delete-design.md`. Read it with this plan; it governs where they differ.

## Global constraints

- **Three PRs**, in order. Run `/personal-pr-readiness` before each PR's implementation. The owner waived the ~400-line ceiling.
  - PR 1 is Tasks 1–3: store and core, with nothing visible yet.
  - PR 2 is Tasks 4–6: the web.
  - PR 3 is Task 7: MCP.

  Each PR gets its own branch cut from `main`. PR 1 reuses `issue-240-tag-tidy`, which carries the spec and this plan.
- **`npm run check`** must pass before every push. For focused runs use `npx vitest run <file>`.
- **Undo window:** `TAG_UNDO_WINDOW_MS = 3_600_000`, in `src/core/tag-edit.ts`. It applies to the page and to AIs alike. The page's Undo bar keeps its own timing (`UNDO_BAR_MS`, `src/web/page.ts`).
- **Doors hold no rules.** Routes and tools call `core/tag-edit.ts` and translate its results only.
- **Owner scoping lives in `store/`.** Every new store method takes `owner`. An alias or receipt never resolves for another owner.
- **Hidden links.** A link in its delete-Undo window is rewritten by merge and delete like any other. Link counts count only links with `deleted_at IS NULL`.
- **Tests first.** Watch each new test fail for the intended reason before writing the code.
- **Migration:** append one SQL migration to `MIGRATIONS` in `src/store/migrations.ts`. It calls no app code. Confirm its number with `MIGRATIONS.length` (the live DB is at `user_version` 22).
- **New web POSTs** join `CHECKED_PAGES` (`src/app.ts`) and `WRITE_ROUTES_TESTED` (`src/mcp/isolation.test.ts`), each with a two-owner test. **New MCP tools** join `TOOLS_EXERCISED_ACROSS_TWO_OWNERS` in the same file.
- **Page rules** (`src/web/AGENTS.md`): render through `page()` and theme tokens; controls at least 44px tall; fields outlined with `--field`; no amber; Undo through `showUndo`, never a confirmation step.
- **README** is updated in the same PR as the change it describes.

## Review focus

Each line is pinned by a test in the task named.

1. **A link that has both tags when they merge** ends up with one copy of the kept tag. It keeps that tag's position and takes the stronger source. Undo gives it both tags back, each with its own source and position (Task 1).
2. **Undo after a later change.** Undo is refused and nothing is written when the kept tag's settings changed, when a link with the tag gained or lost a tag, or when a new tag now uses the old key, for example an AI saving with `banking` again (Task 1). A link deleted and purged meanwhile doesn't block Undo.
3. **A link in its delete-Undo window.** It is rewritten by the merge. After `unmarkDeleted` it shows the kept tag and is found by the kept name, and it is never counted while hidden (Tasks 1 and 2).
4. **Another owner** with a tag of the same key keeps its tag, links, aliases and counts. An alias of owner A never resolves for owner B (Tasks 1 and 4).
5. **An older link-edit Undo** (the edit dialog's or the Ask AI panel's) never brings back a tag that was merged away, renamed or deleted. It answers conflict (Task 2).

---

## PR 1: store and core

### Task 1: Migration, `TagEditStore` contract, SQLite and fake

**Files:**
- Modify: `src/store/migrations.ts`, appending one migration.
- Create: `src/core/tag-edit-store.ts` (interface and types) and `src/core/tag-edit-store-contract.ts` (shared contract, modelled on `link-edit-store-contract.ts`).
- Create: `src/store/sqlite-tag-edits.ts` and `src/store/sqlite-tag-edits.test.ts`, which runs the contract.
- Modify: `src/core/fake-store.ts`, so `FakeStore` implements `TagEditStore`.
- Create: `src/core/tag-edit-store.test.ts`, which runs the contract on `FakeStore`.
- Create: `src/store/tag-edits-migration.test.ts`, modelled on `put-away-migration.test.ts`.
- Modify: `src/core/tags.ts`, to export `cleanTagName` (today's private `cleanName`) and `strongerSource(a: Source, b: Source): Source`. `normalizeTags` uses `strongerSource`.
- Modify: `src/deps.ts`, adding `tagEdits: new SqliteTagEditStore(db)`.

**Interfaces:**
- Produces, in `src/core/tag-edit-store.ts`:
```ts
export type TagSettings = Pick<Tag, "kind" | "kindSource" | "color" | "pinned" | "description" | "projectStatus">;
export interface TagEditStore {
  /** Live (deleted_at IS NULL) links per tag key, every state. Keys with none are absent. */
  tagLinkCounts(owner: OwnerId): Promise<Map<string, number>>;
  /** Sets name and key. "taken" when another of the owner's tags has newKey. Adds alias oldKey→this tag when the key changes. Null when no tag has `key`. */
  renameTag(owner: OwnerId, key: string, name: string, newKey: string): Promise<Tag | "taken" | null>;
  mergeTag(owner: OwnerId, m: { from: Tag; into: Tag; set: TagSettings; at: Date; pruneBefore: Date }):
    Promise<{ tag: Tag; changeId: string; links: number } | "conflict" | null>;
  deleteTag(owner: OwnerId, d: { tag: Tag; at: Date; pruneBefore: Date }):
    Promise<{ changeId: string; links: number } | "conflict" | null>;
  /** Null when no receipt with this id at or after `since`. On "undone", the receipt is removed. */
  undoTagChange(owner: OwnerId, changeId: string, since: Date):
    Promise<{ tags: Tag[] } | "conflict" | null>;
  /** The live key an old key now reaches: a live tag with `key` wins, then an alias. Null for neither. */
  currentKey(owner: OwnerId, key: string): Promise<string | null>;
}
```

**Schema** (one migration):
- `tag_aliases(owner_id TEXT NOT NULL, old_key TEXT NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (owner_id, old_key), FOREIGN KEY (owner_id, tag_id) REFERENCES tags(owner_id, id) ON DELETE CASCADE)`.
- `tag_changes(owner_id TEXT NOT NULL REFERENCES users(id), change_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('merge','delete')), at INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY (owner_id, change_id))`.
- `receipt` is JSON holding:
  - the removed tag (every `Tag` field);
  - the old keys that reached it;
  - for a merge, the kept tag's key and its settings before and after;
  - per affected link: its id, and its ordered `{key, source, position}` before and after.

**Store mechanics** (each action is one `.immediate()` transaction):
- **Expected values.** `mergeTag` and `deleteTag` first check that the stored rows equal the `from`, `into` or `tag` they were given, every field. Any difference is `"conflict"`, writing nothing. A missing tag is `null`.
- **Merge, link with only the old tag:** `UPDATE link_tags SET tag_id = <into>`. Position is kept, and the `link_search_lt_upd` trigger refreshes keyword search.
- **Merge, link with both tags:** delete the old row. Set the kept row's source to `strongerSource` of the two. Don't compact positions.
- **Merge, aliases:** repoint the old tag's aliases to the kept id, add alias `from.key → into`, delete the `from` row, and write `set` onto `into`.
- **Delete:** remove every `link_tags` row of the tag, hidden links included (the FK has no `ON DELETE`). Then delete the tag. Its aliases cascade, and the receipt keeps them.
- **Pruning.** Both actions first run `DELETE FROM tag_changes WHERE at < pruneBefore`, for this owner only.
- **Undo** writes nothing and answers `"conflict"` when any of these hold:
  - a live tag now has the removed key;
  - for a merge, the kept tag (by its key at merge time) is missing or its settings differ from "after";
  - any receipt link that still exists has ordered tags (key, source) that differ from "after".

  Links gone from `links` are skipped. Otherwise Undo:
  - re-inserts the removed tag with its settings (a new id is fine);
  - repoints its recorded aliases to it, and drops the merge's `from.key` alias;
  - restores the kept tag's settings;
  - restores each existing link's rows exactly, with key, source and position;
  - deletes the receipt;
  - returns the restored tags (`[removed, kept]` for a merge, `[removed]` for a delete).

- [ ] **Step 1: Write the failing migration test.** After migrating, both tables exist with the keys above. Deleting a tag cascades its aliases, and `user_version` equals `MIGRATIONS.length`.
- [ ] **Step 2: Write the failing contract** in `tag-edit-store-contract.ts`, with these tests:
  - `tagLinkCounts counts live links only` (hidden link not counted; another owner's not counted);
  - `renameTag changes key and name, and the old key reaches it` (`currentKey(owner, "pixel-art") === "pixel art"`);
  - `renameTag of capitals only keeps the key and adds no alias`;
  - `renameTag onto another tag's key is "taken" and writes nothing`;
  - `renamed links are found by the new name` (through `FtsSearch` in the SQLite suite only, and a changed `indexPage` tags array);
  - `mergeTag moves every link, including a hidden one`;
  - `mergeTag on a link with both keeps one, at the kept position, with the stronger source`, Review focus 1;
  - `mergeTag repoints aliases`, so chains resolve: rename a→b, merge b into c, then `currentKey("a") === "c"`;
  - `mergeTag refuses when from or into changed` (`"conflict"`, rows unchanged);
  - `deleteTag removes it from every link and from the catalog`;
  - `undo restores a merge exactly`: every field of both tags, each link's ordered key, source and position, and the aliases;
  - `undo restores a delete exactly`;
  - `undo is refused after a later change`, Review focus 2, one case per bullet above;
  - `undo skips a purged link`;
  - `undo after the window is null`;
  - `undo twice: second is null`;
  - `another owner's same-key tag, links and aliases are untouched by every method`, Review focus 4;
  - `currentKey prefers a live tag over an alias`.
- [ ] **Step 3: Run** `npx vitest run src/store/sqlite-tag-edits.test.ts src/core/tag-edit-store.test.ts src/store/tag-edits-migration.test.ts`. They should FAIL because the module is missing.
- [ ] **Step 4: Implement** the migration, `SqliteTagEditStore`, the `FakeStore` methods, and the `tags.ts` exports.
- [ ] **Step 5: Run** the same command. It should PASS, and `npx vitest run src/core/tags.test.ts` still passes.
- [ ] **Step 6: Commit** with `feat: tag aliases and tag change receipts in store (#240)`.

### Task 2: A link-edit Undo never brings back a removed tag

**Files:**
- Modify: `src/store/link-edit-receipts.ts` (`restoreCovered`, or its caller in `undoEdit`), the `FakeStore` twin (`undoEdit`), and the receipt path of `updateWithReceipt` if it restores through the same code.
- Test: `src/core/link-edit-store-contract.ts`.

- [ ] **Step 1: Write the failing contract tests:**
  - `undo answers conflict when a prior tag is no longer in the catalog`. Set up: the link has tags A and B, an edit sets the tags to [B], then A is deleted through `tagEdits.deleteTag`. `undoEdit` answers `"conflict"`. The catalog still has no A, and the link's tags are still [B].
  - The same test for A merged into C, and for A renamed to D.
- [ ] **Step 2: Run** `npx vitest run src/core/link-edit-store.test.ts src/store/sqlite-link-edits.test.ts`. It should FAIL, because A is recreated.
- [ ] **Step 3: Implement.** Before restoring, if any `prior_tags` key is not a live tag of the owner's, answer `"conflict"` and write nothing. Before this feature no tag ever left the catalog, so no existing Undo changes.
- [ ] **Step 4: Run** the same command plus `npx vitest run src/web/edit-routes.test.ts`. It should PASS.
- [ ] **Step 5: Commit** with `fix: link edit Undo never recreates a removed tag (#240)`.

### Task 3: Core rules in `src/core/tag-edit.ts`

**Interfaces:**
- Consumes: `TagEditStore` (Task 1); `LinkStore.listTags`; `tagKey`, `cleanTagName` (`tags.ts`).
- Produces:
```ts
export const TAG_UNDO_WINDOW_MS = 3_600_000;
type TagEditDeps = { store: LinkStore; tagEdits: TagEditStore; now: () => Date };
export function mergedSettings(from: Tag, into: Tag): TagSettings;
export async function listTagsWithCounts(deps, owner): Promise<{ tag: Tag; links: number }[]>;
export async function renameTag(deps, owner, i: { name: string; newName: string }): Promise<{ renamed: Tag } | { taken: Tag; links: number }>;
export async function mergeTags(deps, owner, i: { name: string; into: string }): Promise<{ tag: Tag; changeId: string; links: number }>;
export async function deleteTag(deps, owner, i: { name: string }): Promise<{ changeId: string; links: number }>;
export async function undoTagChange(deps, owner, changeId: string): Promise<Tag[]>;
export async function tagAddress(deps, owner, name: string): Promise<string | null>; // currentKey of tagKey(name)
```

**Rules:**
- **`mergedSettings`** (spec, "Merge"):
  - `pinned` is `from.pinned || into.pinned`.
  - `color` is `into.color ?? from.color`.
  - `description` is `into.description ?? from.description`.
  - Kind, kindSource and projectStatus come from `into`. The exception is when `into.kind === "topic"` and `from` is a project whose `kindSource` is `"stated"` or `"asked"`. Then they come from `from`.
- **Errors** are `CoreError`.
  - `not_found` when a named tag is missing.
  - `invalid_input` when merging a tag into itself, or when a name is blank (`cleanTagName`).
  - A store `"conflict"` triggers one fresh read and a retry (the `changeTagKind` pattern), then `conflict`.
  - For Undo, `null` is `not_found` with "It's too late to undo: that change can no longer be undone.", and `"conflict"` is `conflict` with "The tags changed since, so nothing was undone."
- `undoTagChange` passes `since = now - TAG_UNDO_WINDOW_MS`. `mergeTags` and `deleteTag` pass `pruneBefore` set the same way.

- [ ] **Step 1: Write failing tests** in `src/core/tag-edit.test.ts`, on `FakeStore`:
  - `mergedSettings` table cases:
    - from pinned, into not: pinned, with into's colour, or from's when into has none;
    - into a topic, from a stated project that is done: project, done, stated;
    - into a topic, from an inferred project: stays a topic;
    - two projects: into's status;
    - descriptions.
  - `renameTag` returns `taken` with the other tag and its live count.
  - `mergeTags` of a tag into itself is `invalid_input`.
  - A missing tag is `not_found`.
  - `undoTagChange` after `now` passes the window is `not_found` with the exact text above.
  - A conflict retried once then reported.
  - `tagAddress("Pixel-Art")` after a rename gives the new key.
- [ ] **Step 2: Run** `npx vitest run src/core/tag-edit.test.ts`. It should FAIL because the module is missing.
- [ ] **Step 3: Implement** `src/core/tag-edit.ts`.
- [ ] **Step 4: Run** it again, and it should PASS. Then run `npm run check`.
- [ ] **Step 5: ROADMAP.** Add a dated decision-log entry, 2026-10-23, recording the owner's rulings from the spec. The entry also notes that #251 is split out and follows #240.
- [ ] **Step 6: Commit** with `feat: core rules for renaming, merging and deleting a tag (#240)`, then open PR 1.

---

## PR 2: the web

### Task 4: Routes and old addresses

**Files:**
- Modify: `src/web/http.ts`, `src/app.ts` (`CHECKED_PAGES`) and `src/mcp/isolation.test.ts` (`WRITE_ROUTES_TESTED`).
- Test: `src/web/tags-routes.test.ts` (two-owner tests) and `src/web/space-routes.test.ts` (or wherever `/spaces` and `/search` routes are tested).

**Routes** (each POST takes JSON and answers with `NO_STORE`):
- `POST /tags/rename {key, name}` → 200 `{tag}`, or 409 `{code: "taken", tag, links, message}`.
- `POST /tags/merge {key, into}` → 200 `{tag, changeId, links}`.
- `POST /tags/delete {key}` → 200 `{changeId, links}`.
- `POST /tags/undo {changeId}` → 200 `{tags}`. The page re-draws from it.
- **Error mapping.** Reuse `tagAction`'s `not_found` and `conflict` mapping. Undo's `not_found` and `conflict` carry core's own words, as `removalAction` does.

**Old addresses:**
- `GET /spaces` and `/spaces/done` (in `openSpace`'s `not_found` branch): when `tagAddress` finds a current key, answer 303 to `spaceHref(current, …)`, keeping `done`, `order` and `before`.
- `GET /search?tag=` does the same, keeping every other query parameter.
- `backTarget`'s `ownedTag` and `within` resolve through `tagAddress` too.
- Unknown keys behave as today.

- [ ] **Step 1: Write failing tests:**
  - Each POST: a two-owner test where B's request for A's key is 404 and A's rows are unchanged. A's success shape matches the routes above.
  - `rename onto an existing name is 409 taken and nothing changes`.
  - `undo after a merge puts both rows back`.
  - `old space address redirects to the renamed tag` and `… to the kept tag after a merge`. Owner B's request for A's old key is 404.
  - `old search address keeps its other parameters`.
- [ ] **Step 2: Run** `npx vitest run src/web/tags-routes.test.ts src/mcp/isolation.test.ts` and the space route test. They should FAIL.
- [ ] **Step 3: Implement** the routes and the redirects.
- [ ] **Step 4: Run** them again. They should PASS.
- [ ] **Step 5: Commit** with `feat: tag rename, merge, delete and undo routes; old addresses redirect (#240)`.

### Task 5: Tags page controls (mockup A)

**Files:**
- Modify: `src/web/tags-page.ts`; `src/web/theme.ts` if new classes need styles; the `GET /tags` route, to pass `listTagsWithCounts`; and the `src/web/__ask_off__/tags-*.html` snapshots.
- Test: `src/web/tags-page.test.ts`.

**What the page does** (mockup https://claude.ai/artifact/9xJEBh6tg9T2uiHejyK1Vy, option A):
- **Each row** shows the count after the kind: "Topic · 5 links", or "1 link".
- **The Edit panel** opens with a **Name** field (`--field` outline) and a **Rename** button. Kind, Status and Color follow, then a line. Under the line are the quiet buttons **Merge into another tag…** and **Delete tag**.
- **Rename** posts `/tags/rename`. On 200 the row takes the returned tag: `data-key`, the name, the link `href` (`spaceHref`) and the panel ids. `act()` currently refuses a reply whose key differs from the row's; rename is the one action that may change the key.
- **Rename on 409 `taken`** shows, inside the panel: "You already have a tag called {name} ({links} links). Merge {old} into it?", with **Merge into {name}** (filled) and **Keep {old}** (quiet). Keep closes the message and changes nothing.
- **Merge into another tag…** opens, in the panel:
  - "Merge {name} into…" with a line saying its N links move to the tag picked and {name} goes away;
  - a filter field;
  - the owner's other tags, each a button with its count;
  - **Merge into {picked}** (filled, disabled until a pick) and **Cancel**.
- **After a merge**, the row is removed and the kept row is drawn from the returned tag and count. `showUndo` says "Merged {from} into {into} ({n} links)."
- **After a delete**, the row is removed. `showUndo` says "Deleted {name} from {n} links.", or "from 1 link".
- **Undo** posts `/tags/undo`. On 200 it re-inserts the removed row where it was and draws both rows from `tags`. On an error the page's alert shows the server's message.
- **One action at a time per row.** The button is disabled while its request is out, as today.

- [ ] **Step 1: Write failing tests:**
  - The page renders the counts.
  - The Name field and Rename button sit at the top of the Edit panel, and Merge and Delete come after Color.
  - Every control is a button at least 44px tall in the theme.
  - The page script contains no confirmation call. Assert the script source has no `confirm(`.
- [ ] **Step 2: Run** `npx vitest run src/web/tags-page.test.ts`. It should FAIL.
- [ ] **Step 3: Implement**, and update the `__ask_off__` snapshots.
- [ ] **Step 4: Run** it again. It should PASS. Then run `npm run check`.
- [ ] **Step 5: Browser check** at desktop width and at 390px:
  - rename `pixel-art` to `pixel art`, then back;
  - rename onto `game art`, then Keep;
  - merge, then Undo;
  - delete, then Undo.

  Use a local server with a copy of test data, never the live DB. Stop it by PID.
- [ ] **Step 6: Commit** with `feat: rename, merge and delete on the Tags page (#240)`.

### Task 6: README for PR 2

- [ ] **Step 1:** Update `README.md`'s Tags section: rename, merge and delete with Undo, the link counts, and old addresses keeping working. Run `npx vitest run src/readme.test.ts`, which should PASS.
- [ ] **Step 2: Commit** with `docs: README for renaming, merging and deleting tags (#240)`, then open PR 2.

---

## PR 3: MCP

### Task 7: Tools and guidance

**Files:**
- Modify: `src/mcp/server.ts`, `src/mcp/guidance.ts`, `src/mcp/output-schemas.ts`, `src/mcp/changes.ts` and `src/mcp/isolation.test.ts` (`TOOLS_EXERCISED_ACROSS_TWO_OWNERS`).
- Modify: `README.md`'s tool list.
- Test: `src/mcp/tag-tools.test.ts` (new) and `src/mcp/isolation.test.ts`.

**Tools:**
- `list_tags` (read-only): every tag with `links`. This is how an agent answers "are there tags I should merge?".
- `update_tag` gains an optional `newName`, which renames through `renameTag`. `kind` becomes optional, and at least one of the two is required. A `taken` result is an error that names the existing tag and tells the agent to ask the owner, then call `merge_tags`.
- `merge_tags {name, into}` → `{tag, links, undoId}`.
- `delete_tag {name}` → `{links, undoId}`.
- `undo_tag_change {undoId}` → `{tags}`. The `undoId` comes back in the tool's own result for every caller. The external door passes no `recorder`, so the link-edit receipt pattern can't be reused.
- **Changes record.** Each write records `{ kind: "tag", … }`. Extend the `Change` union for merge and delete, so the Ask AI panel's line names what happened and links to `/tags`.

**Guidance** (house style of `guidance.ts`):
- `MERGE_TAGS`, `DELETE_TAG` and `update_tag`'s rename: use them only when the owner asks, or confirms a merge you proposed, never on your own. Say what changed and that it can be undone for an hour.
- `undo_tag_change`: after the hour it's too late. Offer to reverse by hand instead (rename back, or re-add the tag with `update_link`).
- **Merge suggestions after a save.** Add a paragraph to `SAVE_LINK` and the server instructions. After saving, if a tag you used or one in `filingContext` is a near-duplicate of another, mention it once and offer the merge. Near-duplicates are the same meaning with different spelling, hyphens, case or plural. Don't mention tags that only overlap in topic.

- [ ] **Step 1: Write failing tests:**
  - Each new tool, two owners: B can't list, rename, merge, delete or undo A's tags, and A's rows are unchanged.
  - `update_tag` with `newName` onto an existing tag is an error naming it.
  - A `merge_tags` then `undo_tag_change` round trip with the returned `undoId`, in a fresh MCP session (a new `buildMcpServer`), proves the id survives across sessions.
  - `tools/list` matches `TOOLS_EXERCISED_ACROSS_TWO_OWNERS`.
- [ ] **Step 2: Run** `npx vitest run src/mcp/tag-tools.test.ts src/mcp/isolation.test.ts src/readme.test.ts`. They should FAIL.
- [ ] **Step 3: Implement** the tools, the guidance and the README.
- [ ] **Step 4: Run** them again, and they should PASS. Then run `npm run check`.
- [ ] **Step 5: Commit** with `feat: rename, merge, delete and undo tags through MCP (#240)`, then open PR 3.

## Accepted, not changed

- **Stats readings.** The AI's stats reading is dated prose and can name an old tag for up to 7 days, until its next pass. Say so in PR 1's body.
- **Search history.** `search_log` keeps old tag keys, which are history only and never read back.
- **Export.** The export reads the live catalog. Aliases and receipts aren't exported, and the export version stays 3.
- **MCP tag filters** with an old name still return nothing, as an unknown tag does today. Old-address resolution is for web addresses (spec).
