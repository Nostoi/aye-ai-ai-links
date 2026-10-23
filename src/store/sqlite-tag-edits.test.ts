import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { A, at, B, newLink } from "../core/snapshot-store-contract.js";
import { describeTagEditStoreContract, mention } from "../core/tag-edit-store-contract.js";
import type { LinkTag, Tag } from "../core/types.js";
import { FtsSearch } from "../search/fts-search.js";
import { openDatabase } from "./database.js";
import { SqliteLinkEditStore } from "./sqlite-link-edits.js";
import { SqliteStore } from "./sqlite-store.js";
import { SqliteTagEditStore } from "./sqlite-tag-edits.js";
import { SqliteVectorIndex } from "./sqlite-vector-index.js";

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  const links = new SqliteStore(db);
  links.ensureUser(A, A);
  links.ensureUser(B, B);
  return { db, links, edits: new SqliteLinkEditStore(db), tagEdits: new SqliteTagEditStore(db) };
}

describeTagEditStoreContract("SqliteTagEditStore", () => {
  const { links, edits, tagEdits } = setup();
  return { links, edits, tagEdits, addOwner: (o) => links.ensureUser(o, o) };
});

describe("SqliteTagEditStore, beyond the contract", () => {
  let n = 0;
  const save = async (s: ReturnType<typeof setup>, tags: LinkTag[], owner = A) =>
    (await s.links.insertIfAbsent(owner, { ...newLink(++n, at(0)), tags })).link.id;
  const tag = async (s: ReturnType<typeof setup>, key: string, owner = A) =>
    (await s.links.listTags(owner)).find((t) => t.key === key) as Tag;
  const settings = ({ kind, kindSource, color, pinned, description, projectStatus }: Tag) => ({
    kind,
    kindSource,
    color,
    pinned,
    description,
    projectStatus,
  });
  const merge = async (
    s: ReturnType<typeof setup>,
    from: string,
    into: string,
    pruneBefore = at(0),
    owner = A,
  ) => {
    const kept = await tag(s, into, owner);
    const result = await s.tagEdits.mergeTag(owner, {
      from: await tag(s, from, owner),
      into: kept,
      set: settings(kept),
      at: at(10),
      pruneBefore,
    });
    if (typeof result === "string" || result === null) throw new Error(`merge: ${result}`);
    return result;
  };
  const rows = (db: Database.Database) =>
    db
      .prepare(
        `SELECT lt.link_id AS link, t.key AS key, lt.source AS source, lt.position AS position
         FROM link_tags lt JOIN tags t ON t.id = lt.tag_id ORDER BY lt.link_id, lt.position`,
      )
      .all();

  it("renamed links are found by the new name, and their meaning document changes", async () => {
    const s = setup();
    const fts = new FtsSearch(s.db);
    const index = new SqliteVectorIndex(s.db, 4);
    const renamed = await save(s, [mention("xylophonetag")]);
    const merged = await save(s, [mention("quokkatag")]);
    await save(s, [mention("coraltag")], B);
    const docs = async () => (await index.indexPage("m", null, 10)).map((r) => [r.linkId, r.tags]);
    expect(await docs()).toContainEqual([renamed, ["xylophonetag"]]);
    await s.tagEdits.renameTag(A, "xylophonetag", "coraltag", "coraltag");
    expect(await fts.search(A, "coraltag", {}, 10)).toEqual([renamed]);
    expect(await fts.search(A, "xylophonetag", {}, 10)).toEqual([]);
    await merge(s, "quokkatag", "coraltag");
    expect((await fts.search(A, "coraltag", {}, 10)).sort()).toEqual([renamed, merged].sort());
    expect(await fts.search(A, "quokkatag", {}, 10)).toEqual([]);
    expect(await docs()).toContainEqual([renamed, ["coraltag"]]);
    expect(await docs()).toContainEqual([merged, ["coraltag"]]);
  });

  it("a merge keeps the kept row's position and does not compact; undo puts every position back", async () => {
    const s = setup();
    const first = await save(s, [mention("y", "inferred"), mention("m"), mention("x")]);
    const second = await save(s, [mention("x", "asked"), mention("m"), mention("y", "inferred")]);
    const before = rows(s.db);
    const { changeId } = await merge(s, "x", "y");
    expect(rows(s.db)).toEqual([
      { link: Number(first), key: "y", source: "stated", position: 0 },
      { link: Number(first), key: "m", source: "stated", position: 1 },
      { link: Number(second), key: "m", source: "stated", position: 1 },
      { link: Number(second), key: "y", source: "asked", position: 2 },
    ]);
    expect(await s.tagEdits.undoTagChange(A, changeId, at(0))).not.toBe("conflict");
    expect(rows(s.db)).toEqual(before);
  });

  it("a rename of capitals only writes no alias; one that changes the key writes one", async () => {
    const s = setup();
    await save(s, [mention("game art")]);
    await s.tagEdits.renameTag(A, "game art", "Game Art", "game art");
    const aliases = () => s.db.prepare("SELECT owner_id, old_key FROM tag_aliases").all();
    expect(aliases()).toEqual([]);
    await s.tagEdits.renameTag(A, "game art", "Art", "art");
    expect(aliases()).toEqual([{ owner_id: A, old_key: "game art" }]);
  });

  it("a merge or delete prunes the owner's receipts older than pruneBefore, and only theirs", async () => {
    const s = setup();
    await save(s, [mention("a"), mention("b"), mention("c")]);
    await save(s, [mention("a"), mention("b")], B);
    await merge(s, "a", "b", at(0), B);
    await merge(s, "a", "b");
    const receipts = () =>
      s.db
        .prepare(
          "SELECT owner_id, count(*) AS n FROM tag_changes GROUP BY owner_id ORDER BY owner_id",
        )
        .all();
    const counts = (a: number, b: number) => [
      { owner_id: A, n: a },
      { owner_id: B, n: b },
    ];
    expect(receipts()).toEqual(counts(1, 1));
    await merge(s, "b", "c", at(10));
    expect(receipts()).toEqual(counts(2, 1));
    await save(s, [mention("d")]);
    await merge(s, "d", "c", at(11));
    expect(receipts()).toEqual(counts(1, 1));
    const result = await s.tagEdits.deleteTag(A, {
      tag: await tag(s, "c"),
      at: at(20),
      pruneBefore: at(20),
    });
    expect(result).toMatchObject({ moved: 2 });
    expect(receipts()).toEqual(counts(1, 1));
  });
});
