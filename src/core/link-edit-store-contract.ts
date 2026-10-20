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
import type { LinkRemover, LinkStore } from "./store.js";
import type { LinkTag } from "./types.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type EditHarness = {
  links: LinkStore & SnapshotStore & LinkRemover;
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
      expect(await h.images.image(A, id, "page")).toEqual({
        ...png(1),
        version: v(png(1)),
        role: "preview",
      });
      expect(await h.images.pictureInfo(A, [id])).toEqual(
        new Map([[id, { own: true, pageVersion: v(png(1)), pageFit: "cover" }]]),
      );
    });

    it("image(…, 'own') reads only the owner's picture: null when only the page has one, never the page bytes", async () => {
      const id = await linkWith(A, { page: png(1) });
      expect(await h.images.image(A, id, "own")).toBeNull();
      await editId(h.edits.applyEdit(A, id, { picture: { set: png(2) } }, at(10)));
      expect(await h.images.image(A, id, "own")).toEqual({ ...png(2), version: v(png(2)) });
      await editId(h.edits.applyEdit(A, id, { picture: "page" }, at(11)));
      expect(await h.images.image(A, id, "own")).toBeNull();
      expect(await h.images.image(B, id, "own")).toBeNull();
    });

    it("image(…, 'page') carries the role of the row it read: icon for a site icon, preview for a page image", async () => {
      const ICON = "https://ex.com/icon.png";
      const previewId = await linkWith(A, { page: png(1) });
      const { link } = await h.links.insertIfAbsent(A, newLink(++n, at(0)));
      const lease = await h.links.leaseSnapshot(A, link.id, at(1), at(100));
      if (!lease) throw new Error("the new link's snapshot should be leasable");
      await h.links.recordSnapshot(
        A,
        link.id,
        lease.claim,
        record({ status: "retrying", nextFetchAt: at(50), imageUrl: null, iconUrls: [ICON] }),
      );
      expect(await h.images.writeImage(A, link.id, ICON, "icon", png(3), at(5))).toBe(true);
      expect(await h.images.image(A, link.id, "page")).toMatchObject({ role: "icon" });
      expect(await h.images.image(A, previewId, "page")).toMatchObject({ role: "preview" });
      expect(await h.images.image(A, previewId)).not.toHaveProperty("role");
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

    describe("receipts for an AI edit (updateWithReceipt)", () => {
      const tag = (key: string, source: LinkTag["source"] = "stated"): LinkTag => ({
        key,
        name: key,
        source,
        kind: "topic",
        kindSource: "inferred",
      });
      const receipt = (owner: string, id: string, patch: Parameters<LinkStore["update"]>[2]) =>
        h.links.updateWithReceipt(owner, id, patch, at(20));
      /** A link holding every covered field, so each round trip has something to put back. */
      const filled = async () => {
        const id = await linkWith(A, { title: "Old" });
        await h.links.update(A, id, {
          summary: "old summary",
          why: { text: "old why", source: "asked" },
          tags: [tag("a", "stated"), tag("b", "inferred")],
        });
        return id;
      };
      const covered = async (id: string) => {
        const l = await h.links.get(A, id);
        return { title: l?.title, summary: l?.summary, why: l?.why, tags: l?.tags };
      };

      it.each([
        ["title", { title: "New" }],
        ["summary", { summary: "new summary" }],
        ["why", { why: { text: "new why", source: "inferred" as const } }],
        ["tags", { tags: [tag("c", "inferred")] }],
      ])("puts back the %s exactly as it was, with its sources and order", async (_n, patch) => {
        const id = await filled();
        const before = await covered(id);
        const edit = await editId(receipt(A, id, patch));
        expect(await covered(id)).not.toEqual(before);
        expect(await h.edits.undoEdit(A, id, edit)).toBe("undone");
        expect(await covered(id)).toEqual(before);
      });

      it("puts back all four fields written together, and a removed title, summary, why and tags", async () => {
        const id = await filled();
        const before = await covered(id);
        const edit = await editId(
          receipt(A, id, { title: null, summary: null, why: null, tags: [] }),
        );
        expect(await covered(id)).toMatchObject({
          title: null,
          summary: null,
          why: null,
          tags: [],
        });
        expect(await h.edits.undoEdit(A, id, edit)).toBe("undone");
        expect(await covered(id)).toEqual(before);
      });

      it("writes no receipt when no covered field changes, and keeps an existing dialog record", async () => {
        const id = await filled();
        const dialog = await editId(h.edits.applyEdit(A, id, { title: "Dialog" }, at(10)));
        for (const patch of [
          { title: "Dialog" },
          { summary: "old summary" },
          { why: { text: "old why", source: "asked" as const } },
          { tags: [tag("a", "stated"), tag("b", "inferred")] },
          { state: "archived" as const },
          { lastOpenedAt: at(5) },
          {},
        ]) {
          expect((await receipt(A, id, patch))?.editId).toBeNull();
        }
        expect(await h.edits.undoEdit(A, id, dialog)).toBe("undone");
        expect((await h.links.get(A, id))?.title).toBe("Old");
      });

      it("returns the link as written, with the change", async () => {
        const id = await filled();
        const result = await receipt(A, id, { summary: "new summary", state: "archived" });
        expect(result?.link).toMatchObject({ summary: "new summary", state: "archived" });
        expect(result?.editId).toEqual(expect.any(String));
      });

      it.each([
        ["update", (id: string) => h.links.update(A, id, { summary: "later" })],
        [
          "updateIf",
          (id: string) => h.links.updateIf(A, id, {}, { why: { text: "later", source: "stated" } }),
        ],
        ["update of tags", (id: string) => h.links.update(A, id, { tags: [tag("z")] })],
      ])("conflicts after a later %s on a covered field, changing nothing", async (_n, later) => {
        const id = await filled();
        const edit = await editId(
          receipt(A, id, {
            summary: "ai summary",
            why: { text: "ai why", source: "inferred" },
            tags: [tag("c", "inferred")],
          }),
        );
        await later(id);
        const during = await covered(id);
        expect(await h.edits.undoEdit(A, id, edit)).toBe("conflict");
        expect(await covered(id)).toEqual(during);
      });

      it("does not conflict on a later change to an uncovered field", async () => {
        const id = await filled();
        const before = await covered(id);
        const edit = await editId(receipt(A, id, { summary: "ai summary" }));
        await h.links.update(A, id, { state: "archived" });
        expect(await h.edits.undoEdit(A, id, edit)).toBe("undone");
        expect(await covered(id)).toEqual(before);
        expect((await h.links.get(A, id))?.state).toBe("archived");
      });

      it("conflicts when the edit id is not the record's", async () => {
        const id = await filled();
        await editId(receipt(A, id, { summary: "ai summary" }));
        expect(await h.edits.undoEdit(A, id, "other")).toBe("conflict");
        expect((await h.links.get(A, id))?.summary).toBe("ai summary");
      });

      it("undoes a reordered tag set, a source-only change, a set to empty and a set from empty", async () => {
        const id = await filled();
        const original = (await h.links.get(A, id))?.tags;
        const reorder = await editId(
          receipt(A, id, { tags: [tag("b", "inferred"), tag("a", "stated")] }),
        );
        expect((await h.links.get(A, id))?.tags.map((t) => t.key)).toEqual(["b", "a"]);
        expect(await h.edits.undoEdit(A, id, reorder)).toBe("undone");
        expect((await h.links.get(A, id))?.tags).toEqual(original);

        const source = await editId(
          receipt(A, id, { tags: [tag("a", "inferred"), tag("b", "inferred")] }),
        );
        expect(await h.edits.undoEdit(A, id, source)).toBe("undone");
        expect((await h.links.get(A, id))?.tags).toEqual(original);

        const toEmpty = await editId(receipt(A, id, { tags: [] }));
        expect((await h.links.get(A, id))?.tags).toEqual([]);
        expect(await h.edits.undoEdit(A, id, toEmpty)).toBe("undone");
        expect((await h.links.get(A, id))?.tags).toEqual(original);

        const bare = await linkWith(A);
        const fromEmpty = await editId(receipt(A, bare, { tags: [tag("q", "inferred")] }));
        expect(await h.edits.undoEdit(A, bare, fromEmpty)).toBe("undone");
        expect((await h.links.get(A, bare))?.tags).toEqual([]);
      });

      it("never touches the catalog: a new tag's row stays and a changed kind is kept", async () => {
        const id = await filled();
        const edit = await editId(receipt(A, id, { tags: [tag("new", "inferred")] }));
        expect(await h.links.updateTag(A, "a", { kind: "project" }, "topic")).not.toBeNull();
        const catalog = (await h.links.listTags(A)).map((t) => [t.key, t.kind]);
        expect(await h.edits.undoEdit(A, id, edit)).toBe("undone");
        expect((await h.links.get(A, id))?.tags.map((t) => [t.key, t.kind])).toEqual([
          ["a", "project"],
          ["b", "topic"],
        ]);
        expect((await h.links.listTags(A)).map((t) => [t.key, t.kind])).toEqual(catalog);
        expect(catalog).toContainEqual(["new", "topic"]);
      });

      it("a dialog picture edit then an AI title receipt: only the receipt can be undone, and the picture stays", async () => {
        const id = await linkWith(A, { title: "Old", page: png(1) });
        const e1 = await editId(h.edits.applyEdit(A, id, { picture: { set: png(2) } }, at(10)));
        const e2 = await editId(receipt(A, id, { title: "AI" }));
        expect(await h.edits.undoEdit(A, id, e1)).toBe("conflict");
        expect(await h.edits.undoEdit(A, id, e2)).toBe("undone");
        expect(await shows(A, id)).toMatchObject({ title: "Old", version: v(png(2)) });
      });

      it("an AI receipt then a dialog title edit: only the dialog edit can be undone", async () => {
        const id = await linkWith(A, { title: "Old" });
        const e1 = await editId(receipt(A, id, { summary: "ai summary" }));
        const e2 = await editId(h.edits.applyEdit(A, id, { title: "Dialog" }, at(21)));
        expect(await h.edits.undoEdit(A, id, e1)).toBe("conflict");
        expect((await h.links.get(A, id))?.summary).toBe("ai summary");
        expect(await h.edits.undoEdit(A, id, e2)).toBe("undone");
        expect((await h.links.get(A, id))?.title).toBe("Old");
      });

      it("reads another owner's link and a deleted link as absent, writing nothing", async () => {
        const id = await filled();
        const edit = await editId(receipt(A, id, { summary: "ai summary" }));
        expect(await receipt(B, id, { summary: "b's", tags: [tag("bt")] })).toBeNull();
        expect(await h.edits.undoEdit(B, id, edit)).toBeNull();
        expect(await h.links.listTags(B)).toEqual([]);
        expect((await h.links.get(A, id))?.summary).toBe("ai summary");

        expect(await h.links.markDeleted(A, id, at(30))).toBe(true);
        expect(await receipt(A, id, { summary: "late" })).toBeNull();
        expect(await h.edits.undoEdit(A, id, edit)).toBeNull();
        expect(await h.links.unmarkDeleted(A, id, at(30))).toBe(true);
        expect(await h.edits.undoEdit(A, id, edit)).toBe("undone");
        expect((await h.links.get(A, id))?.summary).toBe("old summary");
      });

      it("answers ids never issued with null", async () => {
        for (const id of ["0", "abc", "999", "-1"]) {
          expect(await receipt(A, id, { summary: "x" })).toBeNull();
        }
      });
    });
  });
}
