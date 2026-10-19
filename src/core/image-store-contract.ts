import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImageBytes, ImageStore, LinkImageReader } from "./image-store.js";
import type { SnapshotRecord, SnapshotStore } from "./snapshot-store.js";
import { A, at, B, newLink, record } from "./snapshot-store-contract.js";
import type { LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type ImageHarness = {
  links: LinkStore & SnapshotStore;
  images: ImageStore & LinkImageReader;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

const IMG = "https://ex.com/i.png";
const pngBytes = (n: number): ImageBytes => ({
  contentType: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]),
});
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function describeImageStoreContract(
  name: string,
  makeHarness: () => ImageHarness | Promise<ImageHarness>,
): void {
  describe(name, () => {
    let h: ImageHarness;
    let n: number;

    /** A link of `owner` whose snapshot was recorded with `imageUrl`. */
    const recorded = async (owner: string, imageUrl: string | null = IMG): Promise<string> => {
      const { link } = await h.links.insertIfAbsent(owner, newLink(++n, at(0)));
      const lease = await h.links.leaseSnapshot(owner, link.id, at(1), at(100));
      if (!lease) throw new Error("the new link's snapshot should be leasable");
      expect(await h.links.recordSnapshot(owner, link.id, lease.claim, record({ imageUrl }))).toBe(
        true,
      );
      return link.id;
    };
    const pending = async () => (await h.images.pendingImages(null, 100)).map((p) => p.linkId);

    const ICON = "https://ex.com/icon.png";
    /** Lease the link's due snapshot at `now` and record `r`. */
    const recordAt = async (owner: string, id: string, now: Date, r: SnapshotRecord) => {
      const lease = await h.links.leaseSnapshot(owner, id, now, new Date(now.getTime() + 99_000));
      if (!lease) throw new Error("the snapshot should be leasable");
      expect(await h.links.recordSnapshot(owner, id, lease.claim, r)).toBe(true);
    };
    /** A link of `owner` whose icon is stored, its snapshot due again at at(50). */
    const iconStored = async (owner: string): Promise<string> => {
      const { link } = await h.links.insertIfAbsent(owner, newLink(++n, at(0)));
      await recordAt(
        owner,
        link.id,
        at(1),
        record({ status: "retrying", nextFetchAt: at(50), imageUrl: null, iconUrls: [ICON] }),
      );
      expect(await h.images.writeImage(owner, link.id, ICON, "icon", pngBytes(7), at(5))).toBe(
        true,
      );
      return link.id;
    };
    const noIcon = async (id: string) => {
      expect(await h.images.imageVersions(A, [id])).toEqual(new Map());
      expect(await h.images.image(A, id)).toBeNull();
      expect(await h.images.image(A, id, "page")).toBeNull();
      expect(await h.images.pictureInfo(A, [id])).toEqual(new Map());
    };

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("lists a snapshot recorded with an image URL as pending, and none without one or unrecorded", async () => {
      const withImage = await recorded(A);
      await recorded(A, null);
      await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      expect(await h.images.pendingImages(null, 100)).toEqual([
        { owner: A, linkId: withImage, imageUrl: IMG, role: "preview" },
      ]);
    });

    it("lists every owner's pending images in id order, a page at a time after afterId", async () => {
      const ids = [await recorded(A), await recorded(B), await recorded(A)];
      const first = await h.images.pendingImages(null, 2);
      expect(first.map((p) => [p.owner, p.linkId])).toEqual([
        [A, ids[0]],
        [B, ids[1]],
      ]);
      const rest = await h.images.pendingImages(first[1]?.linkId ?? null, 2);
      expect(rest.map((p) => p.linkId)).toEqual([ids[2]]);
    });

    it("stores a written image: it is no longer pending and reads back with its version", async () => {
      const id = await recorded(A);
      const image = pngBytes(1);
      expect(await h.images.writeImage(A, id, IMG, "preview", image, at(5))).toBe(true);
      expect(await pending()).toEqual([]);
      const version = sha256(image.bytes).slice(0, 16);
      expect(await h.images.image(A, id)).toEqual({ ...image, version });
      expect(await h.images.imageVersions(A, [id, "999"])).toEqual(
        new Map([[id, { version, fit: "cover" }]]),
      );
    });

    it("never shows A's image to B, and B cannot write or end A's", async () => {
      const id = await recorded(A);
      expect(await h.images.writeImage(B, id, IMG, "preview", pngBytes(9), at(5))).toBe(false);
      expect(await h.images.endImage(B, id, IMG, "preview", "none")).toBe(false);
      expect(await pending()).toEqual([id]);

      expect(await h.images.writeImage(A, id, IMG, "preview", pngBytes(1), at(5))).toBe(true);
      expect(await h.images.image(B, id)).toBeNull();
      expect(await h.images.imageVersions(B, [id])).toEqual(new Map());
    });

    it("refuses a late end after a write, keeping the stored bytes", async () => {
      const id = await recorded(A);
      await h.images.writeImage(A, id, IMG, "preview", pngBytes(1), at(5));
      expect(await h.images.endImage(A, id, IMG, "preview", "none")).toBe(false);
      expect(await h.images.image(A, id)).toMatchObject({ bytes: pngBytes(1).bytes });
      expect(await pending()).toEqual([]);
    });

    it("refuses a second write, keeping the first image", async () => {
      const id = await recorded(A);
      await h.images.writeImage(A, id, IMG, "preview", pngBytes(1), at(5));
      expect(await h.images.writeImage(A, id, IMG, "preview", pngBytes(2), at(6))).toBe(false);
      expect(await h.images.image(A, id)).toMatchObject({ bytes: pngBytes(1).bytes });
    });

    it("refuses a write or end for another image URL than the one pending", async () => {
      const id = await recorded(A);
      expect(
        await h.images.writeImage(A, id, "https://ex.com/old.png", "preview", pngBytes(1), at(5)),
      ).toBe(false);
      expect(await h.images.endImage(A, id, "https://ex.com/old.png", "preview", "none")).toBe(
        false,
      );
      expect(await h.images.image(A, id)).toBeNull();
      expect(await pending()).toEqual([id]);
    });

    it.each(["none", "refused"] as const)(
      "ends a pending image as %s, storing nothing",
      async (end) => {
        const id = await recorded(A);
        expect(await h.images.endImage(A, id, IMG, "preview", end)).toBe(true);
        expect(await pending()).toEqual([]);
        expect(await h.images.image(A, id)).toBeNull();
        expect(await h.images.writeImage(A, id, IMG, "preview", pngBytes(1), at(5))).toBe(false);
      },
    );

    it("answers ids never issued with false and no image", async () => {
      for (const id of ["0", "abc", "999", "-1"]) {
        expect(await h.images.writeImage(A, id, IMG, "preview", pngBytes(1), at(5))).toBe(false);
        expect(await h.images.endImage(A, id, IMG, "preview", "none")).toBe(false);
        expect(await h.images.image(A, id)).toBeNull();
      }
      expect(await h.images.imageVersions(A, ["0", "abc"])).toEqual(new Map());
    });

    it("lists an icon-only snapshot as pending for its first icon, as an icon, and stores it", async () => {
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      await recordAt(
        A,
        link.id,
        at(1),
        record({ imageUrl: null, iconUrls: [ICON, "https://ex.com/2.png"] }),
      );
      expect(await h.images.pendingImages(null, 100)).toEqual([
        { owner: A, linkId: link.id, imageUrl: ICON, role: "icon" },
      ]);
      expect(await h.images.writeImage(A, link.id, ICON, "icon", pngBytes(1), at(5))).toBe(true);
      expect(await pending()).toEqual([]);
      const version = sha256(pngBytes(1).bytes).slice(0, 16);
      expect(await h.images.imageVersions(A, [link.id])).toEqual(
        new Map([[link.id, { version, fit: "contain" }]]),
      );
      expect((await h.images.pictureInfo(A, [link.id])).get(link.id)).toEqual({
        own: false,
        pageVersion: version,
        pageFit: "contain",
      });
    });

    it.each(["pending", "none", "refused"] as const)(
      "★ retires a stored icon once a snapshot names a preview: with the preview %s, no read shows it",
      async (state) => {
        const id = await iconStored(A);
        expect((await h.images.imageVersions(A, [id])).size).toBe(1);
        await recordAt(A, id, at(50), record({ imageUrl: IMG, iconUrls: [ICON] }));
        if (state !== "pending") {
          expect(await h.images.endImage(A, id, IMG, "preview", state)).toBe(true);
        }
        await noIcon(id);
      },
    );

    it("★ keeps the icon gone when a later snapshot names only an icon again (no reader filter, no retiring on write)", async () => {
      const id = await iconStored(A);
      await recordAt(
        A,
        id,
        at(50),
        record({ status: "retrying", nextFetchAt: at(80), imageUrl: IMG }),
      );
      await recordAt(A, id, at(80), record({ imageUrl: null, iconUrls: ["https://ex.com/y.png"] }));
      await noIcon(id);
    });

    it("★ retires nothing for a record whose claim is stale", async () => {
      const id = await iconStored(A);
      const lease = await h.links.leaseSnapshot(A, id, at(50), at(150));
      if (!lease) throw new Error("expected a lease");
      expect(
        await h.links.recordSnapshot(A, id, lease.claim + 1000, record({ imageUrl: IMG })),
      ).toBe(false);
      expect(await h.images.image(A, id)).toMatchObject({ bytes: pngBytes(7).bytes });
    });

    it("★ keeps a stored preview when a later snapshot names another preview", async () => {
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      await recordAt(
        A,
        link.id,
        at(1),
        record({ status: "retrying", nextFetchAt: at(50), imageUrl: IMG }),
      );
      await h.images.writeImage(A, link.id, IMG, "preview", pngBytes(3), at(5));
      await recordAt(A, link.id, at(50), record({ imageUrl: "https://ex.com/new.png" }));
      expect(await h.images.image(A, link.id)).toMatchObject({ bytes: pngBytes(3).bytes });
    });

    it("★ compares on URL and role: once X is re-recorded as the preview, a result for X as an icon is refused", async () => {
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      await recordAt(
        A,
        link.id,
        at(1),
        record({ status: "retrying", nextFetchAt: at(50), imageUrl: null, iconUrls: [ICON] }),
      );
      await recordAt(A, link.id, at(50), record({ imageUrl: ICON }));
      expect(await h.images.writeImage(A, link.id, ICON, "icon", pngBytes(1), at(60))).toBe(false);
      expect(await h.images.endImage(A, link.id, ICON, "icon", "none")).toBe(false);
      expect(await pending()).toEqual([link.id]);
      expect(await h.images.image(A, link.id)).toBeNull();
      expect(await h.images.writeImage(A, link.id, ICON, "preview", pngBytes(1), at(61))).toBe(
        true,
      );
    });

    it("accepts a result for X as an icon after X -> Y -> X re-records (URL and role, not a generation)", async () => {
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      const icon = (url: string, next: Date | null) =>
        record({
          status: next ? "retrying" : "ok",
          nextFetchAt: next,
          imageUrl: null,
          iconUrls: [url],
        });
      await recordAt(A, link.id, at(1), icon(ICON, at(50)));
      await recordAt(A, link.id, at(50), icon("https://ex.com/y.png", at(80)));
      await recordAt(A, link.id, at(80), icon(ICON, null));
      expect(await h.images.writeImage(A, link.id, ICON, "icon", pngBytes(1), at(90))).toBe(true);
    });

    it("lists the preview, as a preview, when a snapshot names both; the icon cannot be ended", async () => {
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      await recordAt(A, link.id, at(1), record({ imageUrl: IMG, iconUrls: [ICON] }));
      expect(await h.images.pendingImages(null, 100)).toEqual([
        { owner: A, linkId: link.id, imageUrl: IMG, role: "preview" },
      ]);
      expect(await h.images.endImage(A, link.id, ICON, "icon", "none")).toBe(false);
      expect(await pending()).toEqual([link.id]);
    });

    it("never lets B write or end A's pending icon, and leaves A's stored bytes alone", async () => {
      const id = await iconStored(A);
      await recordAt(
        A,
        id,
        at(50),
        record({ status: "retrying", nextFetchAt: at(80), imageUrl: null, iconUrls: [ICON] }),
      );
      expect(await h.images.writeImage(B, id, ICON, "icon", pngBytes(9), at(60))).toBe(false);
      expect(await h.images.endImage(B, id, ICON, "icon", "none")).toBe(false);
      expect(await pending()).toEqual([id]);
      expect(await h.images.image(A, id)).toMatchObject({ bytes: pngBytes(7).bytes });
    });
  });
}
