import { beforeEach, describe, expect, it } from "vitest";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { LinkStore } from "./store.js";
import type { LoggedEvent } from "./store-contract.js";
import type { ToolRecord, ToolStore } from "./tool-store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type ToolHarness = {
  store: LinkStore & ToolStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
  /** The owner's log events for one link, in the order they were written, bypassing the stores. */
  eventsOf(owner: string, id: string): MaybeAsync<LoggedEvent[]>;
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
    let eventsOf: ToolHarness["eventsOf"];

    const saveExplore = async (owner: string): Promise<string> =>
      (await store.insertIfAbsent(owner, newLink(++n, at(0)))).link.id;
    const save = async (owner: string): Promise<string> =>
      (
        await store.insertIfAbsent(owner, {
          ...newLink(++n, at(0)),
          intent: "keep",
          intentSource: "stated",
        })
      ).link.id;

    beforeEach(async () => {
      const h = await makeHarness();
      store = h.store;
      eventsOf = h.eventsOf;
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

    describe("intent", () => {
      const keep = { intent: "keep", intentSource: "stated" } as const;
      const explore = { intent: "explore", intentSource: null } as const;
      const intentOf = async (id: string) => {
        const l = await store.get(A, id);
        return { intent: l?.intent, intentSource: l?.intentSource };
      };

      it("writes the intent with the row, only while the intent is still onlyIf", async () => {
        const id = await saveExplore(A);
        const result = await store.updateToolIf(A, id, null, kept(), undefined, {
          set: keep,
          onlyIf: explore,
        });
        expect(result?.applied).toBe(true);
        expect(await intentOf(id)).toEqual(keep);
        const other = await saveExplore(A);
        await store.update(A, other, { intent: "keep", intentSource: "asked" });
        const kept2 = await store.updateToolIf(A, other, null, kept(), undefined, {
          set: keep,
          onlyIf: explore,
        });
        expect(kept2?.applied).toBe(true);
        expect(await store.getTool(A, other)).toEqual(kept());
        expect(await intentOf(other)).toEqual({ intent: "keep", intentSource: "asked" });
      });

      it("writes no intent when the row write is not applied", async () => {
        const id = await saveExplore(A);
        await store.updateToolIf(A, id, null, kept(), undefined, { set: keep, onlyIf: explore });
        const asked = { intent: "keep", intentSource: "asked" } as const;
        const result = await store.updateToolIf(A, id, null, kept({ waitDays: 60 }), undefined, {
          set: asked,
          onlyIf: keep,
        });
        expect(result?.applied).toBe(false);
        expect(await intentOf(id)).toEqual(keep);
      });

      it("puts an explore back only once the row is no longer kept", async () => {
        const id = await saveExplore(A);
        await store.update(A, id, keep);
        await store.updateToolIf(A, id, null, kept());
        await store.updateToolIf(A, id, kept(), kept({ waitDays: 60 }), undefined, {
          set: explore,
          onlyIf: keep,
        });
        expect(await intentOf(id)).toEqual(keep);
        await store.updateToolIf(A, id, kept({ waitDays: 60 }), null, undefined, {
          set: explore,
          onlyIf: keep,
        });
        expect(await intentOf(id)).toEqual(explore);
      });
    });

    describe("a kept tool is always To keep", () => {
      const keep = { intent: "keep", intentSource: "stated" } as const;
      const explore = { intent: "explore", intentSource: "stated" } as const;
      const state = async (id: string) => {
        const l = await store.get(A, id);
        return { tool: await store.getTool(A, id), intent: l?.intent, source: l?.intentSource };
      };

      it("refuses a write of kept over a link that is To explore, changing nothing (Undo of Not handy after Explore it)", async () => {
        const id = await saveExplore(A);
        await store.update(A, id, keep);
        await store.updateToolIf(A, id, null, kept());
        await store.updateToolIf(A, id, kept(), kept({ status: "declined" }));
        await store.update(A, id, explore);
        const before = await state(id);
        const result = await store.updateToolIf(A, id, kept({ status: "declined" }), kept());
        expect(result?.applied).toBe(false);
        expect(await state(id)).toEqual(before);
        expect(before).toMatchObject({ intent: "explore", source: "stated" });
        expect(before.tool?.status).toBe("declined");
      });

      it("refuses a write of kept whose intent move no longer applies, changing nothing", async () => {
        const id = await saveExplore(A);
        await store.update(A, id, explore);
        const before = await state(id);
        const result = await store.updateToolIf(A, id, null, kept(), undefined, {
          set: keep,
          onlyIf: { intent: "explore", intentSource: null },
        });
        expect(result?.applied).toBe(false);
        expect(await state(id)).toEqual(before);
      });

      it("refuses an explore written by a plain update while the tool is kept, changing nothing", async () => {
        const id = await saveExplore(A);
        await store.update(A, id, keep);
        await store.updateToolIf(A, id, null, kept());
        const before = await state(id);
        expect(await store.update(A, id, explore)).toBeNull();
        expect(await state(id)).toEqual(before);
      });
    });

    it("notKeptTool holds only while the row is not kept, for updateIf and updateWithReceipt", async () => {
      const id = await saveExplore(A);
      const patch = { intent: "explore", intentSource: "stated" } as const;
      expect((await store.updateIf(A, id, { notKeptTool: true }, patch))?.applied).toBe(true);
      await store.update(A, id, { intent: "keep", intentSource: "stated" });
      await store.updateToolIf(A, id, null, kept());
      expect((await store.updateIf(A, id, { notKeptTool: true }, patch))?.applied).toBe(false);
      const receipt = await store.updateWithReceipt(A, id, patch, at(5), undefined, undefined, {
        notKeptTool: true,
      });
      expect([receipt?.applied, receipt?.editId]).toEqual([false, null]);
      expect(await store.get(A, id)).toMatchObject({ intent: "keep", intentSource: "stated" });
      await store.updateToolIf(A, id, kept(), kept({ status: "declined" }));
      expect((await store.updateIf(A, id, { notKeptTool: true }, patch))?.applied).toBe(true);
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

    describe("events", () => {
      const T1 = new Date("2026-05-01T10:00:00.000Z");
      const T2 = new Date("2026-05-01T09:00:00.000Z");
      const row = (kind: LoggedEvent["kind"], when: Date) => ({
        kind,
        at: when,
        backfilled: false,
      });

      it("updateToolIf records the events it is given when applied", async () => {
        const id = await save(A);
        await store.updateToolIf(A, id, null, kept(), [{ record: "not_handy", at: T1 }]);
        expect(await eventsOf(A, id)).toEqual([row("not_handy", T1)]);
      });

      it("updateToolIf records nothing when it is not applied", async () => {
        const id = await save(A);
        await store.updateToolIf(A, id, null, kept());
        const result = await store.updateToolIf(A, id, null, kept({ waitDays: 60 }), [
          { record: "not_handy", at: T1 },
        ]);
        expect(result?.applied).toBe(false);
        expect(await eventsOf(A, id)).toEqual([]);
      });

      it("updateToolIf records nothing for another owner's link", async () => {
        const id = await save(A);
        expect(
          await store.updateToolIf(B, id, null, kept(), [{ record: "not_handy", at: T1 }]),
        ).toBeNull();
        expect(await eventsOf(A, id)).toEqual([]);
      });

      it("updateToolIf unrecord removes only the event at its time", async () => {
        const id = await save(A);
        await store.update(A, id, {}, [
          { record: "not_handy", at: T1 },
          { record: "not_handy", at: T2 },
          { record: "opened", at: T2 },
        ]);
        await store.updateToolIf(A, id, null, kept(), [{ unrecord: "not_handy", at: T2 }]);
        expect(await eventsOf(A, id)).toEqual([row("not_handy", T1), row("opened", T2)]);
      });

      it("a failed event write rolls back the tool write", async () => {
        const id = await save(A);
        const bad = [{ record: "nonsense" as LoggedEvent["kind"], at: T1 }];
        await expect(store.updateToolIf(A, id, null, kept(), bad)).rejects.toThrow();
        expect(await store.getTool(A, id)).toBeNull();
        expect(await eventsOf(A, id)).toEqual([]);
      });
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
