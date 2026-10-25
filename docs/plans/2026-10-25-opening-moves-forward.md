# A link's last opening only moves forward (#260)

## Problem
**OBSERVED**, reproduced red through MCP by the new test in `src/mcp/handy.test.ts`. The steps:
1. `update_link` with `opened` and `handy` takes `now`, then awaits the handy write (`src/mcp/server.ts`, the `update_link` callback).
2. A web opening lands meanwhile, at a later time.
3. The AI's link write then stores its earlier `now`.

The store wrote `last_opened_at = ?` unguarded (`SqliteStore.updateSync`), and `FakeStore.update` copied the field the same way. The opening went back from 12:01 to 12:00.

## Who writes an opening (OBSERVED)
- **The only non-test patch writer:** `buildPatch` in `src/core/links.ts`, where `opened: true` gives `lastOpenedAt = now()`.
- **Store writes:** `update`, `updateWithReceipt` and `updateIf` all apply a patch through `updateSync` in SQLite, and through `FakeStore.update` in the fake.
- **Inserts** (`insertIfAbsent`) set it directly and are not patches. A new link from `saveLink` gets null (`src/core/links.ts`).
- **Null:** no code outside tests patches `lastOpenedAt` to null. Null keeps its existing meaning (it clears the value).

## Fix
- **The store keeps the later time:**
  - SQLite: `last_opened_at = MAX(COALESCE(last_opened_at, ?), ?)`.
  - FakeStore: drops an earlier `lastOpenedAt` before applying the patch.
- **The rest of the patch and the patch's `opened` event still apply.** The event records a real opening at its own time; only the "last" value is guarded.
- **The rule is stated** on `LinkStore.update`'s contract in `src/core/store.ts`.
- **Tests:**
  - a store-contract test, run against both stores, through `update`, `updateWithReceipt` and `updateIf`;
  - the MCP test above, from the reported entry point.

**Why the store, and not MCP taking `now` after the handy write:**
- The store guard covers any order two openings land in, from any caller.
- It's atomic in the one write, as `summaryOver` already is.
- Moving `now` in MCP would break the "one instant for the handy write, the link write and the view" rule that the handy tests protect.

## Effects
- **"Last opening" means the latest recorded time.** If the server's clock were wrong ahead and later corrected, the wrong later time would be kept.
- **Paging:** non-null opening writes keep `decode`'s `ms <= lastOpenedAt` rule for Recently opened cursors. A null patch still clears the time, but no code outside tests sends one.
- **Readers:** per the Codex challenge's before/after probe, Handy waits, the digest, Tidy up and export see the latest opening rather than a stale one. Stats count opening events and whether a time is set, so they are unchanged.
- **Undo:** receipts don't cover opening times (`src/core/covered-fields.ts`), so Undo leaves the latest opening in place.
