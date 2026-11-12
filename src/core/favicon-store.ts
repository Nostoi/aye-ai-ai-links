import type { ImageBytes, ImageEnd, StoredImage } from "./image-store.js";
import type { OwnerId } from "./types.js";

/**
 * How favicons are found (#272). A row records the version that found its candidates, so a later
 * way of finding them can tell the rows it has not looked at. 1: declared PNG, JPEG, GIF and WebP
 * icons. 2: declared ICOs too, and the site root's `/apple-touch-icon.png` then `/favicon.ico`
 * when a page has no usable icon.
 */
export const FAVICON_DISCOVERY_VERSION = 2;

/**
 * A link whose favicon is not fetched yet: its candidates, best first, and the generation they
 * were written under. The generation is the claim: pass it back to `writeFavicon` or `endFavicon`.
 */
export type PendingFavicon = {
  owner: OwnerId;
  linkId: string;
  generation: number;
  urls: string[];
};

/**
 * Persistence contract for the favicon pass (#272). Any implementation must meet all of it.
 *
 * - A link's favicon candidates are written only by the snapshot's record (from its page, or empty
 *   when its fetch ended with no page) and the word-picture check, which reads the page afresh.
 *   Each rewrite, even to the same list, moves the generation
 *   on, drops the stored favicon, and makes it pending (or `none` when the list is empty).
 * - Both writes compare and set on the generation and on the favicon still being pending, so a
 *   fetch that began before its candidates were rewritten changes nothing.
 * - Owner scoping: every method takes the owner and never touches another owner's link, except
 *   `pendingFavicons`, cross-owner maintenance for the pass, never for a request.
 * - A deleted link is hidden: it is not pending, its writes return false, and its favicon reads
 *   as none until an Undo brings it back as it was.
 * - Ids: those of `LinkStore`. An id never issued, or one owned by someone else, yields false.
 */
export interface FaviconStore {
  /** Up to `limit` pending favicons of live links of every owner, ids after `afterId`, in id order. */
  pendingFavicons(afterId: string | null, limit: number): Promise<PendingFavicon[]>;

  /** Store the favicon and end its pending state. Returns false, writing nothing, unless pending at `generation`. */
  writeFavicon(
    owner: OwnerId,
    linkId: string,
    generation: number,
    image: ImageBytes,
    at: Date,
  ): Promise<boolean>;

  /** End the pending state with no favicon. Returns false, writing nothing, unless pending at `generation`. */
  endFavicon(owner: OwnerId, linkId: string, generation: number, end: ImageEnd): Promise<boolean>;
}

/** The web door's reads of stored favicons. Owner-scoped; a deleted or another owner's link has none. */
export interface FaviconReader {
  /** The stored favicon's version, for each of these links that has one; others are absent. */
  faviconVersions(owner: OwnerId, linkIds: string[]): Promise<Map<string, string>>;

  /** The stored favicon, or null when there is none. */
  favicon(owner: OwnerId, linkId: string): Promise<StoredImage | null>;
}
