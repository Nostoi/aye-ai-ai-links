import { beforeEach, describe, expect, it } from "vitest";
import type { SnapshotRecord, SnapshotStore } from "./snapshot-store.js";
import type { LinkRemover, LinkStore } from "./store.js";
import type { Link, NewLink } from "./types.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type SnapshotHarness = {
  store: LinkStore & LinkRemover & SnapshotStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

export const A = "owner-a";
export const B = "owner-b";

/** A moment `s` seconds after a fixed start. */
export const at = (s: number): Date => new Date(Date.UTC(2026, 0, 1) + s * 1000);

export const newLink = (n: number, savedAt: Date): NewLink => ({
  url: `https://ex.com/${n}`,
  urlKey: `ex.com/${n}`,
  title: null,
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt,
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  putAwayAt: null,
  tidyKeptAt: null,
  state: "active",
});

export const record = (over: Partial<SnapshotRecord> = {}): SnapshotRecord => ({
  status: "ok",
  attempts: 1,
  nextFetchAt: null,
  fetchedAt: at(10),
  title: "Page title",
  description: "Page description",
  imageUrl: "https://ex.com/i.png",
  iconUrls: [],
  text: "body text",
  lastError: null,
  ...over,
});

export function describeSnapshotStoreContract(
  name: string,
  makeHarness: () => SnapshotHarness | Promise<SnapshotHarness>,
): void {
  describe(name, () => {
    let store: LinkStore & LinkRemover & SnapshotStore;
    let n: number;

    const save = async (owner: string, savedAt: Date): Promise<Link> =>
      (await store.insertIfAbsent(owner, newLink(++n, savedAt))).link;

    /** Lease a due snapshot that must be claimable. */
    async function lease(owner: string, link: Link, now: Date, until: Date) {
      const l = await store.leaseSnapshot(owner, link.id, now, until);
      if (!l) throw new Error("expected a lease");
      return l;
    }

    beforeEach(async () => {
      const h = await makeHarness();
      store = h.store;
      await h.addOwner(A);
      await h.addOwner(B);
      n = 0;
    });

    it("refuses a record with more than two icon URLs, keeping the claim valid", async () => {
      const link = await save(A, at(0));
      const l = await lease(A, link, at(1), at(100));
      const three = record({
        iconUrls: ["https://ex.com/a.png", "https://ex.com/b.png", "https://ex.com/c.png"],
      });
      expect(await store.recordSnapshot(A, link.id, l.claim, three)).toBe(false);
      expect(await store.recordSnapshot(A, link.id, l.claim, record())).toBe(true);
    });

    it("never shows an icon URL to readers: an icon-only snapshot reads imageUrl null", async () => {
      const link = await save(A, at(0));
      const l = await lease(A, link, at(1), at(100));
      await store.recordSnapshot(
        A,
        link.id,
        l.claim,
        record({ imageUrl: null, iconUrls: ["https://ex.com/icon.png"] }),
      );
      expect((await store.get(A, link.id))?.snapshot).toEqual({
        status: "ok",
        fetchedAt: at(10),
        title: "Page title",
        description: "Page description",
        imageUrl: null,
      });
    });

    it("gives a new link a pending snapshot, and a duplicate save leaves a finished one alone", async () => {
      const link = await save(A, at(0));
      expect(link.snapshot).toEqual({
        status: "pending",
        fetchedAt: null,
        title: null,
        description: null,
        imageUrl: null,
      });
      const l = await lease(A, link, at(1), at(100));
      await store.recordSnapshot(A, link.id, l.claim, record());
      const again = await store.insertIfAbsent(A, newLink(1, at(200)));
      expect(again.created).toBe(false);
      expect(again.link.snapshot).toEqual({
        status: "ok",
        fetchedAt: at(10),
        title: "Page title",
        description: "Page description",
        imageUrl: "https://ex.com/i.png",
      });
    });

    describe("leaseSnapshot", () => {
      it("returns the url, the attempts so far and a claim, and only one caller wins", async () => {
        const link = await save(A, at(0));
        expect(await store.leaseSnapshot(A, link.id, at(1), at(100))).toEqual({
          url: "https://ex.com/1",
          attempts: 1,
          claim: expect.any(Number),
        });
        expect(await store.leaseSnapshot(A, link.id, at(50), at(150))).toBeNull();
      });

      it("counts the attempt at lease time: an expired lease leased again is attempt 2", async () => {
        const link = await save(A, at(0));
        expect((await lease(A, link, at(1), at(100))).attempts).toBe(1);
        expect((await lease(A, link, at(100), at(200))).attempts).toBe(2);
      });

      it("hands out a different claim once the lease has ended", async () => {
        const link = await save(A, at(0));
        const first = await lease(A, link, at(1), at(100));
        const second = await lease(A, link, at(100), at(200));
        expect(second.claim).not.toBe(first.claim);
      });

      it("refuses a snapshot that is not due yet", async () => {
        const link = await save(A, at(50));
        expect(await store.leaseSnapshot(A, link.id, at(10), at(100))).toBeNull();
      });

      it("refuses a finished snapshot, another owner's, and an id never issued", async () => {
        const link = await save(A, at(0));
        expect(await store.leaseSnapshot(B, link.id, at(1), at(100))).toBeNull();
        expect(await store.leaseSnapshot(A, "no-such-id", at(1), at(100))).toBeNull();
        expect(await store.leaseSnapshot(A, "99999", at(1), at(100))).toBeNull();
        const l = await lease(A, link, at(1), at(100));
        await store.recordSnapshot(A, link.id, l.claim, record());
        expect(await store.leaseSnapshot(A, link.id, at(1000), at(1100))).toBeNull();
      });
    });

    describe("leaseSnapshot on a hidden link", () => {
      it("still leases and records, so runner work finishes inside the Undo window", async () => {
        const link = await save(A, at(0));
        expect(await store.markDeleted(A, link.id, at(1))).toBe(true);
        const l = await lease(A, link, at(2), at(100));
        expect(l).toEqual({ url: link.url, attempts: 1, claim: expect.any(Number) });
        expect(await store.recordSnapshot(A, link.id, l.claim, record())).toBe(true);
      });
    });

    describe("dueSnapshots", () => {
      it("lists due snapshots across owners, soonest first, up to the limit", async () => {
        const a1 = await save(A, at(5));
        const b1 = await save(B, at(3));
        const a2 = await save(A, at(7));
        const due = (limit: number) => store.dueSnapshots(at(10), limit);
        expect(await due(10)).toEqual([
          { owner: B, linkId: b1.id },
          { owner: A, linkId: a1.id },
          { owner: A, linkId: a2.id },
        ]);
        expect(await due(2)).toEqual([
          { owner: B, linkId: b1.id },
          { owner: A, linkId: a1.id },
        ]);
      });

      it("leaves out leased, not yet due and finished snapshots", async () => {
        const leased = await save(A, at(1));
        const done = await save(A, at(2));
        await save(A, at(50));
        const open = await save(A, at(4));
        await lease(A, leased, at(10), at(100));
        const l = await lease(A, done, at(10), at(100));
        await store.recordSnapshot(A, done.id, l.claim, record());
        expect(await store.dueSnapshots(at(10), 10)).toEqual([{ owner: A, linkId: open.id }]);
      });

      it("lists a leased snapshot again once its lease has ended", async () => {
        const link = await save(A, at(0));
        await lease(A, link, at(1), at(100));
        expect(await store.dueSnapshots(at(99), 10)).toEqual([]);
        expect(await store.dueSnapshots(at(100), 10)).toEqual([{ owner: A, linkId: link.id }]);
      });
    });

    describe("recordSnapshot", () => {
      it("stores the result: the summary on the link, the text apart from it", async () => {
        const link = await save(A, at(0));
        const l = await lease(A, link, at(1), at(100));
        expect(await store.recordSnapshot(A, link.id, l.claim, record())).toBe(true);
        const read = await store.get(A, link.id);
        expect(read?.snapshot?.status).toBe("ok");
        expect(read?.snapshot).not.toHaveProperty("text");
        expect(await store.getSnapshotText(A, link.id)).toBe("body text");
      });

      it("schedules a retry, and the next lease counts one more attempt", async () => {
        const link = await save(A, at(0));
        const first = await lease(A, link, at(1), at(100));
        await store.recordSnapshot(
          A,
          link.id,
          first.claim,
          record({
            status: "retrying",
            attempts: 1,
            nextFetchAt: at(160),
            fetchedAt: null,
            text: null,
            lastError: "network:ECONNRESET",
          }),
        );
        expect((await store.get(A, link.id))?.snapshot?.status).toBe("retrying");
        expect(await store.dueSnapshots(at(159), 10)).toEqual([]);
        expect(await store.leaseSnapshot(A, link.id, at(159), at(300))).toBeNull();
        expect(await store.dueSnapshots(at(160), 10)).toEqual([{ owner: A, linkId: link.id }]);
        expect(await store.leaseSnapshot(A, link.id, at(160), at(300))).toMatchObject({
          attempts: 2,
        });
      });

      it("writes nothing for an attempt that outlived its lease", async () => {
        const link = await save(A, at(0));
        const stale = await lease(A, link, at(1), at(100));
        const fresh = await lease(A, link, at(100), at(200));
        expect(
          await store.recordSnapshot(A, link.id, fresh.claim, record({ text: "new text" })),
        ).toBe(true);
        const late = record({
          status: "retrying",
          nextFetchAt: at(180),
          text: null,
          title: null,
          lastError: "fetch:timeout",
        });
        expect(await store.recordSnapshot(A, link.id, stale.claim, late)).toBe(false);
        expect((await store.get(A, link.id))?.snapshot).toMatchObject({
          status: "ok",
          title: "Page title",
        });
        expect(await store.getSnapshotText(A, link.id)).toBe("new text");
        expect(await store.dueSnapshots(at(100_000), 10)).toEqual([]);
      });

      it("writes nothing a second time with the same claim", async () => {
        const link = await save(A, at(0));
        const l = await lease(A, link, at(1), at(100));
        await store.recordSnapshot(A, link.id, l.claim, record());
        expect(await store.recordSnapshot(A, link.id, l.claim, record({ text: "again" }))).toBe(
          false,
        );
        expect(await store.getSnapshotText(A, link.id)).toBe("body text");
      });

      it("writes nothing for another owner, and leaves the claim valid for its owner", async () => {
        const link = await save(A, at(0));
        const l = await lease(A, link, at(1), at(100));
        expect(await store.recordSnapshot(B, link.id, l.claim, record({ text: "intruder" }))).toBe(
          false,
        );
        expect((await store.get(A, link.id))?.snapshot?.status).toBe("pending");
        expect(await store.recordSnapshot(A, link.id, l.claim, record())).toBe(true);
        expect(await store.getSnapshotText(A, link.id)).toBe("body text");
      });

      it("refuses a record whose status and next time disagree, and changes nothing", async () => {
        const link = await save(A, at(0));
        const l = await lease(A, link, at(1), at(100));
        const bad = [
          record({ status: "pending", nextFetchAt: null }),
          record({ status: "retrying", nextFetchAt: null }),
          record({ status: "ok", nextFetchAt: at(500) }),
          record({ status: "failed", nextFetchAt: at(500) }),
        ];
        for (const b of bad) expect(await store.recordSnapshot(A, link.id, l.claim, b)).toBe(false);
        expect((await store.get(A, link.id))?.snapshot?.status).toBe("pending");
        expect(await store.getSnapshotText(A, link.id)).toBeNull();
        // The refusals did not spend the claim.
        expect(await store.recordSnapshot(A, link.id, l.claim, record())).toBe(true);
      });

      it("rejects a second record, and a release, with the claim of a retry whose next time equals the lease end", async () => {
        const link = await save(A, at(0));
        const l = await lease(A, link, at(1), at(100));
        const retry = record({
          status: "retrying",
          nextFetchAt: at(100),
          fetchedAt: null,
          text: null,
          lastError: "fetch:timeout",
        });
        expect(await store.recordSnapshot(A, link.id, l.claim, retry)).toBe(true);
        expect(await store.recordSnapshot(A, link.id, l.claim, record({ text: "second" }))).toBe(
          false,
        );
        expect(await store.releaseSnapshot(A, link.id, l.claim, at(50))).toBe(false);
        expect(await store.getSnapshotText(A, link.id)).toBeNull();
        expect((await store.get(A, link.id))?.snapshot?.status).toBe("retrying");
      });
    });

    describe("releaseSnapshot", () => {
      it("gives back the attempt and makes the snapshot due again", async () => {
        const link = await save(A, at(0));
        const l = await lease(A, link, at(1), at(100));
        expect(await store.dueSnapshots(at(10), 10)).toEqual([]);
        expect(await store.releaseSnapshot(A, link.id, l.claim, at(10))).toBe(true);
        expect(await store.dueSnapshots(at(10), 10)).toEqual([{ owner: A, linkId: link.id }]);
        expect((await lease(A, link, at(10), at(200))).attempts).toBe(1);
      });

      it("returns false and changes nothing for a stale claim", async () => {
        const link = await save(A, at(0));
        const stale = await lease(A, link, at(1), at(100));
        const fresh = await lease(A, link, at(100), at(200));
        expect(await store.releaseSnapshot(A, link.id, stale.claim, at(150))).toBe(false);
        expect(await store.dueSnapshots(at(150), 10)).toEqual([]);
        expect(await store.recordSnapshot(A, link.id, fresh.claim, record({ attempts: 2 }))).toBe(
          true,
        );
      });

      it("returns false and changes nothing after a record", async () => {
        const link = await save(A, at(0));
        const l = await lease(A, link, at(1), at(100));
        const retry = record({ status: "retrying", nextFetchAt: at(500), text: null });
        await store.recordSnapshot(A, link.id, l.claim, retry);
        expect(await store.releaseSnapshot(A, link.id, l.claim, at(10))).toBe(false);
        expect(await store.dueSnapshots(at(499), 10)).toEqual([]);
        expect((await store.get(A, link.id))?.snapshot?.status).toBe("retrying");
        expect((await lease(A, link, at(500), at(600))).attempts).toBe(2);
      });

      it("returns false for another owner, and leaves the claim valid for its owner", async () => {
        const link = await save(A, at(0));
        const l = await lease(A, link, at(1), at(100));
        expect(await store.releaseSnapshot(B, link.id, l.claim, at(10))).toBe(false);
        expect(await store.dueSnapshots(at(10), 10)).toEqual([]);
        expect(await store.releaseSnapshot(A, link.id, l.claim, at(10))).toBe(true);
      });

      it("rejects the old claim after a release and a new lease in the same millisecond", async () => {
        const link = await save(A, at(0));
        const first = await lease(A, link, at(1), at(100));
        expect(await store.releaseSnapshot(A, link.id, first.claim, at(1))).toBe(true);
        const second = await lease(A, link, at(1), at(100));
        expect(await store.recordSnapshot(A, link.id, first.claim, record())).toBe(false);
        expect(await store.releaseSnapshot(A, link.id, first.claim, at(2))).toBe(false);
        expect(await store.recordSnapshot(A, link.id, second.claim, record())).toBe(true);
      });

      it("uses up the claim, so it cannot release or record again", async () => {
        const link = await save(A, at(0));
        const l = await lease(A, link, at(1), at(100));
        expect(await store.releaseSnapshot(A, link.id, l.claim, at(10))).toBe(true);
        expect(await store.releaseSnapshot(A, link.id, l.claim, at(11))).toBe(false);
        expect(await store.recordSnapshot(A, link.id, l.claim, record())).toBe(false);
        expect((await store.get(A, link.id))?.snapshot?.status).toBe("pending");
        expect((await lease(A, link, at(12), at(200))).attempts).toBe(1);
      });
    });

    describe("getSnapshotText", () => {
      it("is null before any text, for a snapshot without text, for another owner and for an unknown id", async () => {
        const link = await save(A, at(0));
        expect(await store.getSnapshotText(A, link.id)).toBeNull();
        const l = await lease(A, link, at(1), at(100));
        await store.recordSnapshot(A, link.id, l.claim, record({ text: null }));
        expect(await store.getSnapshotText(A, link.id)).toBeNull();
        const other = await save(A, at(0));
        const o = await lease(A, other, at(1), at(100));
        await store.recordSnapshot(A, other.id, o.claim, record());
        expect(await store.getSnapshotText(B, other.id)).toBeNull();
        expect(await store.getSnapshotText(A, "no-such-id")).toBeNull();
      });
    });
  });
}
