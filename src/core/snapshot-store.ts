import type { OwnerId, SnapshotStatus } from "./types.js";

/** What a finished attempt leaves behind. `text` is the extracted page text. */
export type SnapshotRecord = {
  status: SnapshotStatus;
  attempts: number;
  /** When the next attempt is due; null once the snapshot is final. */
  nextFetchAt: Date | null;
  fetchedAt: Date | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  /** The site's icon candidates, best first; at most MAX_ICON_URLS. */
  iconUrls: string[];
  text: string | null;
  lastError: string | null;
};

/**
 * The proof of a lease: pass `claim` back to `recordSnapshot` to complete that attempt, or to
 * `releaseSnapshot` to give it back. `attempts` counts this attempt. `claim` is a per-snapshot
 * token that every lease, record and release moves on, so it is never valid twice.
 */
export type SnapshotLease = { url: string; attempts: number; claim: number };

/**
 * Persistence contract for page snapshots. Any implementation must meet all of it.
 *
 * - Owner scoping: every method takes the owner and never reads or changes
 *   another owner's snapshots, with one exception: `dueSnapshots`.
 * - Ids: those of `LinkStore`. An id never issued, or one owned by someone else,
 *   yields null or false, never an error.
 */
export interface SnapshotStore {
  /**
   * The one cross-owner read. Snapshots that are `pending` or `retrying` and
   * due at `now` or earlier, soonest due first, at most `limit`. A leased
   * snapshot is not due until its lease ends.
   */
  dueSnapshots(now: Date, limit: number): Promise<{ owner: OwnerId; linkId: string }[]>;

  /**
   * Claim a due `pending` or `retrying` snapshot until `until`: one caller wins.
   * Counts the attempt now: returns the link's url, the attempts including this one and a
   * claim, or null when nothing was claimed. The claim is the snapshot's token after this
   * lease, so it differs from every earlier claim on that snapshot, even one issued in the
   * same millisecond. The lease ends at `until`; after that the snapshot is due again.
   */
  leaseSnapshot(
    owner: OwnerId,
    linkId: string,
    now: Date,
    until: Date,
  ): Promise<SnapshotLease | null>;

  /**
   * Write the result of the attempt that holds `claim`, and move the token so the claim
   * cannot be used again. Returns false and writes nothing when the claim is no longer the
   * snapshot's token (leased again, released or completed), so an attempt that outlived its
   * lease cannot overwrite a newer one. Also returns false, writing nothing and keeping the
   * claim valid, for a result whose status and `nextFetchAt` disagree: `pending` and
   * `retrying` need a `nextFetchAt`; every other status needs null.
   */
  recordSnapshot(
    owner: OwnerId,
    linkId: string,
    claim: number,
    result: SnapshotRecord,
  ): Promise<boolean>;

  /**
   * Give back the attempt that holds `claim` without a result (a shutdown abort): takes the
   * counted attempt back, makes the snapshot due at `now`, moves the token, and returns true.
   * Returns false and changes nothing unless the claim is the snapshot's token and its
   * status is `pending` or `retrying`.
   */
  releaseSnapshot(owner: OwnerId, linkId: string, claim: number, now: Date): Promise<boolean>;

  /** The extracted text, or null when there is none. Kept out of `Link.snapshot`. */
  getSnapshotText(owner: OwnerId, linkId: string): Promise<string | null>;
}

/** True when the record's status and `nextFetchAt` agree; both stores refuse a record that fails this. */
export function hasConsistentSchedule(r: SnapshotRecord): boolean {
  const open = r.status === "pending" || r.status === "retrying";
  return open === (r.nextFetchAt !== null);
}

/** The most icon candidates a record may name. */
export const MAX_ICON_URLS = 2;

/** True when the record names at most MAX_ICON_URLS icons; both stores refuse a record that fails this. */
export function hasValidIcons(r: SnapshotRecord): boolean {
  return r.iconUrls.length <= MAX_ICON_URLS;
}
