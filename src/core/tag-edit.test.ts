import { describe, expect, it } from "vitest";
import type { CoreError } from "./errors.js";
import { FakeStore } from "./fake-store.js";
import { newLink } from "./snapshot-store-contract.js";
import {
  deleteTag,
  listTagsWithCounts,
  mergedSettings,
  mergeTags,
  renameTag,
  TAG_UNDO_WINDOW_MS,
  tagAddress,
  undoTagChange,
} from "./tag-edit.js";
import type { TagEditStore } from "./tag-edit-store.js";
import type { Tag } from "./types.js";

const tag = (key: string, over: Partial<Tag> = {}): Tag => ({
  key,
  name: key,
  kind: "topic",
  kindSource: "inferred",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
  ...over,
});

async function failure(p: Promise<unknown>): Promise<CoreError> {
  try {
    await p;
  } catch (e) {
    return e as CoreError;
  }
  throw new Error("expected a rejection");
}

const NOW = new Date("2026-10-23T12:00:00Z");
const LATE = new Date(NOW.getTime() + TAG_UNDO_WINDOW_MS + 1);

/** A FakeStore with these tags, and a TagEditStore that may override some of its methods. */
function setup(tags: Tag[], override: Partial<TagEditStore> = {}) {
  const store = new FakeStore();
  for (const t of tags) store.seedTag("o", t);
  const tagEdits: TagEditStore = {
    tagLinkCounts: (o) => store.tagLinkCounts(o),
    renameTag: (o, k, n, nk) => store.renameTag(o, k, n, nk),
    mergeTag: (o, m) => store.mergeTag(o, m),
    deleteTag: (o, d) => store.deleteTag(o, d),
    undoTagChange: (o, id, since) => store.undoTagChange(o, id, since),
    currentKey: (o, k) => store.currentKey(o, k),
    ...override,
  };
  return { store, deps: { store, tagEdits, now: () => NOW } };
}

describe("mergedSettings", () => {
  it("pins if either was pinned, and colour and description fall back to the old tag's", () => {
    const s = mergedSettings(
      tag("a", { pinned: true, color: "red", description: "from" }),
      tag("b"),
    );
    expect(s).toMatchObject({ pinned: true, color: "red", description: "from" });
  });

  it("keeps the kept tag's own colour and description", () => {
    const s = mergedSettings(
      tag("a", { color: "red", description: "from" }),
      tag("b", { color: "blue", description: "into" }),
    );
    expect(s).toMatchObject({ pinned: false, color: "blue", description: "into" });
  });

  it("makes a topic the stated or asked project it absorbs, with its status and source", () => {
    const from = tag("a", { kind: "project", kindSource: "stated", projectStatus: "done" });
    expect(mergedSettings(from, tag("b"))).toMatchObject({
      kind: "project",
      kindSource: "stated",
      projectStatus: "done",
    });
    expect(mergedSettings({ ...from, kindSource: "asked" }, tag("b"))).toMatchObject({
      kind: "project",
      kindSource: "asked",
      projectStatus: "done",
    });
  });

  it("leaves a topic a topic when the old project was only inferred", () => {
    const from = tag("a", { kind: "project", kindSource: "inferred", projectStatus: "active" });
    expect(mergedSettings(from, tag("b"))).toMatchObject({
      kind: "topic",
      kindSource: "inferred",
      projectStatus: null,
    });
  });

  it("takes the kept project's status when both are projects", () => {
    const from = tag("a", { kind: "project", kindSource: "stated", projectStatus: "done" });
    const into = tag("b", { kind: "project", kindSource: "asked", projectStatus: "active" });
    expect(mergedSettings(from, into)).toMatchObject({
      kind: "project",
      kindSource: "asked",
      projectStatus: "active",
    });
  });
});

describe("renameTag", () => {
  it("renames in place; a capitals-only change keeps the key", async () => {
    const { deps } = setup([tag("game art", { name: "game art" })]);
    const r = await renameTag(deps, "o", { name: "game art", newName: "  Game   Art " });
    expect(r).toEqual({ renamed: expect.objectContaining({ key: "game art", name: "Game Art" }) });
  });

  it("reports the other tag and its live count when the new name is taken", async () => {
    const { store, deps } = setup([tag("pixel-art"), tag("game art", { name: "Game Art" })]);
    await store.insertIfAbsent("o", {
      ...newLink(1, NOW),
      tags: [
        {
          key: "game art",
          name: "Game Art",
          source: "stated",
          kind: "topic",
          kindSource: "inferred",
        },
      ],
    });
    const r = await renameTag(deps, "o", { name: "pixel-art", newName: "GAME ART" });
    expect(r).toEqual({ taken: expect.objectContaining({ key: "game art" }), links: 1 });
    expect((await store.listTags("o")).map((t) => t.key)).toEqual(["game art", "pixel-art"]);
  });

  it("is not_found for a missing tag and invalid_input for a blank new name", async () => {
    const { deps } = setup([tag("a")]);
    expect((await failure(renameTag(deps, "o", { name: "zzz", newName: "b" }))).code).toBe(
      "not_found",
    );
    expect((await failure(renameTag(deps, "o", { name: "a", newName: "  " }))).code).toBe(
      "invalid_input",
    );
  });
});

describe("mergeTags and deleteTag", () => {
  it("refuses a merge into itself, before the store is asked", async () => {
    let asked = false;
    const { deps } = setup([tag("a")], {
      mergeTag: async () => {
        asked = true;
        return "conflict";
      },
    });
    const e = await failure(mergeTags(deps, "o", { name: "a", into: " A " }));
    expect(e.code).toBe("invalid_input");
    expect(asked).toBe(false);
  });

  it("is not_found when a tag is missing", async () => {
    const { deps } = setup([tag("a")]);
    expect((await failure(mergeTags(deps, "o", { name: "a", into: "zzz" }))).code).toBe(
      "not_found",
    );
    expect((await failure(mergeTags(deps, "o", { name: "zzz", into: "a" }))).code).toBe(
      "not_found",
    );
    expect((await failure(deleteTag(deps, "o", { name: "zzz" }))).code).toBe("not_found");
  });

  it("gives the store the merged settings, the time and the prune cut-off", async () => {
    let seen: Parameters<TagEditStore["mergeTag"]>[1] | undefined;
    const { deps, store } = setup([tag("a", { pinned: true }), tag("b")], {
      mergeTag: async (o, m) => {
        seen = m;
        return store.mergeTag(o, m);
      },
    });
    const r = await mergeTags(deps, "o", { name: "a", into: "b" });
    expect(r.tag.key).toBe("b");
    expect(seen?.set.pinned).toBe(true);
    expect(seen?.at).toEqual(NOW);
    expect(seen?.pruneBefore).toEqual(new Date(NOW.getTime() - TAG_UNDO_WINDOW_MS));
    expect((await store.listTags("o")).map((t) => t.key)).toEqual(["b"]);
  });

  it("reads again once on a conflict, then reports it", async () => {
    let writes = 0;
    let reads = 0;
    const { store, deps } = setup([tag("a"), tag("b")], {
      mergeTag: async () => {
        writes++;
        return "conflict";
      },
    });
    const counting = {
      ...deps,
      store: {
        listTags: (o: string) => {
          reads++;
          return store.listTags(o);
        },
      },
    };
    const e = await failure(mergeTags(counting as never, "o", { name: "a", into: "b" }));
    expect(e.code).toBe("conflict");
    expect([reads, writes]).toEqual([2, 2]);
  });

  it("lets a delete succeed on the retry", async () => {
    let calls = 0;
    const { deps, store } = setup([tag("a")], {
      deleteTag: async (o, d) => (++calls === 1 ? "conflict" : store.deleteTag(o, d)),
    });
    const r = await deleteTag(deps, "o", { name: "a" });
    expect(calls).toBe(2);
    expect(r.moved).toBe(0);
  });
});

describe("undoTagChange", () => {
  it("says it is too late when the store has no usable receipt, asking with the window cut-off", async () => {
    let since: Date | undefined;
    const { deps } = setup([], {
      undoTagChange: async (_o, _id, d) => {
        since = d;
        return null;
      },
    });
    const e = await failure(undoTagChange(deps, "o", "x"));
    expect(e.code).toBe("not_found");
    expect(e.message).toBe("It's too late to undo: that change can no longer be undone.");
    expect(since).toEqual(new Date(NOW.getTime() - TAG_UNDO_WINDOW_MS));
  });

  it("refuses a conflict once, without retrying", async () => {
    let calls = 0;
    const { deps } = setup([], {
      undoTagChange: async () => {
        calls++;
        return "conflict";
      },
    });
    const e = await failure(undoTagChange(deps, "o", "x"));
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("The tags changed since, so nothing was undone.");
    expect(calls).toBe(1);
  });

  it("undoes a delete inside the window and not after it", async () => {
    const { deps } = setup([tag("a")]);
    const { changeId } = await deleteTag(deps, "o", { name: "a" });
    const e = await failure(undoTagChange({ ...deps, now: () => LATE }, "o", changeId));
    expect(e.code).toBe("not_found");
    const back = await undoTagChange(deps, "o", changeId);
    expect(back.map((t) => t.tag.key)).toEqual(["a"]);
  });
});

describe("listTagsWithCounts and tagAddress", () => {
  it("lists every tag with its live link count, zero when none", async () => {
    const { deps } = setup([tag("a")]);
    expect(await listTagsWithCounts(deps, "o")).toEqual([{ tag: tag("a"), links: 0 }]);
  });

  it("gives the new key for an old name after a rename, and null for an unknown one", async () => {
    const { deps } = setup([tag("pixel-art", { name: "Pixel-Art" })]);
    await renameTag(deps, "o", { name: "pixel-art", newName: "sprites" });
    expect(await tagAddress(deps, "o", "Pixel-Art")).toBe("sprites");
    expect(await tagAddress(deps, "o", "nothing")).toBeNull();
  });
});
