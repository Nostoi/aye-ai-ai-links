# Rename, merge and delete a tag (#240)

Owner conversation, 2026-10-23. Mockups: https://claude.ai/artifact/9xJEBh6tg9T2uiHejyK1Vy (private to the owner); the owner chose **A**, the controls inside each tag's Edit panel. App-made merge suggestions are a separate issue, #251, which builds on this one.

## Why

The owner opened the Tags page and saw that it "will be growing infinitely as links are added", and that some tags "may need to be consolidated at some point". The owner wants the app to suggest merges eventually (#251), and also wants to do it by hand. Approving a suggestion will run this work's merge.

On 2026-10-23 the live library had 32 tags on 46 links, and 19 of those tags were on one link. Most one-link tags were added by an AI (`banking`, `crm`, `monitoring`, `webgpu`). Some groups overlap: `game development` (6 links), `game art` (5), `game assets` (2) and `pixel-art` (2); `3d modeling` and `blender`. Two names use hyphens where every other tag uses spaces: `pixel-art` and `token-grounding-prototype`.

Nothing can do these changes today. `updateTag` patches pin, colour, kind and status only (`src/core/store.ts`), and the Tags page (`src/web/tags-page.ts`) only edits those.

## Goals

- **Rename** a tag. Every link with it shows the new name. Keyword search and meaning search find those links by the new name, and stop finding them by the old one.
- **Merge** one tag into another.
- **Delete** a tag, which takes it off every link.
- **Undo** for merge and delete, for **one hour**, from the page and from an AI alike (owner, 2026-10-23). This is longer than a link delete's 60 seconds (`LINK_UNDO_WINDOW_MS`, `src/core/link-removal.ts`), so that "undo that" still works later in an AI conversation. The page's Undo bar still closes after its usual few seconds. Nothing asks "Are you sure?" first (`src/web/AGENTS.md`: "Removing or turning something off shows an Undo bar instead of asking first").
- **Through an AI too.** In Claude, ChatGPT or the Ask AI panel the owner can say "merge game art into game development" or "are there tags I should merge?". After saving a link, the AI mentions a merge only when there really is a strong candidate.
- Each tag on the Tags page shows **how many links have it** (controller's call: it makes the one-link tags stand out, which is what the owner is tidying; it isn't a guilt counter).

## Non-goals

- The app doesn't suggest merges, and the Tags page isn't grouped or sorted differently. Both are #251.
- No bulk actions (merging three tags in one step, or deleting every one-link tag).
- No confirmation dialog before merge or delete.
- No new page. Everything happens on the existing Tags page.

## Anti-goals

- A merge or delete that loses something the owner set up. That means a pin, a colour, a kind the owner chose, or a link's tag, and it applies after Undo as well. Undo must put things back exactly as they were.
- An AI that renames, merges or deletes tags on its own.
- Search that still finds links by a tag name they no longer have, or misses them by the new one.
- Another owner's tags or links touched in any way.

## How each action behaves (owner rulings)

### Rename
- The owner types a new name in the Edit panel's Name field and presses Rename.
- If the new name belongs to **another** tag (the same key under `tagKey`, `src/core/tags.ts`), the app says so and offers to merge into it: "You already have a tag called game art (5 links). Merge pixel-art into it?", with **Merge into game art** and **Keep pixel-art**. Keep changes nothing.
- A change that only affects capitals or spacing (`game art` to `Game Art`) is the same key, so it renames in place (controller's call).
- Rename has no Undo bar: renaming back is the undo (controller's call, since nothing is removed).
- **Old addresses keep working** (controller's call, accepted by the owner). A bookmarked `/spaces?tag=<old key>` or `/search?tag=<old key>` reaches the renamed tag. The same holds for a tag merged away, whose old address reaches the kept tag. The address of a deleted tag shows what an unknown tag shows today.

### Merge
- The owner opens Edit on the tag that goes away, presses **Merge into another tag…**, and picks the tag to keep. The pick list filters as they type and shows each tag's link count. The button names the result ("Merge into game development"). See the mockup.
- Every link with the old tag gets the kept tag, and the old tag is removed.
- **Pin:** the kept tag is pinned if either tag was.
- **Colour:** the kept tag keeps its own colour, or takes the other tag's if it had none.
- **Kind and status:** the kept tag's kind wins. The exception is when the kept tag is a topic and the old tag was a project the owner marked (`kindSource` stated or asked). Then the kept tag becomes that project, with the old tag's status and `kindSource`.
- **Description:** the kept tag keeps its own, or takes the other tag's if it had none (controller's call; no page or tool shows a tag's description today).
- **Two projects:** the kept tag's status wins, and the old project's status is dropped (controller's call, following "the kept tag's kind wins"). Undo brings it back.
- **A link that had both tags** keeps one copy of the kept tag. It takes the more certain source of the two, stated over asked over inferred (controller's call, accepted by the owner). It stays at the kept tag's position in that link's tag order.
- **Undo** restores the old tag with all its settings, and puts it back on exactly the links that had it, with their sources and positions. It returns the kept tag's pin, colour, kind, status and kindSource to what they were. It takes the kept tag off any link that only got it through the merge. Links that already had both tags go back to having both.

- **Old addresses resolve through chains.** If A is renamed to B and B is then renamed to C, `?tag=a` reaches C. A live tag always wins over an old address with the same key. Undoing a merge removes the old address the merge created. (Controller's calls.)

### Undo, for merge and delete
- **Undo never overwrites a later change** (controller's call). If anything Undo would put back has changed since, such as either tag's settings or links gaining or losing either tag, Undo is refused with a plain message and changes nothing. The page's other refusals work the same way, for example the Edit dialog's 409 when a link's tags changed meanwhile (#239).
- **Links hidden by a delete-Undo** are handled exactly like visible links. Their tag rows are rewritten by the action and restored by Undo.
- The receipt lives on the server for the window, so an Undo works from a later request or chat turn. It doesn't depend on the page or the session that made the change.

### Delete
- Deleting a project tag is allowed like any other.
- **Delete tag** sits at the bottom of the Edit panel next to Merge. It removes the tag from every link and removes the tag. A pinned tag's space disappears from Home.
- **Undo** puts back the tag with all its settings, on the same links, with the same sources and positions.

### Through an AI
- Agents get rename, merge and delete through MCP. Ask AI gets them too, because the in-app chat uses the MCP tools in process (`src/ai/tool-session.ts`).
- An agent changes tags **only when the owner asks or confirms**, never on its own (controller's call, accepted by the owner). This follows the rule `edit_profile` already has.
- **Undo covers an agent's merge and delete** (owner accepted). An agent must be able to reverse its own merge or delete within the hour when the owner says "undo that". After the hour, the tool says it's too late, and the agent can offer to do the reverse by hand, such as renaming back or re-adding the tag to the links it names.
- **Merge suggestions from an agent.** When the owner asks, the agent looks at the tags and proposes merges. After `save_link` it mentions a merge only when there really is a strong candidate: a near-duplicate of a tag it just used, never a loose topical overlap. It asks before merging. All of this is tool-description guidance. The server makes no suggestions here (that is #251).
- An agent needs to see every tag with its link count without saving a link. Today the tags come only in `save_link`'s `filingContext`.

## Constraints

- Every rule lives once in `core/`: which settings survive a merge, the rename-onto-existing check, and the address an old key reaches. The Tags page routes and the MCP tools only translate (AGENTS.md, "Doors hold no rules").
- **Owner-scoped and atomic.** Each action is one transaction in `store/`, taking the owner. A failure part-way writes nothing. Tests cover another owner's same-named tag and links being left untouched, red first.
- **Search follows.** A tag's name is in the keyword index, and it reaches the index through the `link_search_*` triggers on `tags` and `link_tags`. It is also in each link's meaning-search document (`linkDocument`, `src/core/link-document.ts`), which `vector-indexer.ts` re-embeds whenever the document's hash changes. Tests show that after a rename or merge, keyword search finds the links by the new name and not the old one. They also show that each affected link's document changes, so its vector is rebuilt.
- **Deleted (hidden) links.** A link in its delete-Undo window still has its tag rows. Rename, merge and delete must keep it consistent, so that when the link is restored it has the renamed or kept tag, or no tag after a delete (`docs/specs/2026-10-19-delete-link-design.md`).
- Every place that stores a tag key or name, beyond `tags` and `link_tags`, is checked and named in the PR. Examples are the AI edit receipts (`link_edits` prior and written tags) and the stats log. Where a stored key would now point nowhere, the builder settles it and says how.
- New web POSTs join `CHECKED_PAGES` in `src/app.ts` and the route guard in `src/mcp/isolation.test.ts` (`src/web/AGENTS.md`, "New routes"). New MCP tools or fields follow `src/mcp/` description style. Controls are at least 44px, and the Undo bar is `page()`'s `showUndo`.
- README updates in the same PR (new tag actions, and the new or changed MCP tools). ROADMAP gets a dated decision-log entry recording these rulings.

## Left to the builder

- How old addresses are stored (for example, a table mapping an old key to its tag), and how long they last.
- How Undo is stored: a tag hidden for the window and then purged, or a receipt of what changed. Either way, Undo is exact and expires after the hour.
- The MCP shape. Options include a rename field on `update_tag`, new `merge_tags`/`delete_tag` tools, a `list_tags` tool or tag counts in an existing result, and how an agent passes an undo. Keep the tool count reasonable.
- Whether this lands as one PR or several (for example, core and store, then web, then MCP). Each PR must leave the app working and honest.
