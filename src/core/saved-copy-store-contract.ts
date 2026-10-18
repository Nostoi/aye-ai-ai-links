import { beforeEach, describe, expect, it } from "vitest";
import type { LinkCheck, LinkCheckStore } from "./link-check-store.js";
import {
  type CopyDraft,
  copyLimits,
  type SavedCopyMaintenance,
  type SavedCopyReader,
  type SavedCopyUsage,
  type SavedCopyWriter,
} from "./saved-copy.js";
import type { SnapshotStore } from "./snapshot-store.js";
import { A, at, B, newLink, record } from "./snapshot-store-contract.js";
import type { LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. All stores share one database. */
export type CopyHarness = {
  links: LinkStore & SnapshotStore;
  checks: LinkCheckStore;
  // Task 5 widens the Pick with "pendingCopyImages" | "unfinishedCopies".
  copies: Pick<SavedCopyWriter, "saveCopy" | "recordNoCopy"> &
    SavedCopyReader &
    SavedCopyUsage &
    Pick<SavedCopyMaintenance, "backfillCandidates">;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
  /** Make the folder unusable for writes (the next write returns "unavailable"). */
  breakFolder(): MaybeAsync<void>;
};

const LIMITS = copyLimits(10_000);
const N = "0123456789abcdef0123456789abcdef";
const bytes = (s: string) => Buffer.byteLength(s);
const draft = (markdown: string, n = 0): CopyDraft => ({
  markdown,
  imageUrls: [...Array(n)].map((_, i) => `https://img.example/${i + 1}.png`),
  nonce: N,
});
const flagged = (): LinkCheck => ({
  checkedAt: at(100),
  result: "dead",
  detail: "http:404",
  firstDeadAt: at(100),
  flaggedAt: at(1),
  stillWorksAt: null,
});

export function describeSavedCopyStoreContract(
  name: string,
  makeHarness: () => CopyHarness | Promise<CopyHarness>,
): void {
  describe(name, () => {
    let h: CopyHarness;
    let n: number;

    const save = async (owner: string): Promise<string> =>
      (await h.links.insertIfAbsent(owner, newLink(++n, at(0)))).link.id;
    const snapshotOk = async (owner: string, id: string, text: string | null = "body") => {
      const lease = await h.links.leaseSnapshot(owner, id, at(1), at(100));
      if (!lease) throw new Error("expected a lease");
      await h.links.recordSnapshot(owner, id, lease.claim, record({ text }));
    };
    const flag = async (owner: string, id: string) => {
      await h.checks.updateCheckIf(owner, id, null, flagged());
    };
    const candidates = async (afterId: string | null = null, limit = 50, retryNoRoom = false) =>
      (await h.copies.backfillCandidates(afterId, limit, { retryNoRoom })).map((c) => [
        c.owner,
        c.linkId,
      ]);

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("saves a copy and reads it back", async () => {
      const id = await save(A);
      expect(await h.copies.saveCopy(A, id, draft("héllo"), LIMITS, at(5))).toBe("saved");
      expect(await h.copies.copyInfo(A, [id])).toEqual(new Map([[id, { madeAt: at(5) }]]));
      expect(await h.copies.readCopy(A, id)).toEqual({
        markdown: "héllo",
        madeAt: at(5),
        finished: true,
        nonce: null,
        images: new Map(),
      });
      expect(await h.copies.usedBytes()).toBe(bytes("héllo"));
    });

    it("writes once: a second save finds the first", async () => {
      const id = await save(A);
      await h.copies.saveCopy(A, id, draft("first"), LIMITS, at(5));
      expect(await h.copies.saveCopy(A, id, draft("second"), LIMITS, at(6))).toBe("exists");
      expect((await h.copies.readCopy(A, id)) as { markdown: string }).toMatchObject({
        markdown: "first",
      });
    });

    it("records why there is no copy, and then saves nothing", async () => {
      const id = await save(A);
      expect(await h.copies.recordNoCopy(A, id, "none")).toBe(true);
      expect(await h.copies.saveCopy(A, id, draft("x"), LIMITS, at(5))).toBe("exists");
      expect(await h.copies.copyInfo(A, [id])).toEqual(new Map());
      expect(await h.copies.readCopy(A, id)).toBeNull();
      expect(await h.copies.recordNoCopy(A, id, "none")).toBe(false);
    });

    it("replaces a no_room row when there is room later", async () => {
      const id = await save(A);
      const tight = { ...LIMITS, totalBytes: 2 };
      expect(await h.copies.saveCopy(A, id, draft("three"), tight, at(5))).toBe("no_room");
      expect(await h.copies.copyInfo(A, [id])).toEqual(new Map());
      expect(await h.copies.usedBytes()).toBe(0);
      expect(await h.copies.saveCopy(A, id, draft("three"), LIMITS, at(6))).toBe("saved");
      expect(await h.copies.usedBytes()).toBe(5);
    });

    it("lets a no_room row be recorded as no copy", async () => {
      const id = await save(A);
      await h.copies.saveCopy(A, id, draft("three"), { ...LIMITS, totalBytes: 2 }, at(5));
      expect(await h.copies.recordNoCopy(A, id, "none")).toBe(true);
      expect(await h.copies.saveCopy(A, id, draft("three"), LIMITS, at(6))).toBe("exists");
    });

    it("refuses a copy over the per-copy cap, and keeps that answer", async () => {
      const id = await save(A);
      const small = { ...LIMITS, copyBytes: bytes("three") - 1 };
      expect(await h.copies.saveCopy(A, id, draft("three"), small, at(5))).toBe("too_large");
      expect(await h.copies.copyInfo(A, [id])).toEqual(new Map());
      expect(await h.copies.readCopy(A, id)).toBeNull();
      expect(await h.copies.usedBytes()).toBe(0);
      expect(await h.copies.saveCopy(A, id, draft("three"), LIMITS, at(6))).toBe("exists");
    });

    it("keeps existing copies when full", async () => {
      const one = await save(A);
      const two = await save(A);
      await h.copies.saveCopy(A, one, draft("kept"), LIMITS, at(5));
      const before = await h.copies.readCopy(A, one);
      const full = { ...LIMITS, totalBytes: (await h.copies.usedBytes()) + 1 };
      expect(await h.copies.saveCopy(A, two, draft("tw"), full, at(6))).toBe("no_room");
      expect(await h.copies.readCopy(A, one)).toEqual(before);
    });

    it("lets only one of two saves have the last bytes", async () => {
      const one = await save(A);
      const two = await save(B);
      const tight = { ...LIMITS, totalBytes: 1000 };
      const md = "a".repeat(600);
      const results = await Promise.all([
        h.copies.saveCopy(A, one, draft(md), tight, at(5)),
        h.copies.saveCopy(B, two, draft(md), tight, at(5)),
      ]);
      expect([...results].sort()).toEqual(["no_room", "saved"]);
      expect(await h.copies.usedBytes()).toBeLessThanOrEqual(1000);
    });

    it("lets only one of two saves of the same link win", async () => {
      const id = await save(A);
      const results = await Promise.all([
        h.copies.saveCopy(A, id, draft("one"), LIMITS, at(5)),
        h.copies.saveCopy(A, id, draft("two"), LIMITS, at(5)),
      ]);
      expect([...results].sort()).toEqual(["exists", "saved"]);
    });

    it("keeps owners apart, and treats unknown ids as not found", async () => {
      const id = await save(A);
      expect(await h.copies.saveCopy(B, id, draft("x"), LIMITS, at(5))).toBeNull();
      expect(await h.copies.recordNoCopy(B, id, "none")).toBe(false);
      expect(await h.copies.copyInfo(A, [id])).toEqual(new Map());
      await h.copies.saveCopy(A, id, draft("mine"), LIMITS, at(5));
      expect(await h.copies.copyInfo(B, [id])).toEqual(new Map());
      expect(await h.copies.readCopy(B, id)).toBeNull();
      expect(await h.copies.copyImage(B, id, 1)).toBeNull();
      for (const bad of ["999999", "abc"]) {
        expect(await h.copies.saveCopy(A, bad, draft("x"), LIMITS, at(5))).toBeNull();
        expect(await h.copies.recordNoCopy(A, bad, "none")).toBe(false);
        expect(await h.copies.copyInfo(A, [bad])).toEqual(new Map());
        expect(await h.copies.readCopy(A, bad)).toBeNull();
      }
    });

    it("answers unavailable and writes no row when the folder is unusable", async () => {
      const id = await save(A);
      await h.breakFolder();
      expect(await h.copies.saveCopy(A, id, draft("x"), LIMITS, at(5))).toBe("unavailable");
      expect(await h.copies.usedBytes()).toBe(0);
      expect(await h.copies.recordNoCopy(A, id, "none")).toBe(true);
    });

    it("keeps a draft with images unfinished", async () => {
      const id = await save(A);
      expect(await h.copies.saveCopy(A, id, draft("pic", 2), LIMITS, at(5))).toBe("saved");
      expect(await h.copies.readCopy(A, id)).toEqual({
        markdown: "pic",
        madeAt: at(5),
        finished: false,
        nonce: N,
        images: new Map(),
      });
      expect(await h.copies.usedBytes()).toBe(bytes("pic"));
    });

    describe("backfillCandidates", () => {
      it("offers links with a readable snapshot and no row", async () => {
        const a = await save(A);
        const b = await save(B);
        await snapshotOk(A, a);
        await snapshotOk(B, b);
        expect(await candidates()).toEqual([
          [A, a],
          [B, b],
        ]);
        expect(await h.copies.backfillCandidates(null, 50, { retryNoRoom: false })).toEqual([
          { owner: A, linkId: a, url: "https://ex.com/1" },
          { owner: B, linkId: b, url: "https://ex.com/2" },
        ]);
      });

      it("skips links without snapshot text, with a pending snapshot, with a row or gone", async () => {
        const noText = await save(A);
        await save(A); // its snapshot stays pending
        const hasRow = await save(A);
        const dead = await save(A);
        const good = await save(A);
        await snapshotOk(A, noText, null);
        await snapshotOk(A, hasRow);
        await snapshotOk(A, dead);
        await snapshotOk(A, good);
        const okRow = await save(A);
        const tooBig = await save(A);
        await snapshotOk(A, okRow);
        await snapshotOk(A, tooBig);
        await h.copies.saveCopy(A, okRow, draft("x"), LIMITS, at(5));
        await h.copies.saveCopy(A, tooBig, draft("xx"), { ...LIMITS, copyBytes: 1 }, at(5));
        await h.copies.recordNoCopy(A, hasRow, "none");
        await flag(A, dead);
        expect(await candidates()).toEqual([[A, good]]);
      });

      it("offers a no_room link only when retrying", async () => {
        const id = await save(A);
        await snapshotOk(A, id);
        await h.copies.saveCopy(A, id, draft("three"), { ...LIMITS, totalBytes: 2 }, at(5));
        expect(await candidates()).toEqual([]);
        expect(await candidates(null, 50, true)).toEqual([[A, id]]);
      });

      it("pages by id and caps by limit", async () => {
        const ids = [await save(A), await save(A), await save(A)];
        for (const id of ids) await snapshotOk(A, id);
        expect(await candidates(null, 2)).toEqual([
          [A, ids[0]],
          [A, ids[1]],
        ]);
        expect(await candidates(ids[0])).toEqual([
          [A, ids[1]],
          [A, ids[2]],
        ]);
        expect(await candidates(ids[2])).toEqual([]);
      });
    });
  });
}
