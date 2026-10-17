import { beforeEach, describe, expect, it } from "vitest";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { LinkStore } from "./store.js";
import type { ToolRecord, ToolStore } from "./tool-store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type ToolHarness = {
  store: LinkStore & ToolStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

const kept = (over: Partial<ToolRecord> = {}): ToolRecord => ({
  status: "kept",
  source: "stated",
  since: at(10),
  answeredAt: null,
  waitDays: 30,
  ...over,
});

export function describeToolStoreContract(
  name: string,
  makeHarness: () => ToolHarness | Promise<ToolHarness>,
): void {
  describe(name, () => {
    let store: LinkStore & ToolStore;
    let n: number;

    const save = async (owner: string): Promise<string> =>
      (await store.insertIfAbsent(owner, newLink(++n, at(0)))).link.id;

    beforeEach(async () => {
      const h = await makeHarness();
      store = h.store;
      await h.addOwner(A);
      await h.addOwner(B);
      n = 0;
    });

    it("has no row for a new link", async () => {
      const id = await save(A);
      expect(await store.getTool(A, id)).toBeNull();
      expect(await store.listTools(A)).toEqual(new Map());
    });

    it("creates a row only while there is none, and reads it back", async () => {
      const id = await save(A);
      expect(await store.updateToolIf(A, id, null, kept())).toEqual({
        tool: kept(),
        applied: true,
      });
      expect(await store.updateToolIf(A, id, null, kept({ source: "asked" }))).toEqual({
        tool: kept(),
        applied: false,
      });
      expect(await store.getTool(A, id)).toEqual(kept());
    });

    it("replaces a row only while it still equals the expected row, field by field", async () => {
      const id = await save(A);
      const answered = kept({ answeredAt: at(20), waitDays: 60 });
      await store.updateToolIf(A, id, null, answered);
      const stale: (ToolRecord | null)[] = [
        null,
        { ...answered, status: "suggested" },
        { ...answered, source: "asked" },
        { ...answered, since: at(11) },
        { ...answered, answeredAt: null },
        { ...answered, answeredAt: at(21) },
        { ...answered, waitDays: 30 },
      ];
      for (const expected of stale) {
        expect(await store.updateToolIf(A, id, expected, kept({ status: "declined" }))).toEqual({
          tool: answered,
          applied: false,
        });
      }
      const next = kept({ answeredAt: at(30), waitDays: 120 });
      expect(await store.updateToolIf(A, id, answered, next)).toEqual({
        tool: next,
        applied: true,
      });
      expect(await store.getTool(A, id)).toEqual(next);
    });

    it("deletes a row only while it equals the expected row", async () => {
      const id = await save(A);
      await store.updateToolIf(A, id, null, kept());
      expect(await store.updateToolIf(A, id, kept({ waitDays: 60 }), null)).toEqual({
        tool: kept(),
        applied: false,
      });
      expect(await store.getTool(A, id)).toEqual(kept());
      expect(await store.updateToolIf(A, id, kept(), null)).toEqual({ tool: null, applied: true });
      expect(await store.getTool(A, id)).toBeNull();
      expect(await store.listTools(A)).toEqual(new Map());
      expect(await store.updateToolIf(A, id, null, null)).toEqual({ tool: null, applied: true });
    });

    it("lists every row of the owner's, by link id", async () => {
      const first = await save(A);
      const second = await save(A);
      await save(A);
      const theirs = await save(B);
      await store.updateToolIf(A, first, null, kept());
      await store.updateToolIf(A, second, null, kept({ status: "suggested", source: "inferred" }));
      await store.updateToolIf(B, theirs, null, kept());
      expect(await store.listTools(A)).toEqual(
        new Map([
          [first, kept()],
          [second, kept({ status: "suggested", source: "inferred" })],
        ]),
      );
    });

    it("never reads or writes another owner's row", async () => {
      const id = await save(A);
      await store.updateToolIf(A, id, null, kept());
      expect(await store.getTool(B, id)).toBeNull();
      expect(await store.listTools(B)).toEqual(new Map());
      expect(await store.updateToolIf(B, id, kept(), kept({ status: "declined" }))).toBeNull();
      expect(await store.updateToolIf(B, id, null, kept({ status: "declined" }))).toBeNull();
      expect(await store.updateToolIf(B, id, kept(), null)).toBeNull();
      expect(await store.getTool(A, id)).toEqual(kept());
    });

    it("yields null for an id never issued, never an error", async () => {
      await save(A);
      for (const id of ["", "no-such-id", "0", "-1", "99999", "1e3"]) {
        expect(await store.getTool(A, id)).toBeNull();
        expect(await store.updateToolIf(A, id, null, kept())).toBeNull();
        expect(await store.updateToolIf(A, id, kept(), null)).toBeNull();
      }
    });

    it("claimSurfaced with exceptKeptTools skips a kept tool, writing nothing, and claims the rest", async () => {
      const keptId = await save(A);
      const suggested = await save(A);
      const plain = await save(A);
      await store.updateToolIf(A, keptId, null, kept());
      await store.updateToolIf(
        A,
        suggested,
        null,
        kept({ status: "suggested", source: "inferred" }),
      );
      const when = { at: at(100), notSurfacedAfter: at(100), now: at(100) };
      const claimed = await store.claimSurfaced(A, [keptId, suggested, plain], {
        ...when,
        exceptKeptTools: true,
      });
      expect(claimed.map((c) => c.link.id)).toEqual([suggested, plain]);
      expect((await store.get(A, keptId))?.lastSurfacedAt).toBeNull();
      expect((await store.claimSurfaced(A, [keptId], when)).map((c) => c.link.id)).toEqual([
        keptId,
      ]);
    });
  });
}
