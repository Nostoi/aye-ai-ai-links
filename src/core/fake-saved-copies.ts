import { createHash } from "node:crypto";
import type { FakeStore } from "./fake-store.js";
import { type ImageBytes, imageVersion, type StoredImage } from "./image-store.js";
import {
  COPY_NONCE,
  type CopyCandidate,
  type CopyDraft,
  type CopyImageEnd,
  type CopyImageResult,
  type CopyInfo,
  type CopyLimits,
  type CopyRef,
  type CopyStatus,
  type FinishImage,
  type FolderCheck,
  IMAGE_EXT,
  MAX_COPY_IMAGES,
  type NoCopyStatus,
  type PendingCopyImage,
  type ReadCopy,
  type SaveCopyResult,
  type SavedCopyMaintenance,
  type SavedCopyReader,
  type SavedCopyUsage,
  type SavedCopyWriter,
} from "./saved-copy.js";
import type { OwnerId } from "./types.js";

type ImageRow = {
  url: string;
  status: "pending" | "saving" | "ok" | CopyImageEnd | "too_large" | "no_room";
  image: ImageBytes | null;
  sha256: string | null;
};
type Row = {
  status: CopyStatus;
  madeAt: Date | null;
  finished: boolean;
  nonce: string | null;
  mdBytes: number;
  bytes: number;
  images: Map<number, ImageRow>;
};

const key = (owner: OwnerId, linkId: string) => JSON.stringify([owner, linkId]);
const order = (linkId: string) => Number(linkId.replace(/^link-/, ""));

/** In-memory saved copies for tests; honours the same contract as the SQLite store. */
export class FakeSavedCopies
  implements
    SavedCopyWriter,
    SavedCopyReader,
    SavedCopyUsage,
    Omit<SavedCopyMaintenance, "purgeRemoved">
{
  private rows = new Map<string, Row & { owner: OwnerId; linkId: string }>();
  /** The Markdown file of each copy; its images are held on the image rows. */
  private files = new Map<string, { markdown: string }>();
  private broken: "unwritable" | "mismatch" | null = null;
  private nextFailure: Error | null = null;

  constructor(private readonly store: FakeStore) {}

  /** Make the folder check report this state from now on. */
  fail(state: "unwritable" | "mismatch"): void {
    this.broken = state;
  }

  /** Make the next copy or image file write throw this error. */
  failNextWrite(error: Error): void {
    this.nextFailure = error;
  }

  private get ready(): boolean {
    return this.broken === null;
  }

  private get readable(): boolean {
    return this.broken !== "mismatch";
  }

  private writeFile(write: () => void): void {
    const failure = this.nextFailure;
    if (failure) {
      this.nextFailure = null;
      throw failure;
    }
    write();
  }

  private async owns(owner: OwnerId, linkId: string): Promise<boolean> {
    return (await this.store.get(owner, linkId)) !== null;
  }

  private rowOf(owner: OwnerId, linkId: string) {
    return this.rows.get(key(owner, linkId));
  }

  private setRow(owner: OwnerId, linkId: string, status: CopyStatus, rest: Partial<Row> = {}) {
    const row = {
      owner,
      linkId,
      status,
      madeAt: null,
      finished: false,
      nonce: null,
      mdBytes: 0,
      bytes: 0,
      images: new Map<number, ImageRow>(),
      ...rest,
    };
    this.rows.set(key(owner, linkId), row);
    return row;
  }

  async checkFolder(): Promise<FolderCheck> {
    return this.broken === null
      ? { state: "ready" }
      : { state: this.broken, detail: "The saved-copy folder was broken by the test" };
  }

  private used(): number {
    let sum = 0;
    for (const row of this.rows.values()) sum += row.bytes;
    return sum;
  }

  async usedBytes(): Promise<number> {
    return this.used();
  }

  async saveCopy(
    owner: OwnerId,
    linkId: string,
    draft: CopyDraft,
    limits: CopyLimits,
    at: Date,
  ): Promise<SaveCopyResult | null> {
    if (!(await this.owns(owner, linkId))) return null;
    const count = draft.imageUrls.length;
    if (count > MAX_COPY_IMAGES) throw new Error("Too many images for a saved copy");
    if (count > 0 && !COPY_NONCE.test(draft.nonce)) throw new Error("Invalid copy nonce");
    const existing = this.rowOf(owner, linkId);
    if (existing && existing.status !== "no_room") return "exists";
    if (!this.ready) return "unavailable";
    const md = Buffer.byteLength(draft.markdown);
    if (md > limits.copyBytes) return this.setRow(owner, linkId, "too_large").status as "too_large";
    if (this.used() + md > limits.totalBytes) {
      return this.setRow(owner, linkId, "no_room").status as "no_room";
    }
    const images = new Map<number, ImageRow>();
    for (const [i, url] of draft.imageUrls.entries()) {
      images.set(i + 1, { url, status: "pending", image: null, sha256: null });
    }
    const row = this.setRow(owner, linkId, "saving", {
      madeAt: at,
      nonce: count > 0 ? draft.nonce : null,
      mdBytes: md,
      bytes: md,
      images,
    });
    try {
      this.writeFile(() => this.files.set(key(owner, linkId), { markdown: draft.markdown }));
    } catch (e) {
      this.rows.delete(key(owner, linkId));
      this.files.delete(key(owner, linkId));
      throw e;
    }
    row.status = "ok";
    row.finished = count === 0;
    return "saved";
  }

  async recordNoCopy(owner: OwnerId, linkId: string, status: NoCopyStatus): Promise<boolean> {
    if (!(await this.owns(owner, linkId))) return false;
    const row = this.rowOf(owner, linkId);
    if (row && row.status !== "no_room") return false;
    this.setRow(owner, linkId, status);
    return true;
  }

  async saveCopyImage(
    owner: OwnerId,
    linkId: string,
    n: number,
    url: string,
    image: ImageBytes,
    limits: CopyLimits,
  ): Promise<CopyImageResult | false> {
    const row = this.rowOf(owner, linkId);
    const slot = row?.images.get(n);
    if (row?.status !== "ok" || !slot || slot.status !== "pending" || slot.url !== url) {
      return false;
    }
    if (!this.ready) return "unavailable";
    const size = image.bytes.byteLength;
    if (row.bytes + size > limits.copyBytes) {
      slot.status = "too_large";
      return "too_large";
    }
    if (this.used() + size > limits.totalBytes) {
      slot.status = "no_room";
      return "no_room";
    }
    row.bytes += size;
    slot.status = "saving";
    try {
      this.writeFile(() => {
        slot.image = { contentType: image.contentType, bytes: new Uint8Array(image.bytes) };
        slot.sha256 = createHash("sha256").update(image.bytes).digest("hex");
      });
    } catch (e) {
      slot.status = "pending";
      row.bytes -= size;
      throw e;
    }
    slot.status = "ok";
    return "saved";
  }

  async endCopyImage(
    owner: OwnerId,
    linkId: string,
    n: number,
    url: string,
    end: CopyImageEnd,
  ): Promise<boolean> {
    const slot = this.rowOf(owner, linkId)?.images.get(n);
    if (slot?.status !== "pending" || slot.url !== url) return false;
    slot.status = end;
    return true;
  }

  private settled(row: Row): boolean {
    return [...row.images.values()].every((i) => i.status !== "pending" && i.status !== "saving");
  }

  private finishable(owner: OwnerId, linkId: string) {
    const row = this.rowOf(owner, linkId);
    return row && row.status === "ok" && !row.finished && row.nonce !== null && this.settled(row)
      ? row
      : undefined;
  }

  async finishCopy(
    owner: OwnerId,
    linkId: string,
    finish: (markdown: string, nonce: string, images: FinishImage[]) => string,
    _at: Date,
  ): Promise<boolean> {
    if (!this.ready) return false;
    const row = this.finishable(owner, linkId);
    const file = this.files.get(key(owner, linkId));
    if (!row?.nonce || !file) return false;
    const images = [...row.images].map(([n, i]) => ({
      n,
      ext: i.status === "ok" && i.image ? IMAGE_EXT[i.image.contentType] : null,
    }));
    const finished = finish(file.markdown, row.nonce, images);
    const length = Buffer.byteLength(finished);
    if (length > row.mdBytes) throw new Error("The finished copy is longer than reserved");
    file.markdown = finished;
    row.bytes =
      length + [...row.images.values()].reduce((s, i) => s + (i.image?.bytes.byteLength ?? 0), 0);
    row.mdBytes = length;
    row.finished = true;
    return true;
  }

  async copyInfo(owner: OwnerId, linkIds: string[]): Promise<Map<string, CopyInfo>> {
    const info = new Map<string, CopyInfo>();
    for (const id of linkIds) {
      const row = this.rowOf(owner, id);
      if (row?.status === "ok" && row.madeAt) info.set(id, { madeAt: new Date(row.madeAt) });
    }
    return info;
  }

  async readCopy(owner: OwnerId, linkId: string): Promise<ReadCopy | "missing" | null> {
    const row = this.rowOf(owner, linkId);
    if (row?.status !== "ok" || !row.madeAt) return null;
    const file = this.files.get(key(owner, linkId));
    if (!this.readable || !file) return "missing";
    const images: ReadCopy["images"] = new Map();
    for (const [n, i] of [...row.images].sort((a, b) => a[0] - b[0])) {
      if (i.status === "ok" && i.image && i.sha256) {
        images.set(n, { contentType: i.image.contentType, version: imageVersion(i.sha256) });
      }
    }
    return {
      markdown: file.markdown,
      madeAt: new Date(row.madeAt),
      finished: row.finished,
      nonce: row.nonce,
      images,
    };
  }

  async copyImage(owner: OwnerId, linkId: string, n: number): Promise<StoredImage | null> {
    const row = this.rowOf(owner, linkId);
    const slot = row?.images.get(n);
    if (row?.status !== "ok" || slot?.status !== "ok" || !slot.image || !slot.sha256) {
      return null;
    }
    if (!this.readable) return null;
    return {
      contentType: slot.image.contentType,
      bytes: new Uint8Array(slot.image.bytes),
      version: imageVersion(slot.sha256),
    };
  }

  async backfillCandidates(
    afterId: string | null,
    limit: number,
    options: { retryNoRoom: boolean },
  ): Promise<CopyCandidate[]> {
    const after = afterId === null ? 0 : order(afterId);
    if (Number.isNaN(after)) return [];
    const found: CopyCandidate[] = [];
    for (const l of this.store.allLinkSnapshots()) {
      if (l.snapshotStatus !== "ok" || l.snapshotText === null || order(l.linkId) <= after) {
        continue;
      }
      const row = this.rowOf(l.owner, l.linkId);
      if (row && !(options.retryNoRoom && row.status === "no_room")) continue;
      if ((await this.store.getCheck(l.owner, l.linkId))?.flaggedAt) continue;
      found.push({ owner: l.owner, linkId: l.linkId, url: l.url });
    }
    return found.sort((a, b) => order(a.linkId) - order(b.linkId)).slice(0, limit);
  }

  async pendingCopyImages(
    after: { linkId: string; n: number } | null,
    limit: number,
  ): Promise<PendingCopyImage[]> {
    const pending: PendingCopyImage[] = [];
    for (const row of this.rows.values()) {
      if (row.status !== "ok") continue;
      for (const [n, i] of row.images) {
        if (i.status !== "pending") continue;
        const id = order(row.linkId);
        if (after && (id < order(after.linkId) || (id === order(after.linkId) && n <= after.n))) {
          continue;
        }
        pending.push({ owner: row.owner, linkId: row.linkId, n, url: i.url });
      }
    }
    return pending.sort((a, b) => order(a.linkId) - order(b.linkId) || a.n - b.n).slice(0, limit);
  }

  async unfinishedCopies(afterId: string | null, limit: number): Promise<CopyRef[]> {
    const after = afterId === null ? 0 : order(afterId);
    if (Number.isNaN(after)) return [];
    return [...this.rows.values()]
      .filter((r) => r.status === "ok" && !r.finished && this.settled(r) && order(r.linkId) > after)
      .sort((a, b) => order(a.linkId) - order(b.linkId) || a.owner.localeCompare(b.owner))
      .slice(0, limit)
      .map((r) => ({ owner: r.owner, linkId: r.linkId }));
  }

  async undoUnconfirmed(): Promise<{ copies: number; images: number }> {
    return { copies: 0, images: 0 };
  }

  async sweep(): Promise<{ folders: number; temp: number; images: number; unknown: string[] }> {
    return { folders: 0, temp: 0, images: 0, unknown: [] };
  }
}
