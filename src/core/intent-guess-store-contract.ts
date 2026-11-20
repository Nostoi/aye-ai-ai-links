import { beforeEach, describe, expect, it } from "vitest";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { IntentGuesses, LinkRemover, LinkStore } from "./store.js";
import type { ToolRecord, ToolStore } from "./tool-store.js";

type MaybeAsync<T> = T | Promise<T>;

export type GuessRow = { id: string; outcome: string | null; tries: number };

/** What the contract suite needs from a store under test. */
export type GuessHarness = {
  store: LinkStore & ToolStore & LinkRemover & IntentGuesses;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
  /** Put the link in the queue, as the migration does for the links that exist when it runs. */
  queue(owner: string, id: string): MaybeAsync<void>;
  /** The owner's queue rows, ascending by link, bypassing the store's own reads. */
  rows(owner: string): MaybeAsync<GuessRow[]>;
};

const kept = (): ToolRecord => ({
  status: "kept",
  source: "stated",
  since: at(10),
  answeredAt: null,
  waitDays: 30,
});

export function describeIntentGuessContract(
  name: string,
  makeHarness: () => GuessHarness | Promise<GuessHarness>,
): void {
  describe(name, () => {
    let h: GuessHarness;
    let n: number;

    const queued = async (owner: string): Promise<string> => {
      const id = (await h.store.insertIfAbsent(owner, newLink(++n, at(0)))).link.id;
      await h.queue(owner, id);
      return id;
    };
    const intentOf = async (owner: string, id: string) => {
      const l = await h.store.get(owner, id);
      return l && [l.intent, l.intentSource];
    };
    const outcomes = async (owner: string) =>
      Object.fromEntries((await h.rows(owner)).map((r) => [r.id, r.outcome]));

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    describe("guessCandidates", () => {
      it("lists undecided rows of live links across owners, ascending by owner then link, from the cursor, at most `limit`", async () => {
        const a1 = await queued(A);
        const b1 = await queued(B);
        const a2 = await queued(A);
        await h.store.insertIfAbsent(A, newLink(++n, at(0)));
        const all = await h.store.guessCandidates(null, 10);
        expect(all.map((c) => [c.owner, c.id, c.tries])).toEqual([
          [A, a1, 0],
          [A, a2, 0],
          [B, b1, 0],
        ]);
        const page = await h.store.guessCandidates(null, 2);
        expect(page.map((c) => c.id)).toEqual([a1, a2]);
        const rest = await h.store.guessCandidates({ owner: A, id: a2 }, 10);
        expect(rest.map((c) => c.id)).toEqual([b1]);
      });

      it("leaves out decided rows and a deleted link, and lists the deleted link again once restored", async () => {
        const kept1 = await queued(A);
        const failed = await queued(A);
        const gone = await queued(A);
        const open = await queued(A);
        await h.store.recordGuesses(A, [kept1], [kept1]);
        await h.store.recordGuessFailure(A, [failed], 1);
        await h.store.markDeleted(A, gone, at(5));
        expect((await h.store.guessCandidates(null, 10)).map((c) => c.id)).toEqual([open]);
        await h.store.unmarkDeleted(A, gone, at(5));
        expect((await h.store.guessCandidates(null, 10)).map((c) => c.id)).toEqual([gone, open]);
      });
    });

    describe("recordGuesses", () => {
      it("writes keep/inferred for the named links, sets every outcome, and leaves the others To explore", async () => {
        const a = await queued(A);
        const b = await queued(A);
        const c = await queued(A);
        await h.store.recordGuesses(A, [a, b, c], [b]);
        expect(await outcomes(A)).toEqual({ [a]: "not_keep", [b]: "keep", [c]: "not_keep" });
        expect(await intentOf(A, a)).toEqual(["explore", null]);
        expect(await intentOf(A, b)).toEqual(["keep", "inferred"]);
        expect(await intentOf(A, c)).toEqual(["explore", null]);
      });

      it("never overwrites a link someone has spoken for meanwhile, and records it as not written", async () => {
        const stated = await queued(A);
        const guessed = await queued(A);
        const asked = await queued(A);
        await h.store.update(A, stated, { intent: "explore", intentSource: "stated" });
        await h.store.update(A, guessed, { intent: "keep", intentSource: "inferred" });
        await h.store.update(A, asked, { intent: "keep", intentSource: "asked" });
        await h.store.recordGuesses(A, [stated, guessed, asked], [stated, guessed, asked]);
        expect(await intentOf(A, stated)).toEqual(["explore", "stated"]);
        expect(await intentOf(A, guessed)).toEqual(["keep", "inferred"]);
        expect(await intentOf(A, asked)).toEqual(["keep", "asked"]);
        expect(await outcomes(A)).toEqual({
          [stated]: "not_keep",
          [guessed]: "not_keep",
          [asked]: "not_keep",
        });
      });

      it("writes nothing for a deleted link and leaves its row undecided", async () => {
        const id = await queued(A);
        await h.store.markDeleted(A, id, at(5));
        await h.store.recordGuesses(A, [id], [id]);
        expect(await outcomes(A)).toEqual({ [id]: null });
        await h.store.unmarkDeleted(A, id, at(5));
        expect(await intentOf(A, id)).toEqual(["explore", null]);
      });

      it("touches only the owner's rows, and never re-decides a decided row", async () => {
        const mine = await queued(A);
        const theirs = await queued(B);
        await h.store.recordGuesses(A, [mine, theirs], [mine, theirs]);
        expect(await outcomes(B)).toEqual({ [theirs]: null });
        expect(await intentOf(B, theirs)).toEqual(["explore", null]);
        await h.store.recordGuesses(A, [mine], []);
        expect(await outcomes(A)).toEqual({ [mine]: "keep" });
        expect(await intentOf(A, mine)).toEqual(["keep", "inferred"]);
      });
    });

    describe("recordGuessFailure", () => {
      it("adds a try to each undecided row and ends it as failed once it reaches the limit", async () => {
        const a = await queued(A);
        const b = await queued(A);
        await h.store.recordGuessFailure(A, [a, b], 3);
        await h.store.recordGuessFailure(A, [a], 3);
        expect(await h.rows(A)).toEqual([
          { id: a, outcome: null, tries: 2 },
          { id: b, outcome: null, tries: 1 },
        ]);
        await h.store.recordGuessFailure(A, [a], 3);
        expect(await h.rows(A)).toEqual([
          { id: a, outcome: "failed", tries: 3 },
          { id: b, outcome: null, tries: 1 },
        ]);
        expect(await intentOf(A, a)).toEqual(["explore", null]);
        expect((await h.store.guessCandidates(null, 10)).map((c) => [c.id, c.tries])).toEqual([
          [b, 1],
        ]);
      });

      it("leaves a decided row, and another owner's row, alone", async () => {
        const done = await queued(A);
        const theirs = await queued(B);
        await h.store.recordGuesses(A, [done], []);
        await h.store.recordGuessFailure(A, [done, theirs], 3);
        expect(await h.rows(A)).toEqual([{ id: done, outcome: "not_keep", tries: 0 }]);
        expect(await h.rows(B)).toEqual([{ id: theirs, outcome: null, tries: 0 }]);
      });
    });

    describe("revertGuesses", () => {
      it("puts back only the links the pass wrote and that still hold its keep/inferred", async () => {
        const wrote = await queued(A);
        const edited = await queued(A);
        const skipped = await queued(A);
        await h.store.recordGuesses(A, [wrote, edited, skipped], [wrote, edited]);
        await h.store.update(A, edited, { intent: "keep", intentSource: "stated" });
        expect(await h.store.revertGuesses(A)).toBe(1);
        expect(await intentOf(A, wrote)).toEqual(["explore", null]);
        expect(await intentOf(A, edited)).toEqual(["keep", "stated"]);
        expect(await intentOf(A, skipped)).toEqual(["explore", null]);
      });

      it("never touches a link whose tool is kept, nor another owner's", async () => {
        const handy = await queued(A);
        const plain = await queued(A);
        const theirs = await queued(B);
        await h.store.recordGuesses(A, [handy, plain], [handy, plain]);
        await h.store.recordGuesses(B, [theirs], [theirs]);
        await h.store.updateToolIf(A, handy, null, kept());
        expect(await h.store.revertGuesses(A)).toBe(1);
        expect(await intentOf(A, handy)).toEqual(["keep", "inferred"]);
        expect((await h.store.getTool(A, handy))?.status).toBe("kept");
        expect(await intentOf(A, plain)).toEqual(["explore", null]);
        expect(await intentOf(B, theirs)).toEqual(["keep", "inferred"]);
      });
    });
  });
}
