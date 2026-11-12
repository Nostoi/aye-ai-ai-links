import { beforeEach, describe, expect, it } from "vitest";
import { FAVICON_DISCOVERY_VERSION } from "./favicon-store.js";
import type { FaviconRow } from "./favicon-store-contract.js";
import type { IconBackfillStore } from "./icon-backfill-store.js";
import type { ImageBytes, ImageStore, LinkImageReader } from "./image-store.js";
import type { LinkCheck, LinkCheckStore } from "./link-check-store.js";
import type { LinkEditStore } from "./link-edit-store.js";
import type { SnapshotRecord, SnapshotStore } from "./snapshot-store.js";
import { A, at, B, newLink, record } from "./snapshot-store-contract.js";
import type { LinkRemover, LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type IconBackfillHarness = {
  links: LinkStore & SnapshotStore & LinkRemover;
  images: ImageStore & LinkImageReader & IconBackfillStore;
  checks: LinkCheckStore;
  edits: LinkEditStore;
  addOwner(owner: string): MaybeAsync<void>;
  /** The snapshot's `image_status` as stored. Test inspection only. */
  imageStatus(owner: string, linkId: string): MaybeAsync<string | null>;
  /** Sets `image_status` back to NULL, as a snapshot recorded before PR B has it. Test seeding only. */
  forgetIconCheck(owner: string, linkId: string): MaybeAsync<void>;
  /** The link's favicon row, or null when it has none. Test inspection only. */
  faviconRow(owner: string, linkId: string): MaybeAsync<FaviconRow | null>;
  /** Sets the status, discovery version and (when given) generation of an existing favicon row; `ok` gets bytes. Test seeding only. */
  seedFavicon(
    owner: string,
    linkId: string,
    row: { status: "pending" | "ok" | "none" | "refused"; discovery: number; generation?: number },
  ): MaybeAsync<void>;
};

const IMG = "https://ex.com/i.png";
const ICON = "https://ex.com/icon.png";
const ICON2 = "https://ex.com/icon2.png";
const ICON3 = "https://ex.com/icon3.png";
const PNG: ImageBytes = {
  contentType: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
};
const gone: LinkCheck = {
  checkedAt: at(100),
  result: "dead",
  detail: "http:404",
  firstDeadAt: at(90),
  flaggedAt: at(100),
  stillWorksAt: null,
};
const alive: LinkCheck = {
  checkedAt: at(200),
  result: "alive",
  detail: null,
  firstDeadAt: null,
  flaggedAt: null,
  stillWorksAt: null,
};
const failedRecord = record({
  status: "failed",
  fetchedAt: null,
  title: null,
  description: null,
  imageUrl: null,
  text: null,
  lastError: "fetch:http:404",
});

export function describeIconBackfillStoreContract(
  name: string,
  makeHarness: () => IconBackfillHarness | Promise<IconBackfillHarness>,
): void {
  describe(name, () => {
    let h: IconBackfillHarness;
    let n: number;

    /** A link of `owner` whose snapshot was recorded as `r`. */
    const recorded = async (owner: string, r: SnapshotRecord): Promise<string> => {
      const { link } = await h.links.insertIfAbsent(owner, newLink(++n, at(0)));
      const lease = await h.links.leaseSnapshot(owner, link.id, at(1), at(100));
      if (!lease) throw new Error("the new link's snapshot should be leasable");
      expect(await h.links.recordSnapshot(owner, link.id, lease.claim, r)).toBe(true);
      return link.id;
    };
    /** A link snapshotted before icons were looked for (R7). */
    const legacy = async (owner = A, over: Partial<SnapshotRecord> = {}): Promise<string> => {
      const id = await recorded(owner, record({ imageUrl: null, ...over }));
      await h.forgetIconCheck(owner, id);
      return id;
    };
    const candidates = async () => (await h.images.iconCandidates(null, 100)).map((c) => c.linkId);
    /** Everything the backfill must not change, plus what it may. */
    const stateOf = async (owner: string, id: string) => ({
      status: await h.imageStatus(owner, id),
      snapshot: (await h.links.get(owner, id))?.snapshot ?? null,
      text: await h.links.getSnapshotText(owner, id),
      pending: await h.images.pendingImages(null, 100),
    });

    beforeEach(async () => {
      h = await makeHarness();
      n = 0;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("lists a link snapshotted before icons were looked for, with its owner and address", async () => {
      const id = await legacy();
      expect(await h.images.iconCandidates(null, 100)).toEqual([
        { owner: A, linkId: id, url: "https://ex.com/1" },
      ]);
    });

    it("★ leaves out a link whose snapshot looked and found nothing, which is listed only as it was before PR B", async () => {
      // [Leaving a found-nothing snapshot NULL, so the backfill fetches it again.]
      const looked = await recorded(A, record({ imageUrl: null }));
      expect(await h.imageStatus(A, looked)).toBe("none");
      expect(await candidates()).toEqual([]);
      await h.forgetIconCheck(A, looked);
      expect(await candidates()).toEqual([looked]);
    });

    it.each<[string, () => Promise<string>]>([
      [
        "flagged gone",
        async () => {
          const id = await legacy();
          expect((await h.checks.updateCheckIf(A, id, null, gone))?.applied).toBe(true);
          return id;
        },
      ],
      ["naming a preview", () => legacy(A, { imageUrl: IMG })],
      ["already looked at", () => recorded(A, record({ imageUrl: null, iconUrls: [ICON] }))],
      ["whose snapshot is not ok", () => recorded(A, failedRecord)],
      [
        "with a fetched picture",
        async () => {
          const id = await recorded(A, record({ imageUrl: null, iconUrls: [ICON] }));
          expect(await h.images.writeImage(A, id, ICON, "icon", PNG, at(5))).toBe(true);
          await h.forgetIconCheck(A, id);
          return id;
        },
      ],
    ])("★ leaves out a link %s, one rule at a time", async (_name, seed) => {
      // [Dropping that clause from the candidate read.]
      await seed();
      const control = await legacy();
      expect(await candidates()).toEqual([control]);
    });

    it("lists a link with an owner picture and an archived link (controller ruling 6)", async () => {
      const own = await legacy();
      expect(await h.edits.applyEdit(A, own, { picture: { set: PNG } }, at(6))).not.toBeNull();
      const archived = await legacy();
      expect(await h.links.update(A, archived, { state: "archived" })).not.toBeNull();
      expect(await candidates()).toEqual([own, archived]);
    });

    it("★ lists a link again once its dead flag clears", async () => {
      // [Selecting on any link_checks row rather than on a flag that is set now.]
      const id = await legacy();
      await h.checks.updateCheckIf(A, id, null, gone);
      expect(await candidates()).toEqual([]);
      expect((await h.checks.updateCheckIf(A, id, gone, alive))?.applied).toBe(true);
      expect(await candidates()).toEqual([id]);
    });

    it("lists every owner's candidates in id order, a page at a time after afterId", async () => {
      const ids = [await legacy(A), await legacy(B), await legacy(A)];
      const first = await h.images.iconCandidates(null, 2);
      expect(first.map((c) => [c.owner, c.linkId])).toEqual([
        [A, ids[0]],
        [B, ids[1]],
      ]);
      const rest = await h.images.iconCandidates(first[1]?.linkId ?? null, 2);
      expect(rest.map((c) => [c.owner, c.linkId])).toEqual([[A, ids[2]]]);
    });

    it("records two icons: the first is pending as an icon, and the second follows when it ends", async () => {
      const id = await legacy();
      expect(await h.images.recordIconCheck(A, id, [ICON, ICON2], null)).toBe(true);
      expect(await h.imageStatus(A, id)).toBe("pending");
      expect(await candidates()).toEqual([]);
      expect(await h.images.pendingImages(null, 100)).toEqual([
        { owner: A, linkId: id, imageUrl: ICON, role: "icon" },
      ]);
      expect(await h.images.endImage(A, id, ICON, "icon", "none")).toBe(true);
      expect(await h.images.pendingImages(null, 100)).toEqual([
        { owner: A, linkId: id, imageUrl: ICON2, role: "icon" },
      ]);
    });

    it("records none: nothing is pending and the link is no longer a candidate", async () => {
      const id = await legacy();
      expect(await h.images.recordIconCheck(A, id, [], null)).toBe(true);
      expect(await h.imageStatus(A, id)).toBe("none");
      expect(await h.images.pendingImages(null, 100)).toEqual([]);
      expect(await candidates()).toEqual([]);
    });

    it("★ changes nothing but the icon check: title, description, text, status and preview stay", async () => {
      // [An update that also writes the snapshot's other columns.]
      const id = await legacy();
      const before = await stateOf(A, id);
      expect(await h.images.recordIconCheck(A, id, [ICON], null)).toBe(true);
      const after = await stateOf(A, id);
      expect(after.snapshot).toEqual(before.snapshot);
      expect(after.text).toBe("body text");
      expect(after.text).toBe(before.text);
    });

    it.each<
      [string, () => Promise<{ owner: string; id: string; writer: string; icons: string[] }>]
    >([
      [
        "not ok",
        async () => ({ owner: A, id: await recorded(A, failedRecord), writer: A, icons: [ICON] }),
      ],
      [
        "naming a preview",
        async () => ({
          owner: A,
          id: await legacy(A, { imageUrl: IMG }),
          writer: A,
          icons: [ICON],
        }),
      ],
      [
        "already looked at, found nothing",
        async () => ({
          owner: A,
          id: await recorded(A, record({ imageUrl: null })),
          writer: A,
          icons: [ICON],
        }),
      ],
      [
        "already looked at, icon pending",
        async () => {
          const id = await legacy();
          expect(await h.images.recordIconCheck(A, id, [ICON], null)).toBe(true);
          return { owner: A, id, writer: A, icons: [ICON2] };
        },
      ],
      [
        "another owner's",
        async () => ({ owner: A, id: await legacy(A), writer: B, icons: [ICON] }),
      ],
      [
        "with more than MAX_ICON_URLS icons",
        async () => ({ owner: A, id: await legacy(A), writer: A, icons: [ICON, ICON2, ICON3] }),
      ],
    ])("★ refuses a snapshot %s, changing nothing", async (_name, seed) => {
      // [An unconditional update, or one missing that WHERE clause (R8).]
      const { owner, id, writer, icons } = await seed();
      const before = await stateOf(owner, id);
      const listed = await candidates();
      expect(await h.images.recordIconCheck(writer, id, icons, null)).toBe(false);
      expect(await stateOf(owner, id)).toEqual(before);
      expect(await candidates()).toEqual(listed);
    });

    it.each<[string, boolean, () => Promise<{ id: string; writer: string }>]>([
      ["a legacy link", true, async () => ({ id: await legacy(), writer: A })],
      [
        "an owner picture",
        true,
        async () => {
          const id = await legacy();
          expect(await h.edits.applyEdit(A, id, { picture: { set: PNG } }, at(6))).not.toBeNull();
          return { id, writer: A };
        },
      ],
      [
        "a preview named",
        false,
        async () => ({ id: await legacy(A, { imageUrl: IMG }), writer: A }),
      ],
      [
        "already looked at, found nothing",
        false,
        async () => ({ id: await recorded(A, record({ imageUrl: null })), writer: A }),
      ],
      [
        "a snapshot that is not ok",
        false,
        async () => ({ id: await recorded(A, failedRecord), writer: A }),
      ],
      [
        "image_status already set",
        false,
        async () => {
          const id = await legacy();
          expect(await h.images.recordIconCheck(A, id, [ICON2], null)).toBe(true);
          return { id, writer: A };
        },
      ],
      [
        "flagged gone",
        false,
        async () => {
          const id = await legacy();
          expect((await h.checks.updateCheckIf(A, id, null, gone))?.applied).toBe(true);
          return { id, writer: A };
        },
      ],
      [
        "a fetched picture",
        false,
        async () => {
          const id = await recorded(A, record({ imageUrl: null, iconUrls: [ICON] }));
          expect(await h.images.writeImage(A, id, ICON, "icon", PNG, at(5))).toBe(true);
          await h.forgetIconCheck(A, id);
          return { id, writer: A };
        },
      ],
      ["another owner's link", false, async () => ({ id: await legacy(A), writer: B })],
    ])("★ the candidate read and the check's write agree: %s", async (_name, expected, seed) => {
      // [A row the read lists but the write refuses burns the backfill's retry budget; the reverse hides a link for good.]
      const { id, writer } = await seed();
      const listed = (await h.images.iconCandidates(null, 100)).some(
        (c) => c.owner === writer && c.linkId === id,
      );
      expect(listed).toBe(expected);
      expect(await h.images.recordIconCheck(writer, id, [ICON], null)).toBe(listed);
    });

    it("answers an id never issued with false", async () => {
      expect(await h.images.recordIconCheck(A, "999", [ICON], null)).toBe(false);
      expect(await h.images.recordIconCheck(A, "nope", [], null)).toBe(false);
    });

    describe("links that name a preview, for the word-picture check (#193)", () => {
      const named = async () =>
        (await h.images.wordPictureCandidates(null, 100)).map((c) => c.linkId);
      /** A link whose snapshot named IMG, with that preview fetched. */
      const withPreview = async (owner = A, over: Partial<SnapshotRecord> = {}) => {
        const id = await recorded(owner, record({ imageUrl: IMG, iconUrls: [ICON], ...over }));
        expect(await h.images.writeImage(owner, id, IMG, "preview", PNG, at(5))).toBe(true);
        return id;
      };

      it("lists a link naming a preview, with its owner, address and preview", async () => {
        const id = await withPreview();
        await legacy();
        expect(await h.images.wordPictureCandidates(null, 100)).toEqual([
          { owner: A, linkId: id, url: "https://ex.com/1", imageUrl: IMG },
        ]);
      });

      it("★ lists one whose extraction ended badly but kept the metadata (finding 2)", async () => {
        // [Asking for an ok snapshot, which leaves these with their preview for good.]
        const ids = [];
        for (const status of ["extract_timeout", "extract_crashed", "extract_out_of_memory"]) {
          ids.push(
            await withPreview(A, {
              status: status as SnapshotRecord["status"],
              text: null,
              lastError: "extract:x",
            }),
          );
        }
        expect(await named()).toEqual(ids);
      });

      it("★ lists a link flagged gone, and every owner's, in id order a page at a time", async () => {
        // [Copying the icon candidates' dead-flag clause, which keeps a dead link's preview for good.]
        const ids = [await withPreview(A), await withPreview(B), await withPreview(A)];
        expect((await h.checks.updateCheckIf(A, ids[0] as string, null, gone))?.applied).toBe(true);
        const first = await h.images.wordPictureCandidates(null, 2);
        expect(first.map((c) => [c.owner, c.linkId])).toEqual([
          [A, ids[0]],
          [B, ids[1]],
        ]);
        const rest = await h.images.wordPictureCandidates(first[1]?.linkId ?? null, 2);
        expect(rest.map((c) => [c.owner, c.linkId])).toEqual([[A, ids[2]]]);
      });

      it("★ leaves out a deleted link, and lists it again once its delete is undone (finding 3)", async () => {
        // [Listing a hidden link, or forgetting it for good.]
        const id = await withPreview();
        expect(await h.links.markDeleted(A, id, at(50))).toBe(true);
        expect(await named()).toEqual([]);
        expect(await h.links.unmarkDeleted(A, id, at(50))).toBe(true);
        expect(await named()).toEqual([id]);
      });

      it("★ replaces the preview with the fresh icons: the first is pending, the preview gone", async () => {
        // [Keeping the snapshot's old icon candidates, or the fetched preview.]
        const id = await withPreview();
        expect(await h.images.recordWordPictureCheck(A, id, IMG, [ICON2, ICON3], null)).toBe(true);
        expect(await h.imageStatus(A, id)).toBe("pending");
        expect(await h.images.pendingImages(null, 100)).toEqual([
          { owner: A, linkId: id, imageUrl: ICON2, role: "icon" },
        ]);
        expect(await h.images.image(A, id, "page")).toBeNull();
        expect((await h.links.get(A, id))?.snapshot?.imageUrl).toBeNull();
        expect(await named()).toEqual([]);
        expect(await h.images.endImage(A, id, ICON2, "icon", "none")).toBe(true);
        expect(await h.images.pendingImages(null, 100)).toEqual([
          { owner: A, linkId: id, imageUrl: ICON3, role: "icon" },
        ]);
      });

      it("records none when the fresh page had no icon: nothing pending, no picture", async () => {
        const id = await withPreview();
        expect(await h.images.recordWordPictureCheck(A, id, IMG, [], null)).toBe(true);
        expect(await h.imageStatus(A, id)).toBe("none");
        expect(await h.images.pendingImages(null, 100)).toEqual([]);
        expect(await h.images.image(A, id)).toBeNull();
        expect(await candidates()).toEqual([]);
      });

      it("★ changes only the picture: title, description, text, status and owner picture stay", async () => {
        // [Re-running the snapshot, or clearing the owner's picture with the fetched one.]
        const id = await withPreview(A, {
          status: "extract_timeout",
          text: null,
          lastError: "extract:timeout",
        });
        expect(await h.edits.applyEdit(A, id, { picture: { set: PNG } }, at(6))).not.toBeNull();
        const before = await stateOf(A, id);
        expect(await h.images.recordWordPictureCheck(A, id, IMG, [ICON2], null)).toBe(true);
        const after = await stateOf(A, id);
        expect(after.snapshot).toEqual({ ...before.snapshot, imageUrl: null });
        expect(after.snapshot?.status).toBe("extract_timeout");
        expect(after.text).toBe(before.text);
        expect(await h.images.image(A, id, "own")).toMatchObject({ bytes: PNG.bytes });
      });

      it.each<
        [
          string,
          () => Promise<{
            owner: string;
            id: string;
            writer: string;
            icons: string[];
            url: string;
          }>,
        ]
      >([
        [
          "with a different preview",
          async () => ({ owner: A, id: await withPreview(), writer: A, icons: [ICON], url: ICON3 }),
        ],
        [
          "naming no preview",
          async () => ({ owner: A, id: await legacy(), writer: A, icons: [ICON], url: IMG }),
        ],
        [
          "another owner's",
          async () => ({ owner: A, id: await withPreview(), writer: B, icons: [ICON], url: IMG }),
        ],
        [
          "deleted",
          async () => {
            const id = await withPreview();
            expect(await h.links.markDeleted(A, id, at(50))).toBe(true);
            return { owner: A, id, writer: A, icons: [ICON], url: IMG };
          },
        ],
        [
          "with more than MAX_ICON_URLS icons",
          async () => ({
            owner: A,
            id: await withPreview(),
            writer: A,
            icons: [ICON, ICON2, ICON3],
            url: IMG,
          }),
        ],
      ])("★ refuses a link %s, changing nothing", async (_name, seed) => {
        // [An unconditional update, or one missing that WHERE clause.]
        const { owner, id, writer, icons, url } = await seed();
        const before = await stateOf(owner, id);
        const status = await h.imageStatus(owner, id);
        expect(await h.images.recordWordPictureCheck(writer, id, url, icons, null)).toBe(false);
        expect(await stateOf(owner, id)).toEqual(before);
        expect(await h.imageStatus(owner, id)).toBe(status);
      });

      it("★ keeps the stored preview when it refuses", async () => {
        // [Deleting the preview row before checking the snapshot still names it.]
        const id = await withPreview();
        expect(await h.images.recordWordPictureCheck(A, id, ICON3, [ICON], null)).toBe(false);
        expect(await h.images.image(A, id, "page")).toMatchObject({ role: "preview" });
      });

      it("answers an id never issued with false", async () => {
        expect(await h.images.recordWordPictureCheck(A, "999", IMG, [ICON], null)).toBe(false);
        expect(await h.images.recordWordPictureCheck(A, "nope", IMG, [], null)).toBe(false);
      });
    });

    describe("favicon candidates and their check (#272)", () => {
      const FAV1 = "https://ex.com/f1.ico";
      const FAV2 = "https://ex.com/f2.png";
      const listed = async () =>
        (await h.images.faviconCandidates(null, 100)).map((c) => [c.owner, c.linkId, c.generation]);
      /** A link with a terminal snapshot and no favicon row. */
      const bare = (owner = A, over: Partial<SnapshotRecord> = {}) =>
        recorded(owner, record({ faviconUrls: null, ...over }));
      /** A link whose favicon row is `status` at `discovery` and, when given, `generation`. */
      const rowed = async (
        status: "pending" | "ok" | "none" | "refused",
        discovery: number,
        generation?: number,
        owner = A,
      ) => {
        const id = await recorded(owner, record({ faviconUrls: [FAV1] }));
        await h.seedFavicon(owner, id, { status, discovery, generation });
        return id;
      };
      /** Everything a favicon check must not change, plus the row. */
      const withRow = async (owner: string, id: string) => ({
        ...(await stateOf(owner, id)),
        row: await h.faviconRow(owner, id),
      });
      /** The claim a worker would hold for the link: its row's generation, or null. */
      const claimOf = async (owner: string, id: string) =>
        (await h.faviconRow(owner, id))?.generation ?? null;

      it("lists a terminal link with no row, with a null generation, its owner and address", async () => {
        const id = await bare();
        expect(await h.images.faviconCandidates(null, 100)).toEqual([
          { owner: A, linkId: id, url: "https://ex.com/1", generation: null },
        ]);
      });

      it("lists a none or refused row below the current discovery version, with its generation", async () => {
        const none = await rowed("none", 1);
        const refused = await rowed("refused", 1, 3);
        expect(await listed()).toEqual([
          [A, none, 1],
          [A, refused, 3],
        ]);
      });

      it("lists every owner's candidates in id order, a page at a time after afterId", async () => {
        const ids = [await bare(A), await bare(B), await bare(A)];
        const first = await h.images.faviconCandidates(null, 2);
        expect(first.map((c) => [c.owner, c.linkId])).toEqual([
          [A, ids[0]],
          [B, ids[1]],
        ]);
        const rest = await h.images.faviconCandidates(first[1]?.linkId ?? null, 2);
        expect(rest.map((c) => [c.owner, c.linkId])).toEqual([[A, ids[2]]]);
      });

      it.each<[string, boolean, () => Promise<{ id: string; writer: string }>]>([
        ["a terminal snapshot, no row", true, async () => ({ id: await bare(), writer: A })],
        [
          "a failed snapshot, no row",
          true,
          async () => ({ id: await recorded(A, failedRecord), writer: A }),
        ],
        [
          "an archived link",
          true,
          async () => {
            const id = await bare();
            expect(await h.links.update(A, id, { state: "archived" })).not.toBeNull();
            return { id, writer: A };
          },
        ],
        [
          "a link flagged gone",
          true,
          async () => {
            const id = await bare();
            expect((await h.checks.updateCheckIf(A, id, null, gone))?.applied).toBe(true);
            return { id, writer: A };
          },
        ],
        [
          "a none row below the version",
          true,
          async () => ({ id: await rowed("none", 1), writer: A }),
        ],
        [
          "a refused row below the version",
          true,
          async () => ({ id: await rowed("refused", 1), writer: A }),
        ],
        [
          "a none row at the current version",
          false,
          async () => ({ id: await rowed("none", FAVICON_DISCOVERY_VERSION), writer: A }),
        ],
        [
          "a refused row at the current version",
          false,
          async () => ({ id: await rowed("refused", FAVICON_DISCOVERY_VERSION), writer: A }),
        ],
        ["an ok row", false, async () => ({ id: await rowed("ok", 1), writer: A })],
        ["a pending row", false, async () => ({ id: await rowed("pending", 1), writer: A })],
        [
          "a snapshot not yet taken",
          false,
          async () => ({
            id: (await h.links.insertIfAbsent(A, newLink(++n, at(0)))).link.id,
            writer: A,
          }),
        ],
        [
          "a snapshot waiting to retry",
          false,
          async () => ({
            id: await bare(A, { status: "retrying", nextFetchAt: at(50), fetchedAt: null }),
            writer: A,
          }),
        ],
        [
          "a deleted link",
          false,
          async () => {
            const id = await bare();
            expect(await h.links.markDeleted(A, id, at(50))).toBe(true);
            return { id, writer: A };
          },
        ],
        ["another owner's link", false, async () => ({ id: await bare(A), writer: B })],
      ])("★ the candidate read and the check's write agree: %s", async (_name, expected, seed) => {
        // [A row the read lists but the write refuses burns the backfill's retry budget; the reverse hides a link for good.]
        const { id, writer } = await seed();
        const claim = await claimOf(A, id);
        const isListed = (await h.images.faviconCandidates(null, 100)).some(
          (c) => c.owner === writer && c.linkId === id,
        );
        expect(isListed).toBe(expected);
        expect(await h.images.recordFaviconCheck(writer, id, claim, [FAV1])).toBe(expected);
      });

      it("★ lists a deleted link again once its delete is undone", async () => {
        // [Forgetting a hidden link for good.]
        const id = await bare();
        expect(await h.links.markDeleted(A, id, at(50))).toBe(true);
        expect(await listed()).toEqual([]);
        expect(await h.images.recordFaviconCheck(A, id, null, [FAV1])).toBe(false);
        expect(await h.faviconRow(A, id)).toBeNull();
        expect(await h.links.unmarkDeleted(A, id, at(50))).toBe(true);
        expect(await listed()).toEqual([[A, id, null]]);
        expect(await h.images.recordFaviconCheck(A, id, null, [FAV1])).toBe(true);
      });

      it("with no row, writes the candidates: pending at generation 1, at the current version", async () => {
        const id = await bare();
        expect(await h.images.recordFaviconCheck(A, id, null, [FAV1, FAV2])).toBe(true);
        expect(await h.faviconRow(A, id)).toEqual({
          candidates: [FAV1, FAV2],
          status: "pending",
          generation: 1,
          discovery: FAVICON_DISCOVERY_VERSION,
          stored: false,
        });
        expect(await listed()).toEqual([]);
      });

      it("with no candidates, writes a none row that ends the link's candidacy", async () => {
        const id = await bare();
        expect(await h.images.recordFaviconCheck(A, id, null, [])).toBe(true);
        expect(await h.faviconRow(A, id)).toMatchObject({
          candidates: [],
          status: "none",
          discovery: FAVICON_DISCOVERY_VERSION,
        });
        expect(await listed()).toEqual([]);
      });

      it("with an obsolete row, rewrites it under the next generation", async () => {
        const id = await rowed("none", 1);
        expect(await h.images.recordFaviconCheck(A, id, 1, [FAV2])).toBe(true);
        expect(await h.faviconRow(A, id)).toEqual({
          candidates: [FAV2],
          status: "pending",
          generation: 2,
          discovery: FAVICON_DISCOVERY_VERSION,
          stored: false,
        });
      });

      it("★ changes nothing but the favicon row: snapshot, text, icon status and pictures stay", async () => {
        // [An update that also writes the snapshot's columns, or the icon check.]
        const id = await legacy();
        const before = await withRow(A, id);
        expect(await h.images.recordFaviconCheck(A, id, null, [FAV1])).toBe(true);
        expect({ ...(await withRow(A, id)), row: null }).toEqual({ ...before, row: null });
        expect(await candidates()).toEqual([id]);
      });

      it.each<
        [
          string,
          () => Promise<{ id: string; writer: string; claim: number | null; urls?: string[] }>,
        ]
      >([
        [
          "a null claim after a row appeared",
          async () => {
            const id = await bare();
            expect(await h.images.recordFaviconCheck(A, id, null, [FAV2])).toBe(true);
            return { id, writer: A, claim: null };
          },
        ],
        [
          "a claim on a generation the row has moved past",
          async () => {
            const id = await rowed("none", 1, 5);
            return { id, writer: A, claim: 1 };
          },
        ],
        [
          "a claim after the row was rewritten at the current version",
          async () => {
            const id = await rowed("none", 1);
            expect(await h.images.recordFaviconCheck(A, id, 1, [FAV2])).toBe(true);
            return { id, writer: A, claim: 1 };
          },
        ],
        [
          "a numbered claim on a link with no row",
          async () => ({ id: await bare(), writer: A, claim: 1 }),
        ],
        [
          "a null claim on a link with a row",
          async () => ({ id: await rowed("none", 1), writer: A, claim: null }),
        ],
        [
          "more than MAX_FAVICON_URLS candidates",
          async () => ({
            id: await bare(),
            writer: A,
            claim: null,
            urls: [1, 2, 3, 4, 5, 6, 7].map((k) => `https://ex.com/f${k}.png`),
          }),
        ],
      ])("★ refuses %s, changing nothing", async (_name, seed) => {
        // [An unconditional upsert, or one that skips the claim.]
        const { id, writer, claim, urls } = await seed();
        const before = await withRow(A, id);
        expect(await h.images.recordFaviconCheck(writer, id, claim, urls ?? [FAV1])).toBe(false);
        expect(await withRow(A, id)).toEqual(before);
      });

      it("answers an id never issued with false", async () => {
        expect(await h.images.recordFaviconCheck(A, "999", null, [FAV1])).toBe(false);
        expect(await h.images.recordFaviconCheck(A, "nope", null, [])).toBe(false);
      });
    });

    describe("the icon check's favicon candidates (#272)", () => {
      const FAV1 = "https://ex.com/f1.ico";
      const FAV2 = "https://ex.com/f2.png";
      /** A legacy link whose favicon row is `status` at `discovery`. */
      const legacyRowed = async (
        status: "pending" | "ok" | "none" | "refused",
        discovery: number,
      ) => {
        const id = await legacy(A, { faviconUrls: [FAV1] });
        await h.seedFavicon(A, id, { status, discovery });
        return id;
      };

      it("with a link that has no row, writes the page's candidates with the icon: pending at generation 1", async () => {
        const id = await legacy();
        expect(await h.images.recordIconCheck(A, id, [ICON], [FAV1, FAV2])).toBe(true);
        expect(await h.imageStatus(A, id)).toBe("pending");
        expect(await h.faviconRow(A, id)).toEqual({
          candidates: [FAV1, FAV2],
          status: "pending",
          generation: 1,
          discovery: FAVICON_DISCOVERY_VERSION,
          stored: false,
        });
      });

      it("with an empty list, writes a none row: the page had no favicon", async () => {
        const id = await legacy();
        expect(await h.images.recordIconCheck(A, id, [], [])).toBe(true);
        expect(await h.faviconRow(A, id)).toMatchObject({ status: "none", candidates: [] });
      });

      it("★ with null, the page was not read: no row is written", async () => {
        // [Writing an empty list for an unread page, which would end its favicon search.]
        const id = await legacy();
        expect(await h.images.recordIconCheck(A, id, [ICON], null)).toBe(true);
        expect(await h.faviconRow(A, id)).toBeNull();
      });

      it.each<[string, "none" | "refused", number]>([
        ["a none row below the version", "none", 1],
        ["a refused row below the version", "refused", 1],
      ])("rewrites %s under the next generation", async (_n, status, discovery) => {
        const id = await legacyRowed(status, discovery);
        expect(await h.images.recordIconCheck(A, id, [ICON], [FAV2])).toBe(true);
        expect(await h.faviconRow(A, id)).toEqual({
          candidates: [FAV2],
          status: "pending",
          generation: 2,
          discovery: FAVICON_DISCOVERY_VERSION,
          stored: false,
        });
      });

      it.each<[string, "pending" | "ok" | "none", number]>([
        ["an ok row", "ok", 1],
        ["a pending row", "pending", 1],
        ["a none row at the current version", "none", FAVICON_DISCOVERY_VERSION],
      ])("★ leaves %s alone, and still records the icons", async (_n, status, discovery) => {
        // [Rewriting a working favicon on a re-read, which drops its bytes.]
        const id = await legacyRowed(status, discovery);
        const before = await h.faviconRow(A, id);
        expect(await h.images.recordIconCheck(A, id, [ICON], [FAV2])).toBe(true);
        expect(await h.faviconRow(A, id)).toEqual(before);
        expect(await h.imageStatus(A, id)).toBe("pending");
      });

      it("★ refuses more than MAX_FAVICON_URLS candidates, writing nothing", async () => {
        const id = await legacy();
        const seven = [1, 2, 3, 4, 5, 6, 7].map((k) => `https://ex.com/f${k}.png`);
        expect(await h.images.recordIconCheck(A, id, [ICON], seven)).toBe(false);
        expect(await h.imageStatus(A, id)).toBeNull();
        expect(await h.faviconRow(A, id)).toBeNull();
      });

      it("★ a refused icon check writes no favicon row", async () => {
        // [Writing the favicon before the icon check's own guard has passed.]
        const id = await recorded(A, failedRecord);
        expect(await h.images.recordIconCheck(A, id, [ICON], [FAV1])).toBe(false);
        expect(await h.faviconRow(A, id)).toBeNull();
      });

      it("★ refuses a link deleted meanwhile entirely, and takes it again once the delete is undone", async () => {
        // [An update with no live-link test, which writes the icon and the favicon to a hidden link.]
        const id = await legacy();
        expect(await h.links.markDeleted(A, id, at(50))).toBe(true);
        expect(await h.images.recordIconCheck(A, id, [ICON], [FAV1])).toBe(false);
        expect(await h.imageStatus(A, id)).toBeNull();
        expect(await h.faviconRow(A, id)).toBeNull();
        expect(await h.links.unmarkDeleted(A, id, at(50))).toBe(true);
        expect(await candidates()).toEqual([id]);
        expect(await h.images.recordIconCheck(A, id, [ICON], [FAV1])).toBe(true);
      });
    });
  });
}
