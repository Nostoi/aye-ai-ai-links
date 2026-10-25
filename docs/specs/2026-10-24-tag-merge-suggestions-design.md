# Suggested tag merges (#251)

Dated 2026-10-24. Builds on `2026-10-23-tag-rename-merge-delete-design.md` (#240).

## Why

AIs add one-off tags as links are saved, and near-duplicates appear: on the owner's library on 2026-10-24, `game art` (5 links), `Game Assets` (2) and `pixel-art` (2) sat beside `game development` (10). The owner asked for the app to suggest which tags belong together, then approve or reject each suggestion (#251). Since #240 an AI can be asked "are there tags I should merge?", and the Tags page can merge by hand; what's missing is the app noticing on its own.

The owner's own examples mix spelling twins and related tags (`game art`, `game assets`, `game development`), so a suggestion means "you might combine these", not "these are the same".

The owner skipped the design questions ("You can just start", 2026-10-24), so every choice below not quoted from them is the builder's call, listed at the end.

## What the owner sees

At the top of the Tags page, when there is at least one suggestion, a short section **Tags you might combine**. Each suggestion names two tags with their link counts and offers three buttons:

- **Keep {A}**: merges B into A through #240's merge, with its Undo bar.
- **Keep {B}**: merges A into B.
- **Not these**: the pair isn't suggested again. It shows the Undo bar, as every turning-off does on the site (`src/web/AGENTS.md`), and Undo brings the suggestion back.

The owner picks the tag to keep, as #240 ruled for merges. With no suggestions, the section is absent. The section shows at most 5 suggestions, the strongest first; once the owner acts on some, a reload shows the next ones.

A suggestion leaves the section as soon as either of its tags is merged, deleted or renamed on the page, or takes in another tag by a merge, since that can change whether the pair still qualifies. It is not brought back by an Undo until the page is reloaded.

## Which pairs are suggested

Only tags on at least one live link take part (merging an empty tag is just deleting it). A pair is suggested when either holds, and the owner hasn't said **Not these** to it:

1. **Spelling twins.** The names are equal once capitals and everything but letters and digits are dropped, or once a final `s` is dropped from one of them (`Java Script` · `JavaScript`, `pixel art` · `pixel-art`, `game asset` · `Game Assets`). Twins are suggested even when they share links, since an AI may put both on one link. They rank above every meaning pair.
2. **Close meaning, used apart.** The names' meaning similarity is at least **0.75**, and no live link carries both. A link that carries both was given both, so they are being used for different things.

Meaning similarity is the cosine of the two names' vectors from the app's meaning model (the one search uses, `bge-small-en-v1.5`), each name embedded **on its own** as a document (no query prefix). Embedding names together shifts the scores enough to move a pair across the line (`performance` · `Browser Performance`: 0.759 alone, 0.734 in a batch of 35), so the rule is defined on one name per embedding.

Observed on the owner's 33 tags, 2026-10-24 (spike, read-only, one name per embedding):

| Pair | Similarity | Links | Shared |
|---|---|---|---|
| Poetry · Literature | 0.816 | 1 · 1 | 1 |
| game art · Game Assets | 0.805 | 5 · 2 | 0 |
| game development · Game Assets | 0.761 | 10 · 2 | 0 |
| pixel-art · game art | 0.758 | 2 · 5 | 0 |
| game development · game art | 0.727 | 10 · 5 | 5 |
| WebGPU · Browser Performance | 0.721 | 1 · 1 | 1 |
| Game Boy · game art | 0.719 | 1 · 5 | 0 |

The rules leave exactly the three game-art pairs. The shared-link rule drops Poetry · Literature, which similarity alone ranks first. Similarity of the tags' links was also tried and rejected: it scores tags that sit on the same link at 1.0.

Related-but-different names can pass the bar (an independent probe found `Java` · `JavaScript` at 0.837, `machine learning` · `deep learning` at 0.813). That is accepted for a suggestion the owner approves or turns down; it is why the section says "might combine" and offers **Not these**. The threshold was set on 33 tags and is one named constant in core.

## Rules and where they live

- `src/core/tag-suggest.ts` holds the rule: twins, threshold, shared-link exclusion, dismissals, ordering (twins first, then similarity highest first, ties by the two names), the cap of 5. It depends on a name-vector interface and the tag store, never their implementations.
- A new store, `TagSuggestStore` (Sqlite and Fake under one contract), separate from `TagEditStore`, whose contract is edits and their Undo. Owner-scoped, it gives:
  - the pairs of tag keys that share a live link;
  - the owner's dismissed pairs, adding one, and removing one (for Undo).
- Dismissals are stored by tag **key**, the two keys sorted, in a new table `tag_merge_dismissals (owner_id, key_a, key_b, dismissed_at)`, primary key `(owner_id, key_a, key_b)`. Keys rather than ids because Undo of a merge or delete puts a tag back with a new id, and a key survives that. A renamed tag gets a new key and may be suggested again, which is right: its name changed. Accepted consequence: a dismissal follows the names, so a new tag that reuses a dismissed name inherits the dismissal. A row whose tags are gone stays and does no harm.
- Name vectors: a small cache over the `Embedder`, keyed by name and the model key, in memory for the life of the process. A Tags page view embeds only names it hasn't seen, and two views at once share one embedding of a name. It lives with the embedder in `src/search/` and is built in `createDeps`.
- **The page never waits long for it.** The Tags route waits at most 1.5 s for the suggestions; past that, or if embedding fails, the page shows without the section and the failure is logged. The embedding carries on and fills the cache, so the next view has it. The embedder is shared with search, one job at a time; a cold cache of N names is N small jobs queued once per process, and a search behind them already falls back to keyword results after its own wait.

## Doors

- **Web:** the Tags page route asks core for the suggestions and draws the section. **Keep** uses the existing `POST /tags/merge` and the page's existing merge, row hold, Undo bar and row handling. **Not these** posts to a new `POST /tags/suggestions/dismiss` (`{a, b}` keys); its Undo posts to `POST /tags/suggestions/undismiss`. Both join `CHECKED_PAGES` and the owner-isolation route map with a two-owner test.
- **MCP and Ask AI:** no change. An AI already finds merges with `list_tags` when asked. Dismissals are not shown to AIs.
- **README:** the Tags page entry mentions the suggestions. **ROADMAP:** a dated decision-log entry.

## Non-goals

- Suggesting deletion of one-link tags (18 of the 33 tags have one link; that would be mostly noise).
- Grouping the Tags page. ROADMAP's 2026-10-23 entry put it with #251; the issue itself asks only for suggestions, so grouping is left for its own issue.
- Suggesting during save, in the Ask AI panel, or by notification.
- An AI-connection version of the rule. It must work without one.
- A page listing past dismissals. Undo covers a mistaken press.
- Export of dismissals: they are page state, not library data.

## Builder's calls (owner skipped the questions)

1. Spelling twins always, plus close meaning (0.75, one name per embedding) for tags used apart, from the spike above.
2. Merge suggestions only, no delete suggestions; tags with no live links take no part.
3. Suggestions live on the Tags page only, at the top, at most 5, worded "Tags you might combine".
4. The owner picks the kept tag with one button per tag.
5. "Not these" is remembered by tag key, with an Undo bar and no list of past dismissals.
6. No MCP change; grouping the page is left out.
