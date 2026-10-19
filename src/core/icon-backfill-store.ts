import type { OwnerId } from "./types.js";

/** A link to look at for its site's icon: its owner, id and saved address. */
export type IconCandidate = { owner: OwnerId; linkId: string; url: string };

/**
 * Persistence contract for the icon backfill (#149). Any implementation must meet all of it.
 *
 * - A candidate's snapshot is `ok`, names no preview, and was never looked at for an icon; its
 *   link has no fetched picture and is not flagged gone now. A link with an owner picture, and an
 *   archived link, can be one.
 * - `iconCandidates` is cross-owner maintenance for the backfill, never for a request.
 * - `recordIconCheck` compares and sets: it writes only while the snapshot is still `ok`, names no
 *   preview and was never looked at, and it writes only the icon candidates and the image status.
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
}
