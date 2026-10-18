import { beforeEach, describe, expect, it } from "vitest";
import type { LinkCheck, LinkCheckStore } from "./link-check-store.js";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. `links` and `checks` share one database. */
export type CheckHarness = {
  links: LinkStore;
  checks: LinkCheckStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

const row = (over: Partial<LinkCheck> = {}): LinkCheck => ({
  checkedAt: at(100),
  result: "dead",
  detail: "http:404",
  firstDeadAt: at(100),
  flaggedAt: null,
  stillWorksAt: null,
  ...over,
});

export function describeLinkCheckStoreContract(
  name: string,
  makeHarness: () => CheckHarness | Promise<CheckHarness>,
): void {
  describe(name, () => {
    let h: CheckHarness;
    let n: number;

    const save = async (owner: string, savedAt = at(0)): Promise<string> =>
      (await h.links.insertIfAbsent(owner, newLink(++n, savedAt))).link.id;
    const dueIds = async (active: Date, archived: Date, limit = 50) =>
      (await h.checks.dueChecks({ active, archived }, limit)).map((d) => [d.owner, d.linkId]);
    const justBefore = (d: Date) => new Date(d.getTime() - 1);

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("has no row for a new link", async () => {
      const id = await save(A);
      expect(await h.checks.getCheck(A, id)).toBeNull();
      expect(await h.checks.listChecks(A)).toEqual(new Map());
    });

    it("creates a row only while there is none, and reads it back", async () => {
      const id = await save(A);
      expect(await h.checks.updateCheckIf(A, id, null, row())).toEqual({
        check: row(),
        applied: true,
      });
      expect(await h.checks.updateCheckIf(A, id, null, row({ result: "alive" }))).toEqual({
        check: row(),
        applied: false,
      });
      expect(await h.checks.getCheck(A, id)).toEqual(row());
    });

    it("replaces a row only while it still equals the expected row, field by field", async () => {
      const id = await save(A);
      const current = row({ flaggedAt: at(900), stillWorksAt: at(50) });
      await h.checks.updateCheckIf(A, id, null, current);
      const stale: (LinkCheck | null)[] = [
        null,
        { ...current, checkedAt: at(101) },
        { ...current, result: "unknown" },
        { ...current, detail: "http:410" },
        { ...current, firstDeadAt: null },
        { ...current, flaggedAt: null },
        { ...current, stillWorksAt: null },
      ];
      for (const expected of stale) {
        expect(await h.checks.updateCheckIf(A, id, expected, row({ result: "alive" }))).toEqual({
          check: current,
          applied: false,
        });
      }
      const next = row({ checkedAt: at(200), result: "alive", detail: null, firstDeadAt: null });
      expect(await h.checks.updateCheckIf(A, id, current, next)).toEqual({
        check: next,
        applied: true,
      });
      expect(await h.checks.getCheck(A, id)).toEqual(next);
    });

    it("writes nothing when the expected row is set but the link has no row", async () => {
      const id = await save(A);
      expect(await h.checks.updateCheckIf(A, id, row(), row({ result: "alive" }))).toEqual({
        check: null,
        applied: false,
      });
      expect(await h.checks.getCheck(A, id)).toBeNull();
    });

    it("refuses a row flagged without a first dead check, or with an invalid date, leaving the row as it was", async () => {
      const id = await save(A);
      await h.checks.updateCheckIf(A, id, null, row());
      const bad = [
        row({ flaggedAt: at(900), firstDeadAt: null }),
        row({ checkedAt: new Date(Number.NaN) }),
      ];
      for (const next of bad) {
        await expect(h.checks.updateCheckIf(A, id, row(), next)).rejects.toThrow();
        expect(await h.checks.getCheck(A, id)).toEqual(row());
      }
    });

    it("lists every row of the owner's, by link id", async () => {
      const first = await save(A);
      const second = await save(A);
      await save(A);
      const theirs = await save(B);
      await h.checks.updateCheckIf(A, first, null, row());
      await h.checks.updateCheckIf(A, second, null, row({ result: "unknown", detail: "timeout" }));
      await h.checks.updateCheckIf(B, theirs, null, row());
      expect(await h.checks.listChecks(A)).toEqual(
        new Map([
          [first, row()],
          [second, row({ result: "unknown", detail: "timeout" })],
        ]),
      );
    });

    it("never reads or writes another owner's row", async () => {
      const id = await save(A);
      await h.checks.updateCheckIf(A, id, null, row());
      expect(await h.checks.getCheck(B, id)).toBeNull();
      expect(await h.checks.listChecks(B)).toEqual(new Map());
      expect(await h.checks.updateCheckIf(B, id, row(), row({ result: "alive" }))).toBeNull();
      expect(await h.checks.updateCheckIf(B, id, null, row({ result: "alive" }))).toBeNull();
      expect(await h.checks.getCheck(A, id)).toEqual(row());
    });

    it("yields null for an id never issued, never an error", async () => {
      await save(A);
      for (const id of ["", "no-such-id", "0", "-1", "99999", "1e3"]) {
        expect(await h.checks.getCheck(A, id)).toBeNull();
        expect(await h.checks.updateCheckIf(A, id, null, row())).toBeNull();
      }
    });

    describe("dueChecks", () => {
      it("counts a link with no row as last checked when it was saved, and returns its url", async () => {
        const id = await save(A, at(50));
        expect(
          await h.checks.dueChecks({ active: justBefore(at(50)), archived: at(1000) }, 10),
        ).toEqual([]);
        expect(await h.checks.dueChecks({ active: at(50), archived: at(0) }, 10)).toEqual([
          { owner: A, linkId: id, url: "https://ex.com/1" },
        ]);
      });

      it("judges a checked link by its last check, not by when it was saved", async () => {
        const id = await save(A, at(0));
        await h.checks.updateCheckIf(A, id, null, row({ checkedAt: at(100) }));
        expect(await dueIds(justBefore(at(100)), at(1000))).toEqual([]);
        expect(await dueIds(at(100), at(0))).toEqual([[A, id]]);
      });

      it("uses the archived cutoff for an archived link and the active cutoff for an active one", async () => {
        const active = await save(A);
        const archived = await save(A);
        await h.links.update(A, archived, { state: "archived" });
        for (const id of [active, archived]) {
          await h.checks.updateCheckIf(A, id, null, row({ checkedAt: at(100) }));
        }
        expect(await dueIds(at(100), justBefore(at(100)))).toEqual([[A, active]]);
        expect(await dueIds(justBefore(at(100)), at(100))).toEqual([[A, archived]]);
      });

      it("lists both owners' due links, oldest last check first, ties by id, up to the limit", async () => {
        const a1 = await save(A, at(30));
        const b1 = await save(B, at(10));
        const a2 = await save(A, at(10));
        const a3 = await save(A, at(20));
        await h.checks.updateCheckIf(A, a3, null, row({ checkedAt: at(5) }));
        expect(await dueIds(at(1000), at(1000), 3)).toEqual([
          [A, a3],
          [B, b1],
          [A, a2],
        ]);
        expect(await dueIds(at(1000), at(1000))).toEqual([
          [A, a3],
          [B, b1],
          [A, a2],
          [A, a1],
        ]);
      });
    });

    it("claimSurfaced with exceptGone skips a flagged link, writing nothing, and claims the rest", async () => {
      const flagged = await save(A);
      const dead = await save(A);
      const plain = await save(A);
      await h.checks.updateCheckIf(A, flagged, null, row({ flaggedAt: at(900) }));
      await h.checks.updateCheckIf(A, dead, null, row());
      const when = { at: at(1000), notSurfacedAfter: at(1000), now: at(1000) };
      const claimed = await h.links.claimSurfaced(A, [flagged, dead, plain], {
        ...when,
        exceptGone: true,
      });
      expect(claimed.map((c) => c.link.id)).toEqual([dead, plain]);
      expect((await h.links.get(A, flagged))?.lastSurfacedAt).toBeNull();
      expect((await h.links.claimSurfaced(A, [flagged], when)).map((c) => c.link.id)).toEqual([
        flagged,
      ]);
    });
  });
}
