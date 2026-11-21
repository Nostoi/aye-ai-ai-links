# Your why in Edit link, tags in Save (#351, #352)

Dated 2026-11-20. Owner rulings are on #351 and #352; the approved mockup is `docs/design/why-and-tags-mockup.html` (E1, G1, S1).

## Why

On the web page the owner can't correct or remove a reason once a link has one (#351), and can't tag a link while saving it, so every web save needs a second trip through Edit link (#352). Since #342 an AI may change the owner's why only with the owner's say-so, so the web page should be a direct way to do it.

## Goals

- **#351:** Edit link gets a "Why you saved it" box under Title (E1). It opens on the link's why. A guessed why is filled in, labelled "(a guess)", with the hint "An AI guessed this. Change it to make it yours." (G1). Changed words are saved as the owner's (`stated`); an untouched box sends nothing, so a guess stays a guess. An emptied box removes the why. The dialog's one Undo puts it back.
- **#352:** the Save dialog gets an optional Tags field under the why (S1), Edit link's tag picker (suggestions from `/tags/names`, Enter adds, x removes, Save adds what's left in the box). Tags are `stated`. A new link is saved with them. A repeat save adds the tags the link doesn't have yet; tags it had stay, and the dialog's note names what was added and what it already had.

## Non-goals

- No why field in Save beyond today's; no tag removal from Save.
- No change to how an AI's writes are guarded (#342) or to Tell me why.
- Ask AI's "Updated." line for a blocked write stays as it is.

## Approach

One sensible way for each, because both dialogs already have the seam:

- **#351** extends the edit seam the way #339 added intent: `EditInput` gains `why: { text, seen }`, where `seen` is the why the dialog opened with (text and source, or none). Core cleans it (blank removes) and the store writes it in the edit's one transaction only while the link still holds `seen`; otherwise a conflict with its own message, nothing written, as tags and intent do. The edit receipt already covers the why, so Undo needs no new state. The dialog sends `why` only when the box's text differs from what it opened with.
  - Rejected: writing the why through `updateLink`/`tellWhy` beside the edit. It would split one Save into two writes with two Undos and no stale check.
- **#352** extends `savePage`: it takes `tags`, passes them to `saveLink` for a new link, and for a repeat save adds the missing ones in one store write that leaves existing tags and their sources alone. It reports which were added so the note can name them. The Save dialog reuses the Edit dialog's picker script rather than a copy.
  - Rejected: Option B (ignore tags on a repeat save) and C (hide Tags when already saved): the owner chose adding them.

## PR boundary

Two PRs, #351 first, then #352: each ships and reverts alone, and #352 touches the shared picker script that #351 does not.

## Constraints

- Every new signed-in POST stays covered by `CHECKED_PAGES` and the route guard (`src/mcp/isolation.test.ts`); `/save` keeps no `ask`, as any site can open it.
- Controls at least 44px; errors in the dialog's `role=alert`; no amber.
- README updates in the same PR as each change.

## Left to the builder

- The exact store method shape for adding tags on a repeat save, and the conflict message wording for a changed why (match `TAGS_CONFLICT`'s style).
- How the picker script is shared between the two dialogs.
