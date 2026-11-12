import type { OwnerId } from "./types.js";

/** A link to look at for its site's icon: its owner, id and saved address. */
export type IconCandidate = { owner: OwnerId; linkId: string; url: string };

/** A link whose snapshot names a preview: its owner, id, saved address and that preview's URL. */
export type PreviewLink = IconCandidate & { imageUrl: string };

/** A link to look at for its favicon: `generation` is that of its `none`/`refused` row, null when it has no row. */
export type FaviconCandidate = IconCandidate & { generation: number | null };

/**
 * Persistence contract for the icon backfill (#149), the word-picture check (#193) and the
 * favicon check (#272). Any implementation must meet all of it.
 *
 * - A candidate's snapshot is `ok`, names no preview, and was never looked at for an icon; its
 *   link has no fetched picture and is not flagged gone now. A link with an owner picture, and an
 *   archived link, can be one.
 * - A word-picture candidate is any live link whose snapshot names a preview, whatever the
 *   snapshot's status and whether or not the link is flagged gone. Which of them are on a
 *   word-picture host is core's rule, not the store's.
 * - A favicon candidate is a live link whose snapshot is terminal (not `pending` or `retrying`)
 *   and that has no `link_favicons` row, or a `none` or `refused` row at a discovery version below
 *   FAVICON_DISCOVERY_VERSION. It carries that row's generation, null with no row. An `ok` or
 *   `pending` row is never one.
 * - `iconCandidates`, `wordPictureCandidates` and `faviconCandidates` are cross-owner maintenance
 *   for the backfill, never for a request.
 * - Every write compares and sets: `recordIconCheck` writes only while the live link is still an
 *   icon candidate, `recordWordPictureCheck` only while the snapshot still names that preview, and
 *   `recordFaviconCheck` only while the link is still a favicon candidate at the claimed
 *   generation. Each writes only the picture's or the favicon's columns, never the snapshot's
 *   status, title, text or the owner's picture.
 * - Ids: those of `LinkStore`. An id never issued, or one owned by someone else, yields false.
 */
export interface IconBackfillStore {
  /** Up to `limit` candidates of every owner, with link ids greater than `afterId` (all when null), in id order. */
  iconCandidates(afterId: string | null, limit: number): Promise<IconCandidate[]>;

  /**
   * Records that the link was looked at: its icons, best first, of which the first becomes the
   * pending picture as an icon; or, with none, that nothing came of it. In the same write, unless
   * `faviconUrls` is null (the page was not read), it rewrites the link's favicon candidates
   * (#272, `FaviconStore`) to `faviconUrls` when the link has no favicon row or a `none` or
   * `refused` one below the current discovery version; an `ok` or `pending` row is left alone.
   * Returns false, writing nothing, when the link is deleted or its snapshot no longer qualifies,
   * and for more than MAX_ICON_URLS icons or MAX_FAVICON_URLS favicons.
   */
  recordIconCheck(
    owner: OwnerId,
    linkId: string,
    iconUrls: string[],
    faviconUrls: string[] | null,
  ): Promise<boolean>;

  /** Up to `limit` live links of every owner whose snapshot names a preview, ids after `afterId`, in id order. */
  wordPictureCandidates(afterId: string | null, limit: number): Promise<PreviewLink[]>;

  /**
   * Drops the snapshot's preview, `imageUrl`, and its fetched picture, and records the page's
   * fresh icons in place of the old ones, as `recordIconCheck` does. In the same write it rewrites
   * the link's favicon candidates (#272, `FaviconStore`) to `faviconUrls`, unless that is null
   * (the page was not read), which leaves them as they were. Returns false, writing nothing,
   * unless the live link's snapshot still names `imageUrl`, and for more than MAX_ICON_URLS
   * icons or MAX_FAVICON_URLS favicons.
   */
  recordWordPictureCheck(
    owner: OwnerId,
    linkId: string,
    imageUrl: string,
    iconUrls: string[],
    faviconUrls: string[] | null,
  ): Promise<boolean>;

  /** Up to `limit` favicon candidates of every owner, with link ids greater than `afterId` (all when null), in id order. */
  faviconCandidates(afterId: string | null, limit: number): Promise<FaviconCandidate[]>;

  /**
   * Rewrites the link's favicon candidates (#272, `FaviconStore`) to `urls`, none meaning the
   * page has no favicon. `generation` is the claim from `faviconCandidates`. Returns false,
   * writing nothing, unless the link is still a favicon candidate with that generation (null:
   * still no row), and for more than MAX_FAVICON_URLS urls.
   */
  recordFaviconCheck(
    owner: OwnerId,
    linkId: string,
    generation: number | null,
    urls: string[],
  ): Promise<boolean>;
}
