import { beforeEach, describe, expect, it } from "vitest";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { StatsReading, StatsReadingStore } from "./stats-reading-store.js";
import type { LinkRemover, LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. All three share one database. */
export type StatsReadingHarness = {
  links: LinkStore;
  remover: LinkRemover;
  readings: StatsReadingStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

const reading = (s: number, text = `reading ${s}`): StatsReading => ({
  text,
  writtenBy: "model-x",
  writtenAt: at(s),
  inputHash: `hash-${s}`,
});

export function describeStatsReadingStoreContract(
  name: string,
  makeHarness: () => StatsReadingHarness | Promise<StatsReadingHarness>,
): void {
  describe(name, () => {
    let h: StatsReadingHarness;
    let n: number;

    const save = async (owner: string): Promise<string> =>
      (await h.links.insertIfAbsent(owner, newLink(++n, at(0)))).link.id;

    const saveAt = async (owner: string, s: number): Promise<string> =>
      (await h.links.insertIfAbsent(owner, newLink(++n, at(s)))).link.id;

    /** A reading written at 10 beside a link saved at 0, then that link deleted and a new one saved at 20. */
    const hide = async (): Promise<void> => {
      const old = await saveAt(A, 0);
      await h.readings.putReadingIf(A, null, reading(10));
      await h.remover.markDeleted(A, old, at(15));
      await saveAt(A, 20);
    };

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("putReadingIf refuses a stale expectation", async () => {
      await save(A);
      expect(await h.readings.putReadingIf(A, null, reading(10))).toBe(true);

      expect(await h.readings.putReadingIf(A, null, reading(20))).toBe(false);
      expect(await h.readings.putReadingIf(A, at(5), reading(20))).toBe(false);
      expect(await h.readings.getReading(A)).toEqual(reading(10));

      expect(await h.readings.putReadingIf(A, at(10), reading(20))).toBe(true);
      expect(await h.readings.getReading(A)).toEqual(reading(20));
    });

    it("readingCandidates lists an owner with no reading", async () => {
      await save(A);
      expect(await h.readings.readingCandidates(at(100))).toEqual([A]);
    });

    it("readingCandidates skips an owner whose reading is fresh", async () => {
      await save(A);
      await save(B);
      await h.readings.putReadingIf(A, null, reading(50));
      await h.readings.putReadingIf(B, null, reading(100));

      expect(await h.readings.readingCandidates(at(49))).toEqual([]);
      // Written at the cutoff counts as due.
      expect(await h.readings.readingCandidates(at(50))).toEqual([A]);
      expect((await h.readings.readingCandidates(at(100))).sort()).toEqual([A, B].sort());
    });

    it("readingCandidates skips an owner with no live links", async () => {
      const gone = await save(A);
      await save(B);
      await h.remover.markDeleted(A, gone, at(10));
      expect(await h.readings.readingCandidates(at(100))).toEqual([B]);
    });

    it("getReading is the owner's own", async () => {
      await save(A);
      await save(B);
      await h.readings.putReadingIf(A, null, reading(10, "mine"));
      expect(await h.readings.getReading(B)).toBeNull();
      await h.readings.putReadingIf(B, null, reading(11, "theirs"));
      expect((await h.readings.getReading(A))?.text).toBe("mine");
      expect((await h.readings.getReading(B))?.text).toBe("theirs");
    });

    it("getReading is null once the owner's last link is deleted, and back after Undo", async () => {
      const id = await save(A);
      await h.readings.putReadingIf(A, null, reading(10));

      await h.remover.markDeleted(A, id, at(20));
      expect(await h.readings.getReading(A)).toBeNull();

      await h.remover.unmarkDeleted(A, id, at(20));
      expect(await h.readings.getReading(A)).toEqual(reading(10));
    });

    it("a reading is hidden once every live link was saved after it", async () => {
      await hide();
      expect(await h.readings.getReading(A)).toBeNull();
    });

    it("a reading stays visible while one live link was saved before it", async () => {
      await saveAt(A, 0);
      await hide();
      expect(await h.readings.getReading(A)).toEqual(reading(10));
    });

    it("readingCandidates lists an owner whose reading is hidden, even when it is recent", async () => {
      await hide();
      expect(await h.readings.readingCandidates(at(5))).toEqual([A]);
    });

    it("putReadingIf with no expectation replaces a hidden reading", async () => {
      await hide();
      expect(await h.readings.putReadingIf(A, null, reading(30))).toBe(true);
      expect(await h.readings.getReading(A)).toEqual(reading(30));
    });

    it("putReadingIf with no expectation still refuses over a visible reading", async () => {
      await saveAt(A, 0);
      await h.readings.putReadingIf(A, null, reading(10));
      await saveAt(A, 20);
      expect(await h.readings.putReadingIf(A, null, reading(30))).toBe(false);
      expect(await h.readings.getReading(A)).toEqual(reading(10));
    });

    it("putReadingIf writes nothing when the owner has no live link", async () => {
      const id = await save(A);
      await h.remover.markDeleted(A, id, at(20));

      expect(await h.readings.putReadingIf(A, null, reading(30))).toBe(false);

      await h.remover.unmarkDeleted(A, id, at(20));
      expect(await h.readings.getReading(A)).toBeNull();
    });

    it("putReadingIf replacing a reading writes nothing when the owner has no live link", async () => {
      const id = await save(A);
      await h.readings.putReadingIf(A, null, reading(10));
      await h.remover.markDeleted(A, id, at(20));

      expect(await h.readings.putReadingIf(A, at(10), reading(30))).toBe(false);

      await h.remover.unmarkDeleted(A, id, at(20));
      expect(await h.readings.getReading(A)).toEqual(reading(10));
    });

    it("putReadingIf replacing a reading changes only that owner's", async () => {
      await save(A);
      await save(B);
      await h.readings.putReadingIf(A, null, reading(10, "a-old"));
      await h.readings.putReadingIf(B, null, reading(10, "b-old"));

      expect(await h.readings.putReadingIf(B, at(10), reading(30, "b-new"))).toBe(true);

      expect(await h.readings.getReading(B)).toEqual(reading(30, "b-new"));
      expect(await h.readings.getReading(A)).toEqual(reading(10, "a-old"));
    });
  });
}
