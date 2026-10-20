import type { OwnerId } from "./types.js";

/** A link to look at for its site's icon: its owner, id and saved address. */
export type IconCandidate = { owner: OwnerId; linkId: string; url: string };

/** A link whose snapshot names a preview: its owner, id, saved address and that preview's URL. */
export type PreviewLink = IconCandidate & { imageUrl: string };

/**
 * Persistence contract for the icon backfill (#149) and the word-picture check (#193). Any
 * implementation must meet all of it.
 *
 * - A candidate's snapshot is `ok`, names no preview, and was never looked at for an icon; its
 *   link has no fetched picture and is not flagged gone now. A link with an owner picture, and an
 *   archived link, can be one.
 * - A word-picture candidate is any live link whose snapshot names a preview, whatever the
 *   snapshot's status and whether or not the link is flagged gone. Which of them are on a
 *   word-picture host is core's rule, not the store's.
 * - `iconCandidates` and `wordPictureCandidates` are cross-owner maintenance for the backfill,
 *   never for a request.
 * - Both writes compare and set: `recordIconCheck` writes only while the link is still a
 *   candidate, and `recordWordPictureCheck` only while the snapshot still names that preview.
 *   Each writes only the picture's columns, never the snapshot's status, title, text or the
 *   owner's picture.
 * - Ids: those of `LinkStore`. An id never issued, or one owned by someone else, yields false.
 */
export interface IconBackfillStore {
  /** Up to `limit` candidates of every owner, with link ids greater than `afterId` (all when null), in id order. */
  iconCandidates(afterId: string | null, limit: number): Promise<IconCandidate[]>;

  /**
   * Records that the link was looked at: its icons, best first, of which the first becomes the
   * pending picture as an icon; or, with none, that nothing came of it. Returns false, writing
   * nothing, when the snapshot no longer qualifies, and for more than MAX_ICON_URLS icons.
   */
  recordIconCheck(owner: OwnerId, linkId: string, iconUrls: string[]): Promise<boolean>;

  /** Up to `limit` live links of every owner whose snapshot names a preview, ids after `afterId`, in id order. */
  wordPictureCandidates(afterId: string | null, limit: number): Promise<PreviewLink[]>;

  /**
   * Drops the snapshot's preview, `imageUrl`, and its fetched picture, and records the page's
   * fresh icons in place of the old ones, as `recordIconCheck` does. Returns false, writing
   * nothing, unless the live link's snapshot still names `imageUrl`, and for more than
   * MAX_ICON_URLS icons.
   */
  recordWordPictureCheck(
    owner: OwnerId,
    linkId: string,
    imageUrl: string,
    iconUrls: string[],
  ): Promise<boolean>;
}
