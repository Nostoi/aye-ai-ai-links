import { beforeEach, describe, expect, it } from "vitest";
import type { IconBackfillStore } from "./icon-backfill-store.js";
import type { ImageBytes, ImageStore } from "./image-store.js";
import type { LinkCheck, LinkCheckStore } from "./link-check-store.js";
import type { LinkEditStore } from "./link-edit-store.js";
import type { SnapshotRecord, SnapshotStore } from "./snapshot-store.js";
import { A, at, B, newLink, record } from "./snapshot-store-contract.js";
import type { LinkStore } from "./store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type IconBackfillHarness = {
  links: LinkStore & SnapshotStore;
  images: ImageStore & IconBackfillStore;
  checks: LinkCheckStore;
  edits: LinkEditStore;
  addOwner(owner: string): MaybeAsync<void>;
  /** The snapshot's `image_status` as stored. Test inspection only. */
  imageStatus(owner: string, linkId: string): MaybeAsync<string | null>;
  /** Sets `image_status` back to NULL, as a snapshot recorded before PR B has it. Test seeding only. */
  forgetIconCheck(owner: string, linkId: string): MaybeAsync<void>;
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
      expect(await h.images.recordIconCheck(A, id, [ICON, ICON2])).toBe(true);
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
      expect(await h.images.recordIconCheck(A, id, [])).toBe(true);
      expect(await h.imageStatus(A, id)).toBe("none");
      expect(await h.images.pendingImages(null, 100)).toEqual([]);
      expect(await candidates()).toEqual([]);
    });

    it("★ changes nothing but the icon check: title, description, text, status and preview stay", async () => {
      // [An update that also writes the snapshot's other columns.]
      const id = await legacy();
      const before = await stateOf(A, id);
      expect(await h.images.recordIconCheck(A, id, [ICON])).toBe(true);
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
          expect(await h.images.recordIconCheck(A, id, [ICON])).toBe(true);
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
      expect(await h.images.recordIconCheck(writer, id, icons)).toBe(false);
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
          expect(await h.images.recordIconCheck(A, id, [ICON2])).toBe(true);
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
      expect(await h.images.recordIconCheck(writer, id, [ICON])).toBe(listed);
    });

    it("answers an id never issued with false", async () => {
      expect(await h.images.recordIconCheck(A, "999", [ICON])).toBe(false);
      expect(await h.images.recordIconCheck(A, "nope", [])).toBe(false);
    });
  });
}
