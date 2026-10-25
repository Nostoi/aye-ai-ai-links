import { beforeEach, describe, expect, it } from "vitest";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { LinkRemover, LinkStore } from "./store.js";
import { mention } from "./tag-edit-store-contract.js";
import type { TagSuggestStore } from "./tag-suggest-store.js";
import type { LinkTag } from "./types.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type TagSuggestHarness = {
  links: LinkStore & LinkRemover;
  tagSuggest: TagSuggestStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

export function describeTagSuggestStoreContract(
  name: string,
  makeHarness: () => TagSuggestHarness | Promise<TagSuggestHarness>,
): void {
  describe(name, () => {
    let h: TagSuggestHarness;
    let n: number;

    /** A new link of `owner` with these tag keys, hidden by a delete at `hiddenAt` when given. */
    const save = async (owner: string, keys: string[], hiddenAt?: Date): Promise<string> => {
      const tags: LinkTag[] = keys.map((k) => mention(k));
      const { link } = await h.links.insertIfAbsent(owner, { ...newLink(++n, at(0)), tags });
      if (hiddenAt) expect(await h.links.markDeleted(owner, link.id, hiddenAt)).toBe(true);
      return link.id;
    };

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("sharedPairs lists each pair on a live link once, sorted", async () => {
      await save(A, ["y", "x", "z"]);
      await save(A, ["x", "y"]);
      await save(A, ["w"]);
      const pairs = await h.tagSuggest.sharedPairs(A);
      expect([...pairs].sort()).toEqual([
        ["x", "y"],
        ["x", "z"],
        ["y", "z"],
      ]);
    });

    it("sharedPairs ignores a hidden link, so a pair shared only there is not shared", async () => {
      await save(A, ["x", "y"], at(5));
      await save(A, ["x", "z"]);
      expect(await h.tagSuggest.sharedPairs(A)).toEqual([["x", "z"]]);
    });

    it("sharedPairs never shows another owner's links", async () => {
      await save(B, ["x", "y"]);
      await save(A, ["x"]);
      expect(await h.tagSuggest.sharedPairs(A)).toEqual([]);
      expect(await h.tagSuggest.sharedPairs(B)).toEqual([["x", "y"]]);
      expect(await h.tagSuggest.sharedPairs("nobody")).toEqual([]);
    });

    it("dismissPair stores the keys sorted whichever order they arrive in", async () => {
      await h.tagSuggest.dismissPair(A, "y", "x", at(1));
      await h.tagSuggest.dismissPair(A, "b", "c", at(1));
      expect([...(await h.tagSuggest.dismissedPairs(A))].sort()).toEqual([
        ["b", "c"],
        ["x", "y"],
      ]);
    });

    it("dismissing twice, in either order, keeps one pair and does not throw", async () => {
      await h.tagSuggest.dismissPair(A, "x", "y", at(1));
      await h.tagSuggest.dismissPair(A, "y", "x", at(2));
      expect(await h.tagSuggest.dismissedPairs(A)).toEqual([["x", "y"]]);
    });

    it("undismissPair removes the pair given in either order, and a missing one is harmless", async () => {
      await h.tagSuggest.dismissPair(A, "x", "y", at(1));
      await h.tagSuggest.dismissPair(A, "p", "q", at(1));
      await h.tagSuggest.undismissPair(A, "y", "x");
      await h.tagSuggest.undismissPair(A, "m", "n");
      expect(await h.tagSuggest.dismissedPairs(A)).toEqual([["p", "q"]]);
    });

    it("stores a dismissal whichever way the keys sort as UTF-8 bytes, and undismiss removes it", async () => {
      await h.tagSuggest.dismissPair(A, "\u{1F600} art", "ａ art", at(1));
      expect(await h.tagSuggest.dismissedPairs(A)).toEqual([["\u{1F600} art", "ａ art"]]);
      await h.tagSuggest.undismissPair(A, "ａ art", "\u{1F600} art");
      expect(await h.tagSuggest.dismissedPairs(A)).toEqual([]);
    });

    it("dismissals are per owner", async () => {
      await h.tagSuggest.dismissPair(B, "x", "y", at(1));
      expect(await h.tagSuggest.dismissedPairs(A)).toEqual([]);
      await h.tagSuggest.dismissPair(A, "x", "y", at(1));
      await h.tagSuggest.undismissPair(B, "x", "y");
      expect(await h.tagSuggest.dismissedPairs(A)).toEqual([["x", "y"]]);
      expect(await h.tagSuggest.dismissedPairs(B)).toEqual([]);
    });
  });
}
