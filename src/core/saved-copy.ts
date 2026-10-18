import type { ImageType } from "./fetch.js";
import type { ImageBytes, StoredImage } from "./image-store.js";
import type { OwnerId } from "./types.js";

const MiB = 1024 * 1024;
/** Per-copy caps (owner ruling, #135): images, and bytes with copy.md included. */
export const MAX_COPY_IMAGES = 30;
export const MAX_COPY_BYTES = 20 * MiB;
/** copy.md's cap (controller ruling, 2026-10-17); finishing only shrinks the file. */
export const MAX_COPY_MARKDOWN_BYTES = 2 * MiB;
export const COPY_UNDO_WINDOW_MS = 60_000;
/** How long a saved-copy file read may take, waiting for the read gate included. */
export const COPY_READ_TIMEOUT_MS = 10_000;
/** A draft's image nonce: 32 lowercase hex characters. */
export const COPY_NONCE = /^[0-9a-f]{32}$/;

// imageUrls[i] is image n = i + 1; nonce is in every image reference of the markdown
export type CopyDraft = { markdown: string; imageUrls: string[]; nonce: string };
export type CopyLimits = { copyBytes: number; totalBytes: number };
export type CopyStatus = "saving" | "ok" | "removed" | "none" | "failed" | "no_room" | "too_large";
export type NoCopyStatus = "none" | "failed" | "no_room" | "too_large";
export type SaveCopyResult = "saved" | "exists" | "no_room" | "too_large" | "unavailable";
export type CopyImageResult = "saved" | "no_room" | "too_large" | "unavailable";
export type CopyImageEnd = "none" | "refused";
export type ImageExt = "png" | "jpg" | "gif" | "webp";
export type FinishImage = { n: number; ext: ImageExt | null }; // null: not stored
export type CopyInfo = { madeAt: Date };
export type CopyImageInfo = { contentType: ImageType; version: string };
// nonce: the copy's image nonce (null when it has no images), so a reader can resolve unfinished references
export type ReadCopy = {
  markdown: string;
  madeAt: Date;
  finished: boolean;
  nonce: string | null;
  images: Map<number, CopyImageInfo>;
};
export type CopyCandidate = { owner: OwnerId; linkId: string; url: string };
export type PendingCopyImage = { owner: OwnerId; linkId: string; n: number; url: string };
export type CopyRef = { owner: OwnerId; linkId: string };
export type FolderCheck = { state: "ready" } | { state: "unwritable" | "mismatch"; detail: string };
export type SweepReport = { folders: number; temp: number; images: number; unknown: string[] };

/** The log line for a folder that is not ready, naming it. */
export function pausedMessage(
  dir: string,
  check: Exclude<FolderCheck, { state: "ready" }>,
): string {
  const advice = /EPERM|EACCES/.test(check.detail)
    ? " Grant the Node binary access to this folder in System Settings → Privacy & Security, then restart the service."
    : check.state === "mismatch"
      ? " To start a new, empty folder, move this one aside and restart."
      : "";
  return `[saved copies] paused (${dir}): ${check.detail}${advice}`;
}

/** Writes copies and their images. A null or false means the link or row is not the owner's. */
export interface SavedCopyWriter {
  /** Saves a copy for a link with no row or a `no_room` row; "exists" when one is already there. */
  saveCopy(
    owner: OwnerId,
    linkId: string,
    draft: CopyDraft,
    limits: CopyLimits,
    at: Date,
  ): Promise<SaveCopyResult | null>;
  /** Records why a link has no copy, when it has no row or a `no_room` row. */
  recordNoCopy(owner: OwnerId, linkId: string, status: NoCopyStatus): Promise<boolean>;
  /** Stores image `n` of a copy whose row is waiting for it. */
  saveCopyImage(
    owner: OwnerId,
    linkId: string,
    n: number,
    url: string,
    image: ImageBytes,
    limits: CopyLimits,
  ): Promise<CopyImageResult | false>;
  /** Settles image `n` as not stored. */
  endCopyImage(
    owner: OwnerId,
    linkId: string,
    n: number,
    url: string,
    end: CopyImageEnd,
  ): Promise<boolean>;
  /** Rewrites copy.md once every image has settled; the result may not be longer than the reserved bytes. */
  finishCopy(
    owner: OwnerId,
    linkId: string,
    finish: (markdown: string, nonce: string, images: FinishImage[]) => string,
    at: Date,
  ): Promise<boolean>;
}

/** Reads copies for their owner. */
export interface SavedCopyReader {
  copyInfo(owner: OwnerId, linkIds: string[]): Promise<Map<string, CopyInfo>>;
  /** "missing" when the folder check does not pass or the file is gone; null when the owner has no such copy. */
  readCopy(owner: OwnerId, linkId: string): Promise<ReadCopy | "missing" | null>;
  copyImage(owner: OwnerId, linkId: string, n: number): Promise<StoredImage | null>;
}

/** Bytes the saved copies hold, for a request that must show it. */
export interface SavedCopyUsage {
  usedBytes(): Promise<number>;
}

/** Cross-owner work for background passes; never for a request. */
export interface SavedCopyMaintenance {
  checkFolder(): Promise<FolderCheck>;
  backfillCandidates(
    afterId: string | null,
    limit: number,
    options: { retryNoRoom: boolean },
  ): Promise<CopyCandidate[]>;
  pendingCopyImages(
    after: { linkId: string; n: number } | null,
    limit: number,
  ): Promise<PendingCopyImage[]>;
  unfinishedCopies(afterId: string | null, limit: number): Promise<CopyRef[]>;
  undoUnconfirmed(): Promise<{ copies: number; images: number }>;
  sweep(graceMs: number, now: Date): Promise<SweepReport>;
  purgeRemoved(before: Date): Promise<number>; // PR C
}

/** Removes and restores a copy (PR C). */
export interface SavedCopyRemover {
  removeCopy(owner: OwnerId, linkId: string, at: Date): Promise<boolean>;
  restoreCopy(owner: OwnerId, linkId: string, since: Date): Promise<boolean>;
}

export const IMAGE_EXT: Record<ImageType, ImageExt> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The caps for a total limit in bytes. */
export const copyLimits = (totalBytes: number): CopyLimits => ({
  copyBytes: MAX_COPY_BYTES,
  totalBytes,
});

/** Whether a value from the extraction child has a draft's shape: the child's message is untrusted. */
export function isCopyDraft(value: unknown): value is CopyDraft {
  if (typeof value !== "object" || value === null) return false;
  const { markdown, imageUrls, nonce } = value as Record<string, unknown>;
  if (typeof markdown !== "string" || typeof nonce !== "string" || !COPY_NONCE.test(nonce)) {
    return false;
  }
  if (!Array.isArray(imageUrls) || imageUrls.length > MAX_COPY_IMAGES) return false;
  const urls: unknown[] = Array.from(imageUrls); // holes become undefined, which fail below
  return (
    new Set(urls).size === urls.length &&
    urls.every((u) => typeof u === "string" && /^https?:\/\//.test(u) && URL.canParse(u))
  );
}

/** The reference the copy rule writes for image `n` of a draft with this nonce. */
export const imageRef = (n: number, nonce: string): string =>
  `images/${String(n).padStart(2, "0")}-${nonce}`;

/**
 * Rewrites each image reference holding this copy's nonce: a stored image becomes
 * `images/NN.ext`, any other becomes its alt text. Nothing else changes, and the result is never
 * longer than the input. The alt must escape `\`, `[` and `]`, as the copy rule will write it.
 */
export function finishedMarkdown(markdown: string, nonce: string, images: FinishImage[]): string {
  if (!COPY_NONCE.test(nonce)) throw new Error("Invalid copy nonce");
  const ext = new Map(images.map((i) => [i.n, i.ext]));
  const ref = new RegExp(`!\\[((?:\\\\.|[^\\[\\]\\\\])*)\\]\\(images/([0-9]{2})-${nonce}\\)`, "g");
  return markdown.replace(ref, (_all, alt: string, nn: string) => {
    const e = ext.get(Number(nn));
    return e ? `![${alt}](images/${nn}.${e})` : alt;
  });
}
