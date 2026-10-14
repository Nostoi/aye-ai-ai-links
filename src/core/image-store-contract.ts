import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImageBytes, ImageStore, LinkImageReader } from "./image-store.js";
import type { SnapshotStore } from "./snapshot-store.js";
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
        { owner: A, linkId: withImage, imageUrl: IMG },
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
      expect(await h.images.writeImage(A, id, IMG, image, at(5))).toBe(true);
      expect(await pending()).toEqual([]);
      const version = sha256(image.bytes).slice(0, 16);
      expect(await h.images.image(A, id)).toEqual({ ...image, version });
      expect(await h.images.imageVersions(A, [id, "999"])).toEqual(new Map([[id, version]]));
    });

    it("never shows A's image to B, and B cannot write or end A's", async () => {
      const id = await recorded(A);
      expect(await h.images.writeImage(B, id, IMG, pngBytes(9), at(5))).toBe(false);
      expect(await h.images.endImage(B, id, IMG, "none")).toBe(false);
      expect(await pending()).toEqual([id]);

      expect(await h.images.writeImage(A, id, IMG, pngBytes(1), at(5))).toBe(true);
      expect(await h.images.image(B, id)).toBeNull();
      expect(await h.images.imageVersions(B, [id])).toEqual(new Map());
    });

    it("refuses a late end after a write, keeping the stored bytes", async () => {
      const id = await recorded(A);
      await h.images.writeImage(A, id, IMG, pngBytes(1), at(5));
      expect(await h.images.endImage(A, id, IMG, "none")).toBe(false);
      expect(await h.images.image(A, id)).toMatchObject({ bytes: pngBytes(1).bytes });
      expect(await pending()).toEqual([]);
    });

    it("refuses a second write, keeping the first image", async () => {
      const id = await recorded(A);
      await h.images.writeImage(A, id, IMG, pngBytes(1), at(5));
      expect(await h.images.writeImage(A, id, IMG, pngBytes(2), at(6))).toBe(false);
      expect(await h.images.image(A, id)).toMatchObject({ bytes: pngBytes(1).bytes });
    });

    it("refuses a write or end for another image URL than the one pending", async () => {
      const id = await recorded(A);
      expect(await h.images.writeImage(A, id, "https://ex.com/old.png", pngBytes(1), at(5))).toBe(
        false,
      );
      expect(await h.images.endImage(A, id, "https://ex.com/old.png", "none")).toBe(false);
      expect(await h.images.image(A, id)).toBeNull();
      expect(await pending()).toEqual([id]);
    });

    it.each(["none", "refused"] as const)(
      "ends a pending image as %s, storing nothing",
      async (end) => {
        const id = await recorded(A);
        expect(await h.images.endImage(A, id, IMG, end)).toBe(true);
        expect(await pending()).toEqual([]);
        expect(await h.images.image(A, id)).toBeNull();
        expect(await h.images.writeImage(A, id, IMG, pngBytes(1), at(5))).toBe(false);
      },
    );

    it("answers ids never issued with false and no image", async () => {
      for (const id of ["0", "abc", "999", "-1"]) {
        expect(await h.images.writeImage(A, id, IMG, pngBytes(1), at(5))).toBe(false);
        expect(await h.images.endImage(A, id, IMG, "none")).toBe(false);
        expect(await h.images.image(A, id)).toBeNull();
      }
      expect(await h.images.imageVersions(A, ["0", "abc"])).toEqual(new Map());
    });
  });
}
