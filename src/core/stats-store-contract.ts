import { beforeEach, describe, expect, it } from "vitest";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { StatsStore } from "./stats-store.js";
import type { LinkRemover, LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. All three share one database. */
export type StatsHarness = {
  links: LinkStore;
  remover: LinkRemover;
  stats: StatsStore;
  /** What `stats.trackingSince()` must answer: the start the store was set up with. */
  start: Date;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

export function describeStatsStoreContract(
  name: string,
  makeHarness: () => StatsHarness | Promise<StatsHarness>,
): void {
  describe(name, () => {
    let h: StatsHarness;
    let n: number;

    const save = async (owner: string): Promise<string> =>
      (await h.links.insertIfAbsent(owner, newLink(++n, at(0)))).link.id;
    const open = (owner: string, id: string, s: number) =>
      h.links.update(owner, id, {}, [{ record: "opened", at: at(s) }]);

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("statsEvents returns only the owner's events of live links, oldest first", async () => {
      const mine = await save(A);
      const theirs = await save(B);
      await open(A, mine, 30);
      await open(A, mine, 10);
      await h.links.update(A, mine, {}, [{ record: "stale", at: at(20) }]);
      await open(B, theirs, 5);

      expect(await h.stats.statsEvents(A)).toEqual([
        { linkId: mine, kind: "opened", at: at(10) },
        { linkId: mine, kind: "stale", at: at(20) },
        { linkId: mine, kind: "opened", at: at(30) },
      ]);
      expect(await h.stats.statsEvents(B)).toEqual([{ linkId: theirs, kind: "opened", at: at(5) }]);
    });

    it("a hidden link's events are left out until restored", async () => {
      const id = await save(A);
      const other = await save(A);
      await open(A, id, 1);
      await open(A, other, 2);

      expect(await h.remover.markDeleted(A, id, at(10))).toBe(true);
      expect(await h.stats.statsEvents(A)).toEqual([{ linkId: other, kind: "opened", at: at(2) }]);

      expect(await h.remover.unmarkDeleted(A, id, at(10))).toBe(true);
      expect(await h.stats.statsEvents(A)).toEqual([
        { linkId: id, kind: "opened", at: at(1) },
        { linkId: other, kind: "opened", at: at(2) },
      ]);
    });

    it("a purged link's events are gone", async () => {
      const id = await save(A);
      await open(A, id, 1);
      await h.remover.markDeleted(A, id, at(10));
      expect(await h.remover.purgeDeleted(at(20))).toBe(1);
      expect(await h.stats.statsEvents(A)).toEqual([]);
    });

    it("trackingSince is the stored start", async () => {
      expect(await h.stats.trackingSince()).toEqual(h.start);
    });
  });
}
