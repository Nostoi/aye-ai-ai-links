import type { ImageType } from "./fetch.js";
import type { OwnerId } from "./types.js";

/** What a fetched picture is: the page's preview image, or the site's icon. */
export type ImageRole = "preview" | "icon";

/** A link whose snapshot named a picture not fetched yet: `imageUrl` is the URL to fetch, `role` what it is. */
export type PendingImage = { owner: OwnerId; linkId: string; imageUrl: string; role: ImageRole };

export type ImageBytes = { contentType: ImageType; bytes: Uint8Array };

/** A stored image. `version` changes whenever the bytes do, so it can key a long-cached URL. */
export type StoredImage = ImageBytes & { version: string };

/** Why an image will never be stored: refused by the address rules, or nothing usable came back. */
export type ImageEnd = "refused" | "none";

/** The version of an image whose bytes have this sha256 (hex): its first 16 characters. */
export const imageVersion = (sha256: string): string => sha256.slice(0, 16);

/**
 * Persistence contract for the image pass. Any implementation must meet all of it.
 *
 * - A snapshot recorded with an image URL (else an icon URL) is pending until `writeImage` or
 *   `endImage`. A snapshot that names a preview deletes the link's stored icon in the same step.
 * - Owner scoping: `writeImage` and `endImage` take the owner and never touch another owner's
 *   link. `pendingImages` is the exception: cross-owner maintenance for the image pass, never
 *   for a request.
 * - Both writes compare and set: they change something only while the link's image is still
 *   pending for the same URL and role, so a late or repeated result cannot replace a stored image.
 * - Ids: those of `LinkStore`. An id never issued, or one owned by someone else, yields false,
 *   never an error.
 */
export interface ImageStore {
  /**
   * Cross-owner read. Up to `limit` pending images of every owner, with link ids greater than
   * `afterId` (all when null), in id order.
   */
  pendingImages(afterId: string | null, limit: number): Promise<PendingImage[]>;

  /** Store the image and end its pending state. Returns false, writing nothing, unless pending. */
  writeImage(
    owner: OwnerId,
    linkId: string,
    imageUrl: string,
    role: ImageRole,
    image: ImageBytes,
    at: Date,
  ): Promise<boolean>;

  /** End the pending state with no image. Returns false, writing nothing, unless pending. */
  endImage(
    owner: OwnerId,
    linkId: string,
    imageUrl: string,
    role: ImageRole,
    end: ImageEnd,
  ): Promise<boolean>;
}

/** For the edit dialog: whether the owner set a picture, and the fetched picture's version. */
export type PictureInfo = { own: boolean; pageVersion: string | null };

/**
 * The web door's reads of stored pictures. The picture that shows is the owner's when there is
 * one, else the fetched one, else none; these reads are the one place that decides it.
 * Owner-scoped: another owner's link reads as no picture.
 */
export interface LinkImageReader {
  /** The version of the picture that shows, for each of these links; links with none are absent. */
  imageVersions(owner: OwnerId, linkIds: string[]): Promise<Map<string, string>>;

  /** The picture that shows, or with `which` "page" the fetched one; null when there is none. */
  image(owner: OwnerId, linkId: string, which?: "page"): Promise<StoredImage | null>;

  /** For each of these links with an owner or fetched picture, what the dialog needs; others are absent. */
  pictureInfo(owner: OwnerId, linkIds: string[]): Promise<Map<string, PictureInfo>>;
}
