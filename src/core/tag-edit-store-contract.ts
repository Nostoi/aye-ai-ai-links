import { beforeEach, describe, expect, it } from "vitest";
import type { LinkEditStore } from "./link-edit-store.js";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { LinkRemover, LinkStore } from "./store.js";
import type { TagEditStore, TagSettings } from "./tag-edit-store.js";
import type { LinkTag, Source, Tag } from "./types.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type TagEditHarness = {
  links: LinkStore & LinkRemover;
  edits: LinkEditStore;
  tagEdits: TagEditStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

/** A topic mention of `key`, attached with `source`. */
export const mention = (key: string, source: Source = "stated"): LinkTag => ({
  key,
  name: key,
  source,
  kind: "topic",
  kindSource: "inferred",
});

const settingsOf = ({ kind, kindSource, color, pinned, description, projectStatus }: Tag) => ({
  kind,
  kindSource,
  color,
  pinned,
  description,
  projectStatus,
});

const PRUNE = at(-3600);

export function describeTagEditStoreContract(
  name: string,
  makeHarness: () => TagEditHarness | Promise<TagEditHarness>,
): void {
  describe(name, () => {
    let h: TagEditHarness;
    let n: number;

    /** A new link of `owner` with these tags, hidden by a delete at `hiddenAt` when given. */
    const save = async (owner: string, tags: LinkTag[], hiddenAt?: Date): Promise<string> => {
      const { link } = await h.links.insertIfAbsent(owner, { ...newLink(++n, at(0)), tags });
      if (hiddenAt) expect(await h.links.markDeleted(owner, link.id, hiddenAt)).toBe(true);
      return link.id;
    };
    /** The link's ordered tags as key and source; a hidden link is restored to read it. */
    const marks = async (owner: string, id: string) => {
      const link = (await h.links.get(owner, id)) ?? (await revealed(owner, id));
      return link?.tags.map((t) => [t.key, t.source]) ?? null;
    };
    const revealed = async (owner: string, id: string) =>
      (await h.links.unmarkDeleted(owner, id, at(-100000))) ? h.links.get(owner, id) : null;
    const tag = async (owner: string, key: string) => {
      const found = (await h.links.listTags(owner)).find((t) => t.key === key);
      if (!found) throw new Error(`no tag ${key}`);
      return found;
    };
    const keys = async (owner: string) => (await h.links.listTags(owner)).map((t) => t.key);
    const merge = async (from: string, into: string, set?: Partial<TagSettings>, owner = A) => {
      const kept = await tag(owner, into);
      const result = await h.tagEdits.mergeTag(owner, {
        from: await tag(owner, from),
        into: kept,
        set: { ...settingsOf(kept), ...set },
        at: at(10),
        pruneBefore: PRUNE,
      });
      if (typeof result === "string" || result === null)
        throw new Error(`merge ${from} into ${into}: ${result}`);
      return result;
    };
    const remove = async (key: string, owner = A) => {
      const result = await h.tagEdits.deleteTag(owner, {
        tag: await tag(owner, key),
        at: at(10),
        pruneBefore: PRUNE,
      });
      if (typeof result === "string" || result === null)
        throw new Error(`delete ${key}: ${result}`);
      return result;
    };
    const rename = async (key: string, to: string, owner = A) => {
      const result = await h.tagEdits.renameTag(owner, key, to, to.toLowerCase());
      if (typeof result === "string" || result === null)
        throw new Error(`rename ${key}: ${result}`);
      return result;
    };
    const undo = (changeId: string, owner = A) => h.tagEdits.undoTagChange(owner, changeId, at(0));
    /** Everything an owner can read about their tags and these links. */
    const world = async (owner: string, ids: string[]) => ({
      tags: await h.links.listTags(owner),
      links: await Promise.all(ids.map((id) => h.links.get(owner, id))),
      counts: await h.tagEdits.tagLinkCounts(owner),
    });

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("tagLinkCounts counts live links only", async () => {
      await save(A, [mention("x"), mention("y")]);
      const archived = await save(A, [mention("x")]);
      await h.links.update(A, archived, { state: "archived" });
      await save(A, [mention("x"), mention("y")], at(5));
      const emptied = await save(A, [mention("z")]);
      await h.links.update(A, emptied, { tags: [] });
      await save(B, [mention("x")]);
      expect(await h.tagEdits.tagLinkCounts(A)).toEqual(
        new Map([
          ["x", 2],
          ["y", 1],
        ]),
      );
      expect(await h.tagEdits.tagLinkCounts(B)).toEqual(new Map([["x", 1]]));
      expect(await h.tagEdits.tagLinkCounts("nobody")).toEqual(new Map());
    });

    it("renameTag changes key and name, and the old key reaches it", async () => {
      const live = await save(A, [mention("first", "inferred"), mention("pixel-art", "asked")]);
      const hidden = await save(A, [mention("pixel-art")], at(5));
      await h.links.pinTag(A, "pixel-art", { pinned: true, color: "sage" });
      const before = await tag(A, "pixel-art");
      const renamed = await h.tagEdits.renameTag(A, "pixel-art", "Pixel Art", "pixel art");
      expect(renamed).toEqual({ ...before, key: "pixel art", name: "Pixel Art" });
      expect(await keys(A)).toEqual(["first", "pixel art"]);
      expect((await h.links.get(A, live))?.tags).toEqual([
        mention("first", "inferred"),
        { ...mention("pixel art", "asked"), name: "Pixel Art" },
      ]);
      expect(await marks(A, hidden)).toEqual([["pixel art", "stated"]]);
      expect(await h.tagEdits.currentKey(A, "pixel-art")).toBe("pixel art");
      expect(await h.tagEdits.currentKey(A, "pixel art")).toBe("pixel art");
      expect(await h.tagEdits.currentKey(A, "nothing")).toBeNull();
      expect(await h.tagEdits.renameTag(A, "nothing", "Else", "else")).toBeNull();
    });

    it("renameTag of capitals only keeps the key and adds no alias", async () => {
      const id = await save(A, [mention("game art")]);
      const edit = await h.edits.applyEdit(
        A,
        id,
        { tags: { expected: [{ key: "game art", source: "stated" }], set: [] } },
        at(1),
      );
      const renamed = await h.tagEdits.renameTag(A, "game art", "Game Art", "game art");
      expect(renamed).toMatchObject({ key: "game art", name: "Game Art" });
      expect(await keys(A)).toEqual(["game art"]);
      // A rename that keeps the key cancels no link-edit receipt.
      if (edit === "conflict" || !edit?.editId) throw new Error("expected an edit id");
      expect(await h.edits.undoEdit(A, id, edit.editId)).toBe("undone");
      expect((await h.links.get(A, id))?.tags).toEqual([
        { ...mention("game art"), name: "Game Art" },
      ]);
    });

    it('renameTag onto another tag\'s key is "taken" and writes nothing', async () => {
      const id = await save(A, [mention("a"), mention("b")]);
      const before = await world(A, [id]);
      expect(await h.tagEdits.renameTag(A, "a", "B", "b")).toBe("taken");
      expect(await world(A, [id])).toEqual(before);
      expect(await h.tagEdits.currentKey(A, "a")).toBe("a");
    });

    it("mergeTag moves every link, including a hidden one", async () => {
      const live = await save(A, [mention("x", "asked")]);
      const hidden = await save(A, [mention("x")], at(5));
      const kept = await save(A, [mention("y")]);
      const result = await merge("x", "y");
      expect(result).toMatchObject({ moved: 1, links: 2, tag: await tag(A, "y") });
      expect(await keys(A)).toEqual(["y"]);
      expect(await marks(A, live)).toEqual([["y", "asked"]]);
      expect(await marks(A, kept)).toEqual([["y", "stated"]]);
      expect(await marks(A, hidden)).toEqual([["y", "stated"]]);
      expect(await h.tagEdits.currentKey(A, "x")).toBe("y");
      expect(await h.tagEdits.tagLinkCounts(A)).toEqual(new Map([["y", 3]]));
    });

    it("mergeTag on a link with both keeps one, at the kept position, with the stronger source", async () => {
      const keptFirst = await save(A, [mention("y", "inferred"), mention("m"), mention("x")]);
      const oldFirst = await save(A, [
        mention("x", "asked"),
        mention("m"),
        mention("y", "inferred"),
      ]);
      const weaker = await save(A, [mention("x", "inferred"), mention("y", "stated")]);
      const result = await merge("x", "y");
      expect(result).toMatchObject({ moved: 3, links: 3 });
      expect(await marks(A, keptFirst)).toEqual([
        ["y", "stated"],
        ["m", "stated"],
      ]);
      expect(await marks(A, oldFirst)).toEqual([
        ["m", "stated"],
        ["y", "asked"],
      ]);
      expect(await marks(A, weaker)).toEqual([["y", "stated"]]);
    });

    it("mergeTag repoints aliases, so chains resolve", async () => {
      await save(A, [mention("a")]);
      await save(A, [mention("c")]);
      await rename("a", "b");
      await merge("b", "c");
      expect(await h.tagEdits.currentKey(A, "a")).toBe("c");
      expect(await h.tagEdits.currentKey(A, "b")).toBe("c");
      await rename("c", "d");
      expect(await h.tagEdits.currentKey(A, "a")).toBe("d");
    });

    it('mergeTag refuses when from or into changed ("conflict", rows unchanged), and a missing tag is null', async () => {
      const id = await save(A, [mention("x"), mention("y")]);
      const from = await tag(A, "x");
      const into = await tag(A, "y");
      const set = settingsOf(into);
      const before = await world(A, [id]);
      const go = (f: Tag, i: Tag) =>
        h.tagEdits.mergeTag(A, { from: f, into: i, set, at: at(10), pruneBefore: PRUNE });
      for (const stale of [
        { color: "sage" },
        { pinned: true },
        { name: "X" },
        { kind: "project" as const },
        { kindSource: "stated" as const },
        { description: "d" },
        { projectStatus: "active" as const },
      ]) {
        expect(await go({ ...from, ...stale }, into)).toBe("conflict");
        expect(await go(from, { ...into, ...stale })).toBe("conflict");
      }
      expect(await world(A, [id])).toEqual(before);
      expect(await go({ ...from, key: "gone" }, into)).toBeNull();
      expect(await go(from, { ...into, key: "gone" })).toBeNull();
      expect(await world(A, [id])).toEqual(before);
    });

    it("deleteTag removes it from every link and from the catalog", async () => {
      const live = await save(A, [mention("a"), mention("x"), mention("b")]);
      const hidden = await save(A, [mention("x")], at(5));
      await save(A, [mention("w")]);
      await rename("w", "x2");
      await merge("x2", "x");
      const result = await remove("x");
      expect(result.moved).toBe(2);
      expect(await keys(A)).toEqual(["a", "b"]);
      expect(await marks(A, live)).toEqual([
        ["a", "stated"],
        ["b", "stated"],
      ]);
      expect(await marks(A, hidden)).toEqual([]);
      expect(await h.tagEdits.currentKey(A, "x")).toBeNull();
      expect(await h.tagEdits.currentKey(A, "w")).toBeNull();
      expect(
        await h.tagEdits.deleteTag(A, { tag: await tag(A, "a"), at: at(10), pruneBefore: PRUNE }),
      ).toMatchObject({ moved: 1 });
      expect(
        await h.tagEdits.deleteTag(A, {
          tag: { ...(await tag(A, "b")), color: "sage" },
          at: at(10),
          pruneBefore: PRUNE,
        }),
      ).toBe("conflict");
      expect(
        await h.tagEdits.deleteTag(A, {
          tag: { ...(await tag(A, "b")), key: "gone" },
          at: at(10),
          pruneBefore: PRUNE,
        }),
      ).toBeNull();
      expect(await keys(A)).toEqual(["b"]);
    });

    /**
     * A merge's two tags with every setting used: `f` is a stated, pinned project with a
     * description and two old keys, on four live links (one also has `k`) and a hidden one.
     */
    const richPair = async () => {
      await save(A, [mention("seed")]);
      const solo = await save(A, [mention("f", "asked")]);
      const both = await save(A, [mention("k", "inferred"), mention("o"), mention("f", "stated")]);
      const keptOnly = await save(A, [mention("k", "asked")]);
      const hidden = await save(A, [mention("o"), mention("f", "inferred")], at(5));
      await h.links.updateTag(
        A,
        "f",
        { kind: "project", kindSource: "stated", projectStatus: "active" },
        "topic",
      );
      await h.links.pinTag(A, "f", { pinned: true, color: "sage" });
      await merge("seed", "f", { ...settingsOf(await tag(A, "f")), description: "the f tag" });
      await save(A, [mention("old f")]);
      await rename("old f", "f2");
      await merge("f2", "f");
      return { ids: [solo, both, keptOnly, hidden], hidden };
    };

    it("undo restores a merge exactly", async () => {
      const { ids, hidden } = await richPair();
      const tagsBefore = await h.links.listTags(A);
      const marksBefore = await Promise.all(ids.map((id) => marks(A, id)));
      expect(await h.links.markDeleted(A, hidden, at(5))).toBe(true);
      const result = await merge("f", "k", {
        pinned: true,
        color: "sage",
        kind: "project",
        kindSource: "stated",
        projectStatus: "active",
        description: "the f tag",
      });
      expect(result).toMatchObject({
        moved: 4,
        links: 5,
        tag: { key: "k", kind: "project", pinned: true },
      });
      expect(await undo(result.changeId)).toEqual({
        tags: [
          { tag: await tag(A, "f"), links: 4 },
          { tag: await tag(A, "k"), links: 2 },
        ],
      });
      expect(await h.links.listTags(A)).toEqual(tagsBefore);
      expect(await Promise.all(ids.map((id) => marks(A, id)))).toEqual(marksBefore);
      expect(await h.tagEdits.currentKey(A, "old f")).toBe("f");
      expect(await h.tagEdits.currentKey(A, "seed")).toBe("f");
      // The merge's own alias is gone: with f deleted, "f" reaches nothing, not k.
      await remove("f");
      expect(await h.tagEdits.currentKey(A, "f")).toBeNull();
    });

    it("undo restores a delete exactly", async () => {
      const { ids, hidden } = await richPair();
      const tagsBefore = await h.links.listTags(A);
      const marksBefore = await Promise.all(ids.map((id) => marks(A, id)));
      expect(await h.links.markDeleted(A, hidden, at(5))).toBe(true);
      const result = await remove("f");
      expect(result.moved).toBe(4);
      expect(await undo(result.changeId)).toEqual({ tags: [{ tag: await tag(A, "f"), links: 4 }] });
      expect(await h.links.listTags(A)).toEqual(tagsBefore);
      expect(await Promise.all(ids.map((id) => marks(A, id)))).toEqual(marksBefore);
      expect(await h.tagEdits.currentKey(A, "old f")).toBe("f");
      expect(await h.tagEdits.currentKey(A, "seed")).toBe("f");
    });

    describe("undo is refused after a later change", () => {
      /** Undo answers `refusal` and writes nothing: "blocked" when a newer undoable change shares its ground, else "conflict". Once `revert` puts the change back, it is undone. */
      const refused = async (
        changeId: string,
        ids: string[],
        revert?: () => Promise<unknown>,
        refusal: "conflict" | "blocked" = "conflict",
      ) => {
        const before = await world(A, ids);
        expect(await undo(changeId)).toBe(refusal);
        expect(await world(A, ids)).toEqual(before);
        if (revert) {
          await revert();
          expect(await undo(changeId)).not.toBe("conflict");
        }
      };

      it("a live tag now has the removed key", async () => {
        const id = await save(A, [mention("x")]);
        const { changeId } = await remove("x");
        const other = await save(A, [mention("x")]);
        await refused(changeId, [id, other]);
        await h.links.update(A, other, { tags: [] });
        await remove("x");
        await refused(changeId, [id, other], undefined, "blocked");
      });

      it("a newer change that removed the same key stays undoable", async () => {
        const one = await save(A, [mention("a")]);
        await save(A, [mention("c")]);
        const first = await merge("a", "c");
        const fresh = await save(A, [mention("a")]);
        const freshTag = await tag(A, "a");
        const second = await remove("a");
        await refused(first.changeId, [one, fresh], undefined, "blocked");
        expect(await undo(second.changeId)).toEqual({ tags: [{ tag: freshTag, links: 1 }] });
        expect(await marks(A, fresh)).toEqual([["a", "stated"]]);
      });

      it("the kept tag is missing", async () => {
        const id = await save(A, [mention("x"), mention("y")]);
        const { changeId } = await merge("x", "y");
        await rename("y", "z");
        await refused(changeId, [id], () => rename("z", "y"));
      });

      it("the kept tag's settings differ", async () => {
        const id = await save(A, [mention("x"), mention("y")]);
        const { changeId } = await merge("x", "y");
        await h.links.colorTag(A, "y", "sage");
        await refused(changeId, [id]);
      });

      it("a change to the kept tag reversed since does not block", async () => {
        await save(A, [mention("x"), mention("y")]);
        const { changeId } = await merge("x", "y");
        await h.links.updateTag(A, "y", { kind: "project", kindSource: "stated" }, "topic");
        await h.links.updateTag(A, "y", { kind: "topic", kindSource: "inferred" }, "project");
        expect(await undo(changeId)).toMatchObject({
          tags: [{ tag: { key: "x" } }, { tag: { key: "y" } }],
        });
      });

      it("a new link saved with the kept tag", async () => {
        const id = await save(A, [mention("x")]);
        await save(A, [mention("y")]);
        const { changeId } = await merge("x", "y");
        const added = await save(A, [mention("y")]);
        await refused(changeId, [id, added], () => h.links.update(A, added, { tags: [] }));
      });

      it("a receipt link's ordered tags changed", async () => {
        const id = await save(A, [mention("x"), mention("q")]);
        const { changeId } = await merge("x", "q");
        await h.links.update(A, id, { tags: [mention("q", "asked")] });
        await refused(changeId, [id], () => h.links.update(A, id, { tags: [mention("q")] }));
      });

      it("a hidden receipt link's ordered tags changed", async () => {
        const hidden = await save(A, [mention("x")], at(5));
        const { changeId } = await remove("x");
        const retag = async (tags: LinkTag[]) => {
          expect(await h.links.unmarkDeleted(A, hidden, at(0))).toBe(true);
          await h.links.update(A, hidden, { tags });
          expect(await h.links.markDeleted(A, hidden, at(6))).toBe(true);
        };
        await retag([mention("other")]);
        await refused(changeId, [hidden], () => retag([]));
      });

      it("a recorded old key now reaches another tag", async () => {
        const id = await save(A, [mention("banking")]);
        await rename("banking", "finance");
        const { changeId } = await remove("finance");
        const other = await save(A, [mention("banking")]);
        await rename("banking", "budget");
        await refused(changeId, [id, other]);
        expect(await h.tagEdits.currentKey(A, "banking")).toBe("budget");
      });

      it("a recorded old key is now a live key", async () => {
        const id = await save(A, [mention("w")]);
        await rename("w", "x");
        const { changeId } = await remove("x");
        const other = await save(A, [mention("w")]);
        await refused(changeId, [id, other]);
        await h.links.update(A, other, { tags: [] });
        await remove("w");
        await refused(changeId, [id, other], undefined, "blocked");
      });

      it("a newer change that removed a tag with a recorded old key stays undoable", async () => {
        const one = await save(A, [mention("a")]);
        const first = await remove("a");
        const fresh = await save(A, [mention("a")]);
        await rename("a", "b");
        const freshTag = await tag(A, "b");
        const second = await remove("b");
        await refused(first.changeId, [one, fresh], undefined, "blocked");
        expect(await undo(second.changeId)).toEqual({ tags: [{ tag: freshTag, links: 1 }] });
        expect(await marks(A, fresh)).toEqual([["b", "stated"]]);
      });

      it("a newer change whose recorded old key is the same one stays undoable", async () => {
        const one = await save(A, [mention("k")]);
        await rename("k", "x");
        const first = await remove("x");
        const fresh = await save(A, [mention("k")]);
        await rename("k", "m");
        const freshTag = await tag(A, "m");
        const second = await remove("m");
        await refused(first.changeId, [one, fresh], undefined, "blocked");
        expect(await undo(second.changeId)).toEqual({ tags: [{ tag: freshTag, links: 1 }] });
        expect(await marks(A, fresh)).toEqual([["m", "stated"]]);
      });

      for (const [label, older] of [
        ["delete", () => remove("a")],
        ["merge", () => merge("a", "b")],
      ] as const) {
        it(`a newer delete sharing only a link with an older ${label} stays undoable`, async () => {
          const one = await save(A, [mention("a"), mention("b")]);
          const two = await save(A, [mention("x")]);
          const three = await save(A, [mention("x")]);
          await h.links.pinTag(A, "x", { pinned: true, color: "blue" });
          const first = await older();
          await h.links.update(A, one, { tags: [mention("b"), mention("x")] });
          const ids = [one, two, three];
          const tagsBefore = await h.links.listTags(A);
          const marksBefore = await Promise.all(ids.map((id) => marks(A, id)));
          const x = await tag(A, "x");
          const second = await remove("x");
          await refused(first.changeId, ids, undefined, "blocked");
          expect(await undo(second.changeId)).toEqual({ tags: [{ tag: x, links: 3 }] });
          expect(x).toMatchObject({ pinned: true, color: "blue" });
          expect(await h.links.listTags(A)).toEqual(tagsBefore);
          expect(await Promise.all(ids.map((id) => marks(A, id)))).toEqual(marksBefore);
        });
      }

      for (const oldestFirst of [true, false]) {
        it(`two changes with no key or link in common undo ${oldestFirst ? "oldest" : "newest"} first`, async () => {
          const one = await save(A, [mention("a"), mention("b")]);
          const two = await save(A, [mention("x"), mention("y")]);
          const ids = [one, two];
          const tagsBefore = await h.links.listTags(A);
          const marksBefore = await Promise.all(ids.map((id) => marks(A, id)));
          const first = await remove("a");
          const second = await merge("x", "y");
          const order = oldestFirst ? [first, second] : [second, first];
          for (const { changeId } of order) expect(await undo(changeId)).not.toBe("conflict");
          expect(await h.links.listTags(A)).toEqual(tagsBefore);
          expect(await Promise.all(ids.map((id) => marks(A, id)))).toEqual(marksBefore);
        });
      }

      /** An older delete of `p` and a newer merge of `ga` into `g` that meet only through `one`. */
      const meetingPair = async () => {
        const one = await save(A, [mention("p"), mention("g")]);
        const two = await save(A, [mention("ga")]);
        const tagsBefore = await h.links.listTags(A);
        const p = await tag(A, "p");
        const first = await remove("p");
        const second = await merge("ga", "g");
        return { one, two, tagsBefore, p, first, second };
      };

      for (const [label, kill] of [
        ["a new link saved with its kept tag", () => save(A, [mention("g")])],
        ["its kept tag pinned", () => h.links.pinTag(A, "g", { pinned: true, color: "blue" })],
      ] as const) {
        it(`a newer change that can't be undone (${label}) doesn't block an older one`, async () => {
          const { one, p, first, second } = await meetingPair();
          await kill();
          expect(await undo(second.changeId)).toBe("conflict");
          expect(await undo(first.changeId)).toEqual({ tags: [{ tag: p, links: 1 }] });
          expect(await marks(A, one)).toEqual([
            ["p", "stated"],
            ["g", "stated"],
          ]);
        });
      }

      it("a newer change that can't be undone doesn't block an older one sharing its address", async () => {
        await save(A, [mention("a")]);
        await rename("a", "z");
        const fresh = await save(A, [mention("a")]);
        await save(A, [mention("q")]);
        const a = await tag(A, "a");
        const first = await remove("a");
        const second = await merge("q", "z");
        await save(A, [mention("z")]);
        expect(await undo(second.changeId)).toBe("conflict");
        expect(await undo(first.changeId)).toEqual({ tags: [{ tag: a, links: 1 }] });
        expect(await marks(A, fresh)).toEqual([["a", "stated"]]);
        expect(await h.tagEdits.currentKey(A, "a")).toBe("a");
      });

      it("a newer change revived after the older undo still undoes cleanly", async () => {
        const { one, two, tagsBefore, first, second } = await meetingPair();
        const added = await save(A, [mention("g")]);
        expect(await undo(first.changeId)).not.toBe("conflict");
        await h.links.update(A, added, { tags: [] });
        expect(await undo(second.changeId)).not.toBe("conflict");
        expect(await h.links.listTags(A)).toEqual(tagsBefore);
        expect(await marks(A, one)).toEqual([
          ["p", "stated"],
          ["g", "stated"],
        ]);
        expect(await marks(A, two)).toEqual([["ga", "stated"]]);
        expect(await marks(A, added)).toEqual([]);
      });
    });

    describe("undo waits for a newer merge into the same tag and respects a later address", () => {
      it("two merges into one tag come back newest first, never oldest first", async () => {
        const one = await save(A, [mention("a")]);
        const two = await save(A, [mention("b"), mention("c")]);
        await h.links.pinTag(A, "a", { pinned: true, color: "teal" });
        await h.links.pinTag(A, "b", { pinned: true, color: "blue" });
        const tagsBefore = await h.links.listTags(A);
        const marksBefore = [await marks(A, one), await marks(A, two)];
        const teal = { pinned: true, color: "teal" };
        const first = await merge("a", "c", teal);
        const second = await merge("b", "c", teal);
        const merged = await world(A, [one, two]);

        expect(await undo(first.changeId)).toBe("blocked");
        expect(await world(A, [one, two])).toEqual(merged);

        expect(await undo(second.changeId)).not.toBe("conflict");
        expect(await undo(first.changeId)).not.toBe("conflict");
        expect(await h.links.listTags(A)).toEqual(tagsBefore);
        expect([await marks(A, one), await marks(A, two)]).toEqual(marksBefore);
      });

      it("a delete's undo does not override a later rename of its old address", async () => {
        await save(A, [mention("banking")]);
        const { changeId } = await remove("banking");
        const fresh = await save(A, [mention("banking")]);
        await rename("banking", "finance");
        const after = await world(A, [fresh]);

        expect(await undo(changeId)).toBe("conflict");
        expect(await world(A, [fresh])).toEqual(after);
        expect(await h.tagEdits.currentKey(A, "banking")).toBe("finance");
      });

      it("a delete's undo still works when its own key had an old address that has not moved", async () => {
        const id = await save(A, [mention("a")]);
        await rename("a", "b");
        await save(A, [mention("a")]);
        const { changeId } = await remove("a");
        expect(await undo(changeId)).not.toBe("conflict");
        expect(await h.tagEdits.currentKey(A, "a")).toBe("a");
        expect(await marks(A, id)).toEqual([["b", "stated"]]);
      });
    });

    it("an old key a live tag shadowed at the time is not recorded, so it does not block undo", async () => {
      await save(A, [mention("a")]);
      await rename("a", "b");
      await save(A, [mention("a"), mention("c")]);
      const { changeId } = await merge("b", "c");
      expect(await undo(changeId)).not.toBe("conflict");
      expect(await h.tagEdits.currentKey(A, "a")).toBe("a");
      expect(await h.tagEdits.currentKey(A, "b")).toBe("b");
    });

    describe("merge, rename and delete cancel link-edit receipts naming the old key", () => {
      /** Link one's receipt took x off; link two's took q off. Neither link has either tag now. */
      const receipts = async () => {
        const one = await save(A, [mention("x")]);
        const two = await save(A, [mention("q")]);
        await save(A, [mention("y")]);
        const off = async (id: string, key: string) => {
          const r = await h.edits.applyEdit(
            A,
            id,
            { tags: { expected: [{ key, source: "stated" }], set: [] } },
            at(1),
          );
          if (r === "conflict" || !r?.editId) throw new Error("expected an edit id");
          return r.editId;
        };
        return { one, two, oneEdit: await off(one, "x"), twoEdit: await off(two, "q") };
      };
      const actions: [string, () => Promise<unknown>][] = [
        ["merge", () => merge("x", "y")],
        ["rename", () => rename("x", "z")],
        ["delete", () => remove("x")],
      ];
      for (const [label, act] of actions) {
        it(label, async () => {
          const { one, two, oneEdit, twoEdit } = await receipts();
          await act();
          expect(await h.edits.undoEdit(A, one, oneEdit)).toBe("conflict");
          expect(await marks(A, one)).toEqual([]);
          expect(await h.edits.undoEdit(A, two, twoEdit)).toBe("undone");
          expect(await marks(A, two)).toEqual([["q", "stated"]]);
        });
      }
    });

    it("undo skips a purged link", async () => {
      const live = await save(A, [mention("x"), mention("y")]);
      const gone = await save(A, [mention("x")], at(5));
      const { changeId } = await merge("x", "y");
      expect(await h.links.purgeDeleted(at(6))).toBe(1);
      expect(await undo(changeId)).toEqual({
        tags: [
          { tag: await tag(A, "x"), links: 1 },
          { tag: await tag(A, "y"), links: 1 },
        ],
      });
      expect(await marks(A, live)).toEqual([
        ["x", "stated"],
        ["y", "stated"],
      ]);
      expect(await h.links.get(A, gone)).toBeNull();
    });

    it("undo after the window is null", async () => {
      const id = await save(A, [mention("x")]);
      const { changeId } = await remove("x");
      expect(await h.tagEdits.undoTagChange(A, changeId, at(11))).toBeNull();
      expect(await h.tagEdits.undoTagChange(A, "never-issued", at(0))).toBeNull();
      expect(await marks(A, id)).toEqual([]);
      expect(await undo(changeId)).toMatchObject({ tags: [{ tag: { key: "x" } }] });
    });

    it("undo twice: second is null", async () => {
      const id = await save(A, [mention("x")]);
      const { changeId } = await remove("x");
      expect(await undo(changeId)).toMatchObject({ tags: [{ tag: { key: "x" }, links: 1 }] });
      expect(await undo(changeId)).toBeNull();
      expect(await marks(A, id)).toEqual([["x", "stated"]]);
    });

    it("another owner's same-key tag, links and aliases are untouched by every method", async () => {
      /** Each owner: tags v (once w), x and y on three links, one hidden, and a tag "gone" on a fourth. */
      const setUp = async (owner: string) => {
        const ids = [
          await save(owner, [mention("w"), mention("x")]),
          await save(owner, [mention("x"), mention("y")]),
          await save(owner, [mention("y")], at(5)),
          await save(owner, [mention("gone")]),
        ];
        await rename("w", "v", owner);
        return ids;
      };
      const bIds = await setUp(B);
      await h.links.colorTag(B, "x", "rose");
      // B's pending tag change and a link-edit receipt naming x.
      const bChange = await remove("gone", B);
      const edited = await save(B, [mention("x")]);
      const bEdit = await h.edits.applyEdit(
        B,
        edited,
        { tags: { expected: [{ key: "x", source: "stated" }], set: [] } },
        at(1),
      );
      if (bEdit === "conflict" || !bEdit?.editId) throw new Error("expected an edit id");
      const ids = [...bIds, edited];
      const reach = () => Promise.all(["v", "w", "x", "y"].map((k) => h.tagEdits.currentKey(B, k)));
      const before = { world: await world(B, ids), reach: await reach() };

      await setUp(A);
      expect(await h.tagEdits.tagLinkCounts(A)).toEqual(
        new Map([
          ["v", 1],
          ["x", 2],
          ["y", 1],
          ["gone", 1],
        ]),
      );
      expect(await undo(bChange.changeId)).toBeNull();
      await rename("x", "z");
      const merged = await h.tagEdits.mergeTag(A, {
        from: await tag(A, "z"),
        into: await tag(A, "y"),
        set: settingsOf(await tag(A, "y")),
        at: at(10),
        pruneBefore: at(100000),
      });
      if (typeof merged === "string" || merged === null) throw new Error(`merge: ${merged}`);
      expect(await undo(merged.changeId)).not.toBe("conflict");
      expect(await undo((await remove("v")).changeId)).not.toBe("conflict");
      await remove("y");

      expect({ world: await world(B, ids), reach: await reach() }).toEqual(before);
      expect(await h.edits.undoEdit(B, edited, bEdit.editId)).toBe("undone");
      expect(await undo(bChange.changeId, B)).toEqual({
        tags: [{ tag: expect.objectContaining({ key: "gone" }), links: 1 }],
      });
    });

    it("currentKey prefers a live tag over an alias", async () => {
      await save(A, [mention("a")]);
      await rename("a", "b");
      expect(await h.tagEdits.currentKey(A, "a")).toBe("b");
      await save(A, [mention("a")]);
      expect(await h.tagEdits.currentKey(A, "a")).toBe("a");
      expect(await h.tagEdits.currentKey(B, "a")).toBeNull();
    });
  });
}
