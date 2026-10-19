import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ImageBytes,
  type ImageStore,
  imageVersion,
  type LinkImageReader,
} from "./image-store.js";
import type { LinkEditStore } from "./link-edit-store.js";
import type { SnapshotStore } from "./snapshot-store.js";
import { A, at, B, newLink, record } from "./snapshot-store-contract.js";
import type { LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type EditHarness = {
  links: LinkStore & SnapshotStore;
  images: ImageStore & LinkImageReader;
  edits: LinkEditStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

const IMG = "https://ex.com/page.png";
const png = (n: number): ImageBytes => ({
  contentType: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]),
});
const v = (image: ImageBytes) =>
  imageVersion(createHash("sha256").update(image.bytes).digest("hex"));

export function describeLinkEditStoreContract(
  name: string,
  makeHarness: () => EditHarness | Promise<EditHarness>,
): void {
  describe(name, () => {
    let h: EditHarness;
    let n: number;

    /** A link of `owner` titled `title`; its page picture is pending, and stored when `page` is given. */
    const linkWith = async (
      owner: string,
      { title = "Page", page }: { title?: string | null; page?: ImageBytes } = {},
    ): Promise<string> => {
      const { link } = await h.links.insertIfAbsent(owner, { ...newLink(++n, at(0)), title });
      const lease = await h.links.leaseSnapshot(owner, link.id, at(1), at(100));
      if (!lease) throw new Error("the new link's snapshot should be leasable");
      await h.links.recordSnapshot(owner, link.id, lease.claim, record({ imageUrl: IMG }));
      if (page)
        expect(await h.images.writeImage(owner, link.id, IMG, "preview", page, at(2))).toBe(true);
      return link.id;
    };
    /** What a card and the dialog read for the link. */
    const shows = async (owner: string, id: string) => ({
      title: (await h.links.get(owner, id))?.title,
      version: (await h.images.imageVersions(owner, [id])).get(id)?.version ?? null,
      info: (await h.images.pictureInfo(owner, [id])).get(id) ?? null,
    });
    const editId = async (p: Promise<{ editId: string | null } | null>) => {
      const result = await p;
      if (!result?.editId) throw new Error(`expected an edit id, got ${JSON.stringify(result)}`);
      return result.editId;
    };

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("shows the owner's picture over the fetched one in every read; image(…, 'page') serves the fetched one", async () => {
      const id = await linkWith(A, { page: png(1) });
      await editId(h.edits.applyEdit(A, id, { picture: { set: png(2) } }, at(10)));
      expect(await h.images.imageVersions(A, [id])).toEqual(
        new Map([[id, { version: v(png(2)), fit: "cover" }]]),
      );
      expect(await h.images.image(A, id)).toEqual({ ...png(2), version: v(png(2)) });
      expect(await h.images.image(A, id, "page")).toEqual({ ...png(1), version: v(png(1)) });
      expect(await h.images.pictureInfo(A, [id])).toEqual(
        new Map([[id, { own: true, pageVersion: v(png(1)), pageFit: "cover" }]]),
      );
    });

    it("keeps the owner's picture showing when a fetch lands after it", async () => {
      const id = await linkWith(A);
      await editId(h.edits.applyEdit(A, id, { picture: { set: png(2) } }, at(10)));
      expect(await h.images.writeImage(A, id, IMG, "preview", png(1), at(11))).toBe(true);
      expect(await shows(A, id)).toEqual({
        title: "Page",
        version: v(png(2)),
        info: { own: true, pageVersion: v(png(1)), pageFit: "cover" },
      });
    });

    it("'page' removes the owner's picture, so the fetched one shows again, or none", async () => {
      const withPage = await linkWith(A, { page: png(1) });
      await editId(h.edits.applyEdit(A, withPage, { picture: { set: png(2) } }, at(10)));
      await editId(h.edits.applyEdit(A, withPage, { picture: "page" }, at(11)));
      expect(await shows(A, withPage)).toEqual({
        title: "Page",
        version: v(png(1)),
        info: { own: false, pageVersion: v(png(1)), pageFit: "cover" },
      });
      const bare = await linkWith(A);
      await editId(h.edits.applyEdit(A, bare, { picture: { set: png(3) } }, at(12)));
      await editId(h.edits.applyEdit(A, bare, { picture: "page" }, at(13)));
      expect(await shows(A, bare)).toEqual({ title: "Page", version: null, info: null });
      expect(await h.images.image(A, bare)).toBeNull();
    });

    it("★ an owner picture over an icon shows as cover; removing it shows the icon whole again", async () => {
      const { link } = await h.links.insertIfAbsent(A, { ...newLink(++n, at(0)), title: "Page" });
      const lease = await h.links.leaseSnapshot(A, link.id, at(1), at(100));
      if (!lease) throw new Error("expected a lease");
      await h.links.recordSnapshot(
        A,
        link.id,
        lease.claim,
        record({ imageUrl: null, iconUrls: [IMG] }),
      );
      expect(await h.images.writeImage(A, link.id, IMG, "icon", png(1), at(2))).toBe(true);
      expect(await h.images.imageVersions(A, [link.id])).toEqual(
        new Map([[link.id, { version: v(png(1)), fit: "contain" }]]),
      );
      await editId(h.edits.applyEdit(A, link.id, { picture: { set: png(2) } }, at(10)));
      expect(await h.images.imageVersions(A, [link.id])).toEqual(
        new Map([[link.id, { version: v(png(2)), fit: "cover" }]]),
      );
      expect((await h.images.pictureInfo(A, [link.id])).get(link.id)).toEqual({
        own: true,
        pageVersion: v(png(1)),
        pageFit: "contain",
      });
      await editId(h.edits.applyEdit(A, link.id, { picture: "page" }, at(11)));
      expect(await h.images.imageVersions(A, [link.id])).toEqual(
        new Map([[link.id, { version: v(png(1)), fit: "contain" }]]),
      );
    });

    it("writes the title it is given, including none", async () => {
      const id = await linkWith(A, { title: "Old" });
      await editId(h.edits.applyEdit(A, id, { title: "New" }, at(10)));
      expect((await h.links.get(A, id))?.title).toBe("New");
      await editId(h.edits.applyEdit(A, id, { title: null }, at(11)));
      expect((await h.links.get(A, id))?.title).toBeNull();
    });

    it("returns no edit id and keeps the last record when nothing would change", async () => {
      const id = await linkWith(A, { title: "Same", page: png(1) });
      expect(await h.edits.applyEdit(A, id, { title: "Same" }, at(10))).toEqual({ editId: null });
      expect(await h.edits.applyEdit(A, id, { picture: "page" }, at(10))).toEqual({ editId: null });
      expect(await h.edits.applyEdit(A, id, {}, at(10))).toEqual({ editId: null });
      const set = await editId(h.edits.applyEdit(A, id, { picture: { set: png(2) } }, at(11)));
      expect(
        await h.edits.applyEdit(A, id, { title: "Same", picture: { set: png(2) } }, at(12)),
      ).toEqual({ editId: null });
      // The no-change calls replaced no record: the earlier edit's Undo still works.
      expect(await h.edits.undoEdit(A, id, set)).toBe("undone");
    });

    it("Undo puts back the title and owner picture the edit replaced, once", async () => {
      const id = await linkWith(A, { title: "Old", page: png(1) });
      await editId(h.edits.applyEdit(A, id, { picture: { set: png(2) } }, at(10)));
      const edit = await editId(
        h.edits.applyEdit(A, id, { title: "New", picture: { set: png(3) } }, at(11)),
      );
      expect(await h.edits.undoEdit(A, id, edit)).toBe("undone");
      const after = {
        title: "Old",
        version: v(png(2)),
        info: { own: true, pageVersion: v(png(1)), pageFit: "cover" },
      };
      expect(await shows(A, id)).toEqual(after);
      expect(await h.images.image(A, id)).toEqual({ ...png(2), version: v(png(2)) });
      expect(await h.edits.undoEdit(A, id, edit)).toBe("conflict");
      expect(await shows(A, id)).toEqual(after);
    });

    it("Undo of the first owner picture removes it; Undo of a removal brings it back", async () => {
      const id = await linkWith(A, { page: png(1) });
      const first = await editId(h.edits.applyEdit(A, id, { picture: { set: png(2) } }, at(10)));
      expect(await h.edits.undoEdit(A, id, first)).toBe("undone");
      expect((await shows(A, id)).info).toEqual({
        own: false,
        pageVersion: v(png(1)),
        pageFit: "cover",
      });
      await editId(h.edits.applyEdit(A, id, { picture: { set: png(2) } }, at(11)));
      const removal = await editId(h.edits.applyEdit(A, id, { picture: "page" }, at(12)));
      expect(await h.edits.undoEdit(A, id, removal)).toBe("undone");
      expect(await h.images.image(A, id)).toEqual({ ...png(2), version: v(png(2)) });
    });

    it("a stale Undo conflicts: after edits A then B, Undo of A keeps B's title and picture", async () => {
      const id = await linkWith(A, { title: "Start" });
      const a = await editId(
        h.edits.applyEdit(A, id, { title: "A", picture: { set: png(1) } }, at(10)),
      );
      const b = await editId(
        h.edits.applyEdit(A, id, { title: "B", picture: { set: png(2) } }, at(11)),
      );
      expect(await h.edits.undoEdit(A, id, a)).toBe("conflict");
      expect(await shows(A, id)).toEqual({
        title: "B",
        version: v(png(2)),
        info: { own: true, pageVersion: null, pageFit: null },
      });
      expect(await h.edits.undoEdit(A, id, b)).toBe("undone");
      expect(await shows(A, id)).toMatchObject({ title: "A", version: v(png(1)) });
    });

    it("Undo conflicts after an agent changed the title, keeping the agent's title and the edit's picture", async () => {
      const id = await linkWith(A, { title: "Start" });
      const edit = await editId(
        h.edits.applyEdit(A, id, { title: "Mine", picture: { set: png(1) } }, at(10)),
      );
      await h.links.update(A, id, { title: "Agent's" });
      expect(await h.edits.undoEdit(A, id, edit)).toBe("conflict");
      expect(await shows(A, id)).toMatchObject({ title: "Agent's", version: v(png(1)) });
    });

    it("Undo of a picture-only edit ignores a title change since, leaving that title", async () => {
      const id = await linkWith(A, { title: "Start" });
      const edit = await editId(h.edits.applyEdit(A, id, { picture: { set: png(1) } }, at(10)));
      await h.links.update(A, id, { title: "Agent's" });
      expect(await h.edits.undoEdit(A, id, edit)).toBe("undone");
      expect(await shows(A, id)).toEqual({ title: "Agent's", version: null, info: null });
    });

    it("never touches another owner's link: B's edit and Undo read as absent and A's state stays", async () => {
      const id = await linkWith(A, { title: "A's", page: png(1) });
      const edit = await editId(h.edits.applyEdit(A, id, { title: "A edited" }, at(10)));
      const before = await shows(A, id);
      expect(
        await h.edits.applyEdit(B, id, { title: "B's", picture: { set: png(9) } }, at(11)),
      ).toBeNull();
      expect(await h.edits.undoEdit(B, id, edit)).toBeNull();
      expect(await shows(A, id)).toEqual(before);
      expect(await h.images.imageVersions(B, [id])).toEqual(new Map());
      expect(await h.images.pictureInfo(B, [id])).toEqual(new Map());
      expect(await h.images.image(B, id, "page")).toBeNull();
      expect(await h.edits.undoEdit(A, id, edit)).toBe("undone");
    });

    it("answers ids never issued with null and no pictures", async () => {
      for (const id of ["0", "abc", "999", "-1"]) {
        expect(await h.edits.applyEdit(A, id, { title: "x" }, at(10))).toBeNull();
        expect(await h.edits.undoEdit(A, id, "e")).toBeNull();
        expect(await h.images.image(A, id, "page")).toBeNull();
      }
      expect(await h.images.pictureInfo(A, ["0", "abc"])).toEqual(new Map());
    });
  });
}
