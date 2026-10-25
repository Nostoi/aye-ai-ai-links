import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { A, at, newLink } from "../core/snapshot-store-contract.js";
import { mention } from "../core/tag-edit-store-contract.js";
import { describeTagSuggestStoreContract } from "../core/tag-suggest-store-contract.js";
import type { Tag } from "../core/types.js";
import { openDatabase } from "./database.js";
import { SqliteStore } from "./sqlite-store.js";
import { SqliteTagEditStore } from "./sqlite-tag-edits.js";
import { SqliteTagSuggestStore } from "./sqlite-tag-suggest.js";

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  const links = new SqliteStore(db);
  links.ensureUser(A, A);
  return {
    db,
    links,
    tagEdits: new SqliteTagEditStore(db),
    tagSuggest: new SqliteTagSuggestStore(db),
  };
}

describeTagSuggestStoreContract("SqliteTagSuggestStore", () => {
  const { links, tagSuggest } = setup();
  return { links, tagSuggest, addOwner: (o) => links.ensureUser(o, o) };
});

describe("SqliteTagSuggestStore, beyond the contract", () => {
  const tag = async (s: ReturnType<typeof setup>, key: string) =>
    (await s.links.listTags(A)).find((t) => t.key === key) as Tag;
  const settings = ({ kind, kindSource, color, pinned, description, projectStatus }: Tag) => ({
    kind,
    kindSource,
    color,
    pinned,
    description,
    projectStatus,
  });
  const mergeThenUndo = async (s: ReturnType<typeof setup>, from: string, into: string) => {
    const kept = await tag(s, into);
    const result = await s.tagEdits.mergeTag(A, {
      from: await tag(s, from),
      into: kept,
      set: settings(kept),
      at: at(10),
      pruneBefore: at(0),
    });
    if (typeof result === "string" || result === null) throw new Error(`merge: ${result}`);
    expect(await s.tagEdits.undoTagChange(A, result.changeId, at(0))).toHaveProperty("tags");
  };

  it("a dismissal survives the merge and its Undo of either tag, and the delete and its Undo", async () => {
    const s = setup();
    await s.links.insertIfAbsent(A, { ...newLink(1, at(0)), tags: [mention("x")] });
    await s.links.insertIfAbsent(A, { ...newLink(2, at(0)), tags: [mention("y")] });
    await s.tagSuggest.dismissPair(A, "x", "y", at(1));
    await mergeThenUndo(s, "x", "y");
    await mergeThenUndo(s, "y", "x");
    const removed = await s.tagEdits.deleteTag(A, {
      tag: await tag(s, "x"),
      at: at(10),
      pruneBefore: at(0),
    });
    if (typeof removed === "string" || removed === null) throw new Error(`delete: ${removed}`);
    expect(await s.tagSuggest.dismissedPairs(A)).toEqual([["x", "y"]]);
    expect(await s.tagEdits.undoTagChange(A, removed.changeId, at(0))).toHaveProperty("tags");
    expect(await s.tagSuggest.dismissedPairs(A)).toEqual([["x", "y"]]);
  });

  it("a rename leaves the dismissal on the old keys, so the new name is a different pair", async () => {
    const s = setup();
    await s.links.insertIfAbsent(A, { ...newLink(1, at(0)), tags: [mention("x")] });
    await s.tagSuggest.dismissPair(A, "x", "y", at(1));
    await s.tagEdits.renameTag(A, "x", "Z", "z");
    expect(await s.tagSuggest.dismissedPairs(A)).toEqual([["x", "y"]]);
  });
});
