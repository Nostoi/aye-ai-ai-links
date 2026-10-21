# A space works like All links: implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** a space page (`/spaces?tag=…`) works like All links (#214): a calm header without the colour block, the three sort orders, List / Pictures, a Search this space button, and a clearer Out of your lists. One PR.

**Mockup (governs):** artifact `3RLVGiDJG7dcsSU6qM9iL2`, section "4 · A space works like All links": SpaceDesktop, SpacePhone, SpaceDoneDesktop, SpaceDoneEmptyPhone.

## Grounding

What it enables: today a space lists newest first only (`spacePage` heads it with a fixed "Newest first"), so a space's oldest or recently opened links are reachable only by paging; a space cannot be searched from the web at all (`/search` reads only `q` and `keep`, `src/web/http.ts` `app.get("/search"…)`).

- OBSERVED: `linkPage` (`src/core/link-pages.ts`) takes `SearchFilters`, where `tagKey` and `order` are independent fields, and its cursors are per order. MCP `list_links` already sends both together (`src/core/list-links.ts`). `openSpace` (`src/core/spaces.ts`) calls `linkPage` with `tagKey` and `state` but no `order`.
- OBSERVED: `searchLinks` (`src/core/search-links.ts`) takes `tag` and normalizes it with `tagKey`; blank query with a filter lists newest first.
- OBSERVED: the Tags page opens a tag's edit panel only through its Edit button (`toggleEdit`, `src/web/tags-page.ts`); rows carry `data-key`.
- OBSERVED: `.band*` classes are used only by `space-page.ts`, `space-page.test.ts` and `spaces-routes.test.ts` (grep of `src/`).
- OBSERVED: ask-off snapshots `space-empty`, `space-with-links`, `space-done`, `search-*` are rendered in `src/web/ask-off-bytes.test.ts` and update with `vitest -u`.

## Open questions, settled

1. **Does the space query support oldest and recently opened?** Yes. `linkPage` already combines `tagKey` with any `order`; `openSpace` only needs to pass `order` through. No store or search change.
2. **What Search this space shows when nothing in the space matches:** the heading names the space (its dot and name, "in <space>"), then "Nothing in <space> matched." and one link, **Search all your links**, which runs the same words without the space. No second search is run to count matches elsewhere. A blank Search this space lists the space's newest links ("Your newest links in <space>"). Search in a space finds links out of your lists too, as search everywhere does.

## Decisions

- **Out of your lists for a space has no sort**, as the mockup draws it: newest first only. Its "Out of your lists" link from the space drops the order; Back to <space> is the plain space address.
- **The phone sort is a `<select>`** on the space page only (≤600px; the buttons show above that). Changing it goes to that order's address. All links keeps its buttons on phones (deferred, ROADMAP 2026-10-20); noted as a follow-up, not done here.
- **Change** links to `/tags#tag=<encoded key>`. The Tags page script, on load, opens the edit panel of the row whose `data-key` matches and scrolls it into view. An unknown key does nothing.
- **An unknown `tag` on `/search`** gets the space-missing 404 (`spaceMissingPage`), as `/spaces` does, rather than silently searching everything. A blank `tag=` is no tag.
- The tag lookup (`name` → the owner's `Tag`) is one core function, `findSpaceTag(catalog, name)` in `src/core/spaces.ts`; `openSpace` and the search door both use it.
- The sort choices (names and the desktop buttons) move from `all-page.ts` into one shared web helper so All links and the space page draw them from one place; All links' bytes don't change.

## Tasks

### 1. Sort orders on a space
- [ ] `openSpace` takes `order?: LinkOrder` and passes it to `linkPage`. Core test: a space lists oldest first and recently opened (only opened links), and a cursor from one order is refused by another.
- [ ] `spaceHref(key, { done, before, order })`: `order` set only when not newest. The route reads `checkedOrder(c.req.query("order"))` (400 page for a bad one, as All links). A gone cursor restarts at the same order.
- [ ] Empty and Show older text per order, as All links: later page "No older links." (newest) / "No more links."; opened and empty: "Nothing in this space opened yet. Links you open from this site show here."; Show older reads "Show more links" for non-newest.
- [ ] Shared helper (e.g. `src/web/link-orders.ts`): `ORDER_NAMES`, the `nav.orders` buttons, and the phone `<select>` with its visually-hidden label and a tiny script block. All links uses the nav from it, byte-identical (snapshot unchanged).

### 2. The header and tools row
- [ ] Replace `.band*` with a plain header: h1 (dot in the space colour + name) and a quiet **Change** link beside it; the description under it when set; the kind line only for a project (`kindLine` without the topic case). No `.band-color`.
- [ ] Tools: desktop sort buttons under the name; on the right List / Pictures and **Search this space** (`/search?tag=<key>`, pill like `.search-instead`). Phone: name + Change; select + switch on one row; Search this space full width. Bottom "Out of your lists" link stays.
- [ ] Theme: drop `.band*` rules; add the new ones from tokens only; 44px targets.
- [ ] Tags page: open the panel from `#tag=<key>` on load.

### 3. Out of your lists for a space
- [ ] No space header. Top: **Back to <space>** with a chevron and the space dot, then h1 **Out of your lists** with List / Pictures beside it.
- [ ] Empty first page: no switch; a card with **Nothing here is out of your lists yet.** and "Links you mark stale or put away from this space wait here. Search still finds them."

### 4. Search this space
- [ ] `/search` reads `tag`; resolves it with `findSpaceTag` (404 `spaceMissingPage` when unknown); passes `tag` to `searchLinks`. The form carries a hidden `tag`. Heading names the space; empty result per "Open questions" 2; "Not it?" keeps "your newest links" in the space and adds Search all your links.
- [ ] Route tests: results limited to the space; another owner's tag name gets the 404 and no marker; `keep=1` and `tag` together both carry through the form.

### 5. Docs
- [ ] README "Your spaces" paragraph: sort orders, Search this space, Change. ROADMAP decision-log entry with the two settled questions and the decisions above. `src/web/AGENTS.md` only if a rule changes.
- [ ] Regenerate ask-off snapshots; review the diff of each changed snapshot.

## Verification
- `npm run check`. Browser check at desktop and 390px of a space, its sort, Search this space with and without results, and an empty Out of your lists.
