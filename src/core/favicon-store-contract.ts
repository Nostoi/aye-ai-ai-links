import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { FaviconReader, FaviconStore } from "./favicon-store.js";
import type { IconBackfillStore } from "./icon-backfill-store.js";
import { type ImageBytes, imageVersion } from "./image-store.js";
import type { SnapshotRecord, SnapshotStore } from "./snapshot-store.js";
import { A, at, B, newLink, record } from "./snapshot-store-contract.js";
import type { LinkRemover, LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** A favicon row as stored, for inspection: `stored` is whether it holds bytes. */
export type FaviconRow = {
  candidates: string[];
  status: string;
  generation: number;
  discovery: number;
  stored: boolean;
};

/** What the contract suite needs from a store under test. */
export type FaviconHarness = {
  links: LinkStore & LinkRemover & SnapshotStore;
  /** The other writer of a page's candidates: the word-picture check. */
  images: IconBackfillStore;
  favicons: FaviconStore & FaviconReader;
  addOwner(owner: string): MaybeAsync<void>;
  /** The link's favicon row, or null when it has none. Test inspection only. */
  row(owner: string, linkId: string): MaybeAsync<FaviconRow | null>;
};

const F1 = "https://ex.com/a.png";
const F2 = "https://ex.com/b.png";
const IMG = "https://ex.com/i.png";
const png = (n: number): ImageBytes => ({
  contentType: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]),
});
const versionOf = (image: ImageBytes) =>
  imageVersion(createHash("sha256").update(image.bytes).digest("hex"));

export function describeFaviconStoreContract(
  name: string,
  makeHarness: () => FaviconHarness | Promise<FaviconHarness>,
): void {
  describe(name, () => {
    let h: FaviconHarness;
    let n: number;

    /** Lease the link's due snapshot at `now` and record `r`; returns what the store answered. */
    const recordAt = async (owner: string, id: string, now: Date, r: SnapshotRecord) => {
      const lease = await h.links.leaseSnapshot(owner, id, now, new Date(now.getTime() + 99_000));
      if (!lease) throw new Error("the snapshot should be leasable");
      return h.links.recordSnapshot(owner, id, lease.claim, r);
    };
    /** A link of `owner` whose page was read with these favicon candidates. */
    const recorded = async (owner: string, faviconUrls: string[] | null = [F1, F2]) => {
      const { link } = await h.links.insertIfAbsent(owner, newLink(++n, at(0)));
      expect(await recordAt(owner, link.id, at(1), record({ faviconUrls }))).toBe(true);
      return link.id;
    };
    const pending = async () =>
      (await h.favicons.pendingFavicons(null, 100)).map((p) => [p.owner, p.linkId, p.generation]);
    /** A link of A's whose favicon is stored at generation 1. */
    const stored = async (image = png(7)) => {
      const id = await recorded(A);
      expect(await h.favicons.writeFavicon(A, id, 1, image, at(5))).toBe(true);
      return id;
    };

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("a page read writes its candidates in the snapshot's record: pending at generation 1", async () => {
      const id = await recorded(A, [F1, F2]);
      expect(await h.row(A, id)).toEqual({
        candidates: [F1, F2],
        status: "pending",
        generation: 1,
        // Version 2 (#272 PR 2): declared ICOs and the site root's fallbacks.
        discovery: 2,
        stored: false,
      });
      expect(await h.favicons.pendingFavicons(null, 100)).toEqual([
        { owner: A, linkId: id, generation: 1, urls: [F1, F2] },
      ]);
    });

    it("a page read with no candidates records none, and nothing is pending", async () => {
      const id = await recorded(A, []);
      expect(await h.row(A, id)).toMatchObject({ candidates: [], status: "none", generation: 1 });
      expect(await pending()).toEqual([]);
    });

    it("a record with no page read leaves the favicon as it was", async () => {
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      const retry = { status: "retrying", nextFetchAt: at(50) } as const;
      expect(await recordAt(A, link.id, at(1), record({ ...retry, faviconUrls: null }))).toBe(true);
      expect(await h.row(A, link.id)).toBeNull();
      expect(
        await recordAt(
          A,
          link.id,
          at(50),
          record({ ...retry, nextFetchAt: at(80), faviconUrls: [F1] }),
        ),
      ).toBe(true);
      const before = await h.row(A, link.id);
      expect(before).toMatchObject({ candidates: [F1], status: "pending", generation: 1 });
      expect(await recordAt(A, link.id, at(80), record({ faviconUrls: null }))).toBe(true);
      expect(await h.row(A, link.id)).toEqual(before);
    });

    it("a refused record writes no favicon: a stale claim, or too many candidates", async () => {
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      const lease = await h.links.leaseSnapshot(A, link.id, at(1), at(100));
      if (!lease) throw new Error("expected a lease");
      const r = record({ faviconUrls: [F1] });
      expect(await h.links.recordSnapshot(A, link.id, lease.claim + 1, r)).toBe(false);
      expect(await h.row(A, link.id)).toBeNull();
      const five = [1, 2, 3, 4, 5].map((i) => `https://ex.com/${i}.png`);
      expect(
        await h.links.recordSnapshot(A, link.id, lease.claim, record({ faviconUrls: five })),
      ).toBe(false);
      expect(await h.row(A, link.id)).toBeNull();
    });

    it("a write at the current generation stores it: its version and bytes read back", async () => {
      const image = png(7);
      const id = await stored(image);
      expect(await h.row(A, id)).toMatchObject({ status: "ok", generation: 1, stored: true });
      expect(await h.favicons.faviconVersions(A, [id, "999"])).toEqual(
        new Map([[id, versionOf(image)]]),
      );
      expect(await h.favicons.favicon(A, id)).toEqual({
        contentType: "image/png",
        bytes: image.bytes,
        version: versionOf(image),
      });
      expect(await pending()).toEqual([]);
      // Settled: a repeated or late result changes nothing.
      expect(await h.favicons.writeFavicon(A, id, 1, png(8), at(6))).toBe(false);
      expect(await h.favicons.endFavicon(A, id, 1, "none")).toBe(false);
      expect((await h.favicons.favicon(A, id))?.version).toBe(versionOf(image));
    });

    it("★ a fetch begun before its candidates were rewritten (A.png to B.png) writes nothing", async () => {
      // [Comparing on the URL list, or not comparing at all.]
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      expect(await recordAt(A, link.id, at(1), record({ imageUrl: IMG, faviconUrls: [F1] }))).toBe(
        true,
      );
      const [claim] = await h.favicons.pendingFavicons(null, 100);
      expect(claim).toEqual({ owner: A, linkId: link.id, generation: 1, urls: [F1] });
      expect(await h.images.recordWordPictureCheck(A, link.id, IMG, [], [F2])).toBe(true);
      const after = { candidates: [F2], status: "pending", generation: 2, stored: false };
      expect(await h.favicons.writeFavicon(A, link.id, 1, png(7), at(5))).toBe(false);
      expect(await h.favicons.endFavicon(A, link.id, 1, "none")).toBe(false);
      expect(await h.row(A, link.id)).toMatchObject(after);
      expect(await h.favicons.faviconVersions(A, [link.id])).toEqual(new Map());
      expect(await h.favicons.pendingFavicons(null, 100)).toEqual([
        { owner: A, linkId: link.id, generation: 2, urls: [F2] },
      ]);
      expect(await h.favicons.writeFavicon(A, link.id, 2, png(9), at(6))).toBe(true);
    });

    it("★ a rewrite to the same candidates still moves the generation on", async () => {
      // [Skipping the bump when the list is unchanged, which lets a stale fetch land.]
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      expect(await recordAt(A, link.id, at(1), record({ imageUrl: IMG, faviconUrls: [F1] }))).toBe(
        true,
      );
      expect(await h.images.recordWordPictureCheck(A, link.id, IMG, [], [F1])).toBe(true);
      expect(await h.favicons.writeFavicon(A, link.id, 1, png(7), at(5))).toBe(false);
      expect(await h.row(A, link.id)).toMatchObject({
        candidates: [F1],
        status: "pending",
        generation: 2,
        stored: false,
      });
    });

    it("a rewrite drops a stored favicon, and an empty one ends it as none", async () => {
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      expect(await recordAt(A, link.id, at(1), record({ imageUrl: IMG, faviconUrls: [F1] }))).toBe(
        true,
      );
      expect(await h.favicons.writeFavicon(A, link.id, 1, png(7), at(5))).toBe(true);
      expect(await h.images.recordWordPictureCheck(A, link.id, IMG, [], [])).toBe(true);
      expect(await h.row(A, link.id)).toMatchObject({
        candidates: [],
        status: "none",
        generation: 2,
        stored: false,
      });
      expect(await h.favicons.favicon(A, link.id)).toBeNull();
      expect(await h.favicons.faviconVersions(A, [link.id])).toEqual(new Map());
    });

    it("a word-picture check with no page read, or one refused, leaves the favicon as it was", async () => {
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      expect(await recordAt(A, link.id, at(1), record({ imageUrl: IMG, faviconUrls: [F1] }))).toBe(
        true,
      );
      const before = await h.row(A, link.id);
      expect(
        await h.images.recordWordPictureCheck(A, link.id, "https://ex.com/other.png", [], [F2]),
      ).toBe(false);
      expect(await h.row(A, link.id)).toEqual(before);
      const five = [1, 2, 3, 4, 5].map((i) => `https://ex.com/${i}.png`);
      expect(await h.images.recordWordPictureCheck(A, link.id, IMG, [], five)).toBe(false);
      expect(await h.row(A, link.id)).toEqual(before);
      expect(await h.images.recordWordPictureCheck(A, link.id, IMG, [], null)).toBe(true);
      expect(await h.row(A, link.id)).toEqual(before);
    });

    it("an end settles it as none or refused, with nothing stored", async () => {
      const none = await recorded(A);
      const refused = await recorded(A);
      expect(await h.favicons.endFavicon(A, none, 1, "none")).toBe(true);
      expect(await h.favicons.endFavicon(A, refused, 1, "refused")).toBe(true);
      expect(await h.row(A, none)).toMatchObject({ status: "none", stored: false });
      expect(await h.row(A, refused)).toMatchObject({ status: "refused", stored: false });
      expect(await h.favicons.writeFavicon(A, none, 1, png(7), at(5))).toBe(false);
      expect(await pending()).toEqual([]);
    });

    it("another owner's link: its writes change nothing and its reads show nothing", async () => {
      const id = await stored();
      const waiting = await recorded(A);
      const theirs = await recorded(B);
      expect(await pending()).toEqual([
        [A, waiting, 1],
        [B, theirs, 1],
      ]);
      const before = [await h.row(A, id), await h.row(A, waiting)];
      expect(await h.favicons.writeFavicon(B, waiting, 1, png(8), at(5))).toBe(false);
      expect(await h.favicons.endFavicon(B, waiting, 1, "none")).toBe(false);
      expect([await h.row(A, id), await h.row(A, waiting)]).toEqual(before);
      expect(await h.favicons.faviconVersions(B, [id, waiting])).toEqual(new Map());
      expect(await h.favicons.favicon(B, id)).toBeNull();
    });

    it("a deleted link is not pending, refuses writes, reads as none, and Undo brings it back", async () => {
      const image = png(7);
      const id = await stored(image);
      const waiting = await recorded(A);
      expect(await h.links.markDeleted(A, id, at(10))).toBe(true);
      expect(await h.links.markDeleted(A, waiting, at(10))).toBe(true);
      expect(await h.favicons.faviconVersions(A, [id, waiting])).toEqual(new Map());
      expect(await h.favicons.favicon(A, id)).toBeNull();
      expect(await pending()).toEqual([]);
      expect(await h.favicons.writeFavicon(A, waiting, 1, png(8), at(11))).toBe(false);
      expect(await h.favicons.endFavicon(A, waiting, 1, "none")).toBe(false);
      expect(await h.row(A, waiting)).toMatchObject({
        status: "pending",
        generation: 1,
        stored: false,
      });

      expect(await h.links.unmarkDeleted(A, id, at(0))).toBe(true);
      expect(await h.links.unmarkDeleted(A, waiting, at(0))).toBe(true);
      expect(await h.favicons.faviconVersions(A, [id])).toEqual(new Map([[id, versionOf(image)]]));
      expect(await pending()).toEqual([[A, waiting, 1]]);
    });

    it("purging a deleted link removes its favicon", async () => {
      const id = await stored();
      expect(await h.links.markDeleted(A, id, at(10))).toBe(true);
      expect(await h.links.purgeDeleted(at(11))).toBe(1);
      expect(await h.row(A, id)).toBeNull();
      expect(await h.favicons.writeFavicon(A, id, 1, png(8), at(12))).toBe(false);
    });

    it("pages pending favicons by id, and refuses ids never issued", async () => {
      const ids = [await recorded(A), await recorded(B), await recorded(A)];
      const page1 = await h.favicons.pendingFavicons(null, 2);
      expect(page1.map((p) => p.linkId)).toEqual(ids.slice(0, 2));
      const page2 = await h.favicons.pendingFavicons(page1[1]?.linkId ?? null, 2);
      expect(page2.map((p) => p.linkId)).toEqual(ids.slice(2));
      expect(await h.favicons.writeFavicon(A, "999", 1, png(1), at(5))).toBe(false);
      expect(await h.favicons.endFavicon(A, "nope", 1, "none")).toBe(false);
      expect(await h.favicons.favicon(A, "nope")).toBeNull();
    });
  });
}
