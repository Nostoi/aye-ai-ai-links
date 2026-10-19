import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { type ImageBytes, imageVersion } from "./image-store.js";
import type { LinkCheck, LinkCheckStore } from "./link-check-store.js";
import {
  type CopyDraft,
  copyLimits,
  finishedMarkdown,
  imageRef,
  type SavedCopyMaintenance,
  type SavedCopyReader,
  type SavedCopyRemover,
  type SavedCopyUsage,
  type SavedCopyWriter,
} from "./saved-copy.js";
import type { SnapshotStore } from "./snapshot-store.js";
import { A, at, B, newLink, record } from "./snapshot-store-contract.js";
import type { LinkRemover, LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. All stores share one database. */
export type CopyHarness = {
  links: LinkStore & LinkRemover & SnapshotStore;
  checks: LinkCheckStore;
  copies: SavedCopyWriter &
    SavedCopyReader &
    SavedCopyUsage &
    SavedCopyRemover &
    Pick<
      SavedCopyMaintenance,
      "backfillCandidates" | "pendingCopyImages" | "unfinishedCopies" | "purgeRemoved"
    >;
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
const img = (size: number): ImageBytes => ({
  contentType: "image/png",
  bytes: new Uint8Array(size).fill(7),
});
const urlOf = (n: number) => `https://img.example/${n}.png`;
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

    describe("images", () => {
      const withImages = async (owner: string, count = 2, markdown = "pic") => {
        const id = await save(owner);
        await h.copies.saveCopy(owner, id, draft(markdown, count), LIMITS, at(5));
        return id;
      };
      const pending = async (after: { linkId: string; n: number } | null = null, limit = 50) =>
        (await h.copies.pendingCopyImages(after, limit)).map((p) => [p.owner, p.linkId, p.n]);

      it("lists pending images across owners in link and number order", async () => {
        const a = await withImages(A);
        const b = await withImages(B);
        await h.copies.saveCopy(A, await save(A), draft("none"), LIMITS, at(5));
        expect(await h.copies.pendingCopyImages(null, 50)).toEqual([
          { owner: A, linkId: a, n: 1, url: urlOf(1) },
          { owner: A, linkId: a, n: 2, url: urlOf(2) },
          { owner: B, linkId: b, n: 1, url: urlOf(1) },
          { owner: B, linkId: b, n: 2, url: urlOf(2) },
        ]);
        expect(await pending({ linkId: a, n: 1 }, 2)).toEqual([
          [A, a, 2],
          [B, b, 1],
        ]);
      });

      it("stores an image once and reads it back", async () => {
        const id = await withImages(A);
        const before = await h.copies.usedBytes();
        expect(await h.copies.saveCopyImage(A, id, 1, urlOf(1), img(7), LIMITS)).toBe("saved");
        const copy = (await h.copies.readCopy(A, id)) as { images: Map<number, unknown> };
        expect([...copy.images.keys()]).toEqual([1]);
        expect(copy.images.get(1)).toEqual({
          contentType: "image/png",
          version: imageVersion(createHash("sha256").update(img(7).bytes).digest("hex")),
        });
        const stored = await h.copies.copyImage(A, id, 1);
        expect(stored?.contentType).toBe("image/png");
        expect(Array.from(stored?.bytes ?? [])).toEqual(Array.from(img(7).bytes));
        expect(await h.copies.usedBytes()).toBe(before + 7);
        expect((await pending()).map((p) => p[2])).toEqual([2]);
      });

      it("settles each image once, for the owner and url it was queued with", async () => {
        const id = await withImages(A);
        await h.copies.saveCopyImage(A, id, 1, urlOf(1), img(3), LIMITS);
        expect(await h.copies.saveCopyImage(A, id, 1, urlOf(1), img(3), LIMITS)).toBe(false);
        expect(await h.copies.saveCopyImage(A, id, 2, "https://other/2.png", img(3), LIMITS)).toBe(
          false,
        );
        expect(await h.copies.endCopyImage(A, id, 1, urlOf(1), "none")).toBe(false);
        expect(await h.copies.endCopyImage(B, id, 2, urlOf(2), "none")).toBe(false);
        expect(await h.copies.saveCopyImage(B, id, 2, urlOf(2), img(3), LIMITS)).toBe(false);
        expect(await h.copies.endCopyImage(A, id, 2, "https://other/2.png", "none")).toBe(false);
        expect(await h.copies.endCopyImage(A, id, 2, urlOf(2), "none")).toBe(true);
        expect(await h.copies.endCopyImage(A, id, 2, urlOf(2), "none")).toBe(false);
        const copy = (await h.copies.readCopy(A, id)) as { images: Map<number, unknown> };
        expect([...copy.images.keys()]).toEqual([1]);
        expect(await pending()).toEqual([]);
      });

      it("settles an image over the per-copy cap as too_large, charging nothing", async () => {
        const id = await withImages(A);
        const used = await h.copies.usedBytes();
        const tight = { ...LIMITS, copyBytes: bytes("pic") + 5 - 1 };
        expect(await h.copies.saveCopyImage(A, id, 1, urlOf(1), img(5), tight)).toBe("too_large");
        expect(await h.copies.usedBytes()).toBe(used);
        expect((await pending()).map((p) => p[2])).toEqual([2]);
        expect(await h.copies.copyImage(A, id, 1)).toBeNull();
      });

      it("settles an image over the total cap as no_room, charging nothing", async () => {
        const id = await withImages(A);
        const used = await h.copies.usedBytes();
        const tight = { ...LIMITS, totalBytes: used + 5 - 1 };
        expect(await h.copies.saveCopyImage(A, id, 1, urlOf(1), img(5), tight)).toBe("no_room");
        expect(await h.copies.usedBytes()).toBe(used);
        expect((await pending()).map((p) => p[2])).toEqual([2]);
      });

      it("answers unavailable and keeps the image pending when the folder is unusable", async () => {
        const id = await withImages(A);
        await h.breakFolder();
        expect(await h.copies.saveCopyImage(A, id, 1, urlOf(1), img(5), LIMITS)).toBe(
          "unavailable",
        );
        expect(await h.copies.usedBytes()).toBe(bytes("pic"));
        expect((await pending()).map((p) => p[2])).toEqual([1, 2]);
      });

      it("finishes a copy once every image has settled", async () => {
        const md = `![a](${imageRef(1, N)}) and ![b](${imageRef(2, N)}) and ![a](${imageRef(1, N)})`;
        const id = await withImages(A, 2, md);
        const finish = finishedMarkdown;
        expect(await h.copies.finishCopy(A, id, finish, at(9))).toBe(false);
        expect(await h.copies.unfinishedCopies(null, 50)).toEqual([]);
        await h.copies.saveCopyImage(A, id, 1, urlOf(1), img(7), LIMITS);
        expect(await h.copies.finishCopy(A, id, finish, at(9))).toBe(false);
        await h.copies.endCopyImage(A, id, 2, urlOf(2), "none");
        expect(await h.copies.unfinishedCopies(null, 50)).toEqual([{ owner: A, linkId: id }]);
        expect(await h.copies.finishCopy(B, id, finish, at(9))).toBe(false);
        expect(await h.copies.finishCopy(A, id, finish, at(9))).toBe(true);
        const copy = (await h.copies.readCopy(A, id)) as { markdown: string; finished: boolean };
        expect(copy.markdown).toBe("![a](images/01.png) and b and ![a](images/01.png)");
        expect(copy.finished).toBe(true);
        expect(await h.copies.usedBytes()).toBe(bytes(copy.markdown) + 7);
        expect(await h.copies.unfinishedCopies(null, 50)).toEqual([]);
        expect(await h.copies.finishCopy(A, id, finish, at(9))).toBe(false);
      });
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

    describe("removing and restoring", () => {
      const T = at(10);
      const saved = async (owner: string, markdown = "body", images = 0) => {
        const id = await save(owner);
        expect(await h.copies.saveCopy(owner, id, draft(markdown, images), LIMITS, at(5))).toBe(
          "saved",
        );
        return id;
      };
      const ids = (refs: { linkId: string }[]) => refs.map((r) => r.linkId);

      it("lists the owner's ok and removed rows with when each was made, from the ledger alone", async () => {
        const ok = await saved(A, "ok");
        const removed = await saved(A, "gone");
        const purged = await saved(A, "purged");
        const none = await save(A);
        await h.copies.recordNoCopy(A, none, "none");
        await save(A); // no row
        const theirs = await saved(B, "theirs");
        await h.copies.removeCopy(A, purged, T);
        expect(await h.copies.purgeRemoved(at(11))).toBe(1);
        await h.copies.removeCopy(A, removed, at(12));
        const undone = await saved(A, "undone");
        await h.copies.removeCopy(A, undone, at(13));
        expect(await h.copies.restoreCopy(A, undone, at(13))).toBe(true);
        await h.breakFolder();
        const entry = (status: "ok" | "removed") => ({ status, madeAt: at(5) });
        expect(await h.copies.listCopies(A)).toEqual(
          new Map([
            [ok, entry("ok")],
            [removed, entry("removed")],
            [purged, entry("removed")],
            [undone, entry("ok")],
          ]),
        );
        expect(await h.copies.listCopies(B)).toEqual(new Map([[theirs, entry("ok")]]));
        expect(await h.copies.listCopies("nobody")).toEqual(new Map());
      });

      it("hides a removed copy from every read and every pass, and keeps its bytes counted", async () => {
        const unfinished = await saved(A, "pics", 2);
        await h.copies.saveCopyImage(A, unfinished, 1, urlOf(1), img(4), LIMITS);
        await h.copies.endCopyImage(A, unfinished, 2, urlOf(2), "none");
        const waiting = await saved(A, "wait", 1);
        expect(ids(await h.copies.unfinishedCopies(null, 50))).toEqual([unfinished]);
        expect(ids(await h.copies.pendingCopyImages(null, 50))).toEqual([waiting]);
        const used = await h.copies.usedBytes();
        expect(await h.copies.removeCopy(A, unfinished, T)).toBe(true);
        expect(await h.copies.removeCopy(A, waiting, T)).toBe(true);
        expect(await h.copies.copyInfo(A, [unfinished, waiting])).toEqual(new Map());
        expect(await h.copies.readCopy(A, unfinished)).toBeNull();
        expect(await h.copies.copyImage(A, unfinished, 1)).toBeNull();
        expect(await h.copies.unfinishedCopies(null, 50)).toEqual([]);
        expect(await h.copies.pendingCopyImages(null, 50)).toEqual([]);
        expect(await h.copies.usedBytes()).toBe(used);
      });

      it("removes only the owner's ok copy", async () => {
        const id = await saved(A);
        const before = await h.copies.readCopy(A, id);
        expect(await h.copies.removeCopy(B, id, T)).toBe(false);
        expect(await h.copies.readCopy(A, id)).toEqual(before);
        const none = await save(A);
        await h.copies.recordNoCopy(A, none, "none");
        expect(await h.copies.removeCopy(A, none, T)).toBe(false);
        expect(await h.copies.removeCopy(A, await save(A), T)).toBe(false);
        expect(await h.copies.removeCopy(A, "999999", T)).toBe(false);
        expect(await h.copies.removeCopy(A, id, T)).toBe(true);
        expect(await h.copies.removeCopy(A, id, T)).toBe(false);
      });

      it("restores a copy removed at or after `since`, images included", async () => {
        const id = await saved(A, "pics", 1);
        await h.copies.saveCopyImage(A, id, 1, urlOf(1), img(4), LIMITS);
        const before = await h.copies.readCopy(A, id);
        await h.copies.removeCopy(A, id, T);
        expect(await h.copies.restoreCopy(A, id, new Date(T.getTime() + 1))).toBe(false);
        expect(await h.copies.restoreCopy(B, id, T)).toBe(false);
        expect(await h.copies.readCopy(A, id)).toBeNull();
        expect(await h.copies.restoreCopy(A, id, T)).toBe(true);
        expect(await h.copies.readCopy(A, id)).toEqual(before);
        expect(await h.copies.restoreCopy(A, id, T)).toBe(false);
      });

      it("never makes a removed copy again, purged or not", async () => {
        const purged = await saved(A);
        const inWindow = await saved(A);
        await snapshotOk(A, purged);
        await snapshotOk(A, inWindow);
        await h.copies.removeCopy(A, purged, T);
        await h.copies.removeCopy(A, inWindow, at(20));
        expect(await h.copies.purgeRemoved(at(11))).toBe(1);
        expect(await candidates(null, 50, true)).toEqual([]);
        for (const id of [purged, inWindow]) {
          expect(await h.copies.saveCopy(A, id, draft("again"), LIMITS, at(30))).toBe("exists");
          expect(await h.copies.recordNoCopy(A, id, "none")).toBe(false);
        }
      });

      it("purges copies removed before the cutoff, which can then never be restored", async () => {
        const early = await saved(A, "early", 1);
        await h.copies.saveCopyImage(A, early, 1, urlOf(1), img(4), LIMITS);
        const empty = await saved(A, "");
        const late = await saved(A, "late");
        const theirs = await saved(B, "theirs");
        const ok = await saved(A, "ok");
        await h.copies.removeCopy(A, early, T);
        await h.copies.removeCopy(A, empty, T);
        await h.copies.removeCopy(A, late, at(20));
        await h.copies.removeCopy(B, theirs, at(20));
        const used = await h.copies.usedBytes();
        expect(await h.copies.purgeRemoved(at(20))).toBe(2);
        expect(await h.copies.usedBytes()).toBe(used - bytes("early") - 4);
        for (const id of [early, empty]) {
          expect(await h.copies.restoreCopy(A, id, new Date(0))).toBe(false);
          expect(await h.copies.readCopy(A, id)).toBeNull();
        }
        expect(await h.copies.purgeRemoved(at(20))).toBe(0);
        expect(await h.copies.readCopy(A, ok)).toMatchObject({ markdown: "ok" });
        expect(await h.copies.restoreCopy(A, late, at(20))).toBe(true);
        expect(await h.copies.restoreCopy(B, theirs, at(20))).toBe(true);
        expect(await h.copies.readCopy(B, theirs)).toMatchObject({ markdown: "theirs" });
      });

      it("stores and settles no picture of a removed copy, which stays pending for a restore", async () => {
        const id = await saved(A, "pics", 2);
        const used = await h.copies.usedBytes();
        await h.copies.removeCopy(A, id, T);
        expect(await h.copies.saveCopyImage(A, id, 1, urlOf(1), img(4), LIMITS)).toBe(false);
        expect(await h.copies.endCopyImage(A, id, 2, urlOf(2), "none")).toBe(false);
        expect(await h.copies.usedBytes()).toBe(used);
        expect(await h.copies.restoreCopy(A, id, T)).toBe(true);
        expect((await h.copies.pendingCopyImages(null, 50)).map((p) => p.n)).toEqual([1, 2]);
        expect(await h.copies.copyImage(A, id, 1)).toBeNull();
      });
    });

    describe("deleting the link", () => {
      const T = at(10);
      const saved = async (owner: string, markdown = "body") => {
        const id = await save(owner);
        await h.copies.saveCopy(owner, id, draft(markdown), LIMITS, at(5));
        return id;
      };

      it("removes the ok copy with the link, and Undo brings back only that one", async () => {
        const id = await saved(A);
        const earlier = await saved(A, "earlier");
        const before = await h.copies.readCopy(A, id);
        await h.copies.removeCopy(A, earlier, at(8));
        expect(await h.links.markDeleted(A, id, T)).toBe(true);
        expect(await h.links.markDeleted(A, earlier, T)).toBe(true);
        expect(await h.copies.listCopies(A)).toEqual(
          new Map([
            [id, { status: "removed", madeAt: at(5) }],
            [earlier, { status: "removed", madeAt: at(5) }],
          ]),
        );
        expect(await h.links.unmarkDeleted(A, id, T)).toBe(true);
        expect(await h.links.unmarkDeleted(A, earlier, T)).toBe(true);
        expect(await h.copies.readCopy(A, id)).toEqual(before);
        expect(await h.copies.readCopy(A, earlier)).toBeNull();
        expect(await h.copies.restoreCopy(A, earlier, at(8))).toBe(true);
      });

      it("purges the link only once purgeRemoved has retired its copy", async () => {
        const id = await saved(A);
        const used = await h.copies.usedBytes();
        await h.links.markDeleted(A, id, T);
        expect(await h.links.purgeDeleted(at(20))).toBe(0);
        expect(await h.copies.usedBytes()).toBe(used);
        expect(await h.copies.purgeRemoved(at(20))).toBe(1);
        expect(await h.links.purgeDeleted(at(20))).toBe(1);
        expect(await h.copies.usedBytes()).toBe(0);
        expect(await h.copies.listCopies(A)).toEqual(new Map());
      });

      it("Undo after the copy was retired brings the link back without it", async () => {
        const id = await saved(A);
        await h.links.markDeleted(A, id, T);
        expect(await h.copies.purgeRemoved(at(20))).toBe(1);
        expect(await h.links.unmarkDeleted(A, id, T)).toBe(true);
        expect(await h.links.get(A, id)).not.toBeNull();
        expect(await h.copies.readCopy(A, id)).toBeNull();
        expect(await h.copies.listCopies(A)).toEqual(
          new Map([[id, { status: "removed", madeAt: at(5) }]]),
        );
      });

      it("a re-save of the address drops the hidden link's copy and its bytes", async () => {
        const id = await saved(A);
        const theirs = await saved(B);
        const used = await h.copies.usedBytes();
        const link = await h.links.get(A, id);
        await h.links.markDeleted(A, id, T);
        const again = await h.links.insertIfAbsent(A, {
          ...newLink(999, at(0)),
          urlKey: link?.urlKey as string,
        });
        expect(again.created).toBe(true);
        expect(await h.copies.listCopies(A)).toEqual(new Map());
        expect(await h.copies.usedBytes()).toBe(used - bytes("body"));
        expect(await h.copies.readCopy(B, theirs)).toMatchObject({ markdown: "body" });
      });
    });
  });
}
