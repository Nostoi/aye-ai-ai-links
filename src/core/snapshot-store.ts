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
  text: string | null;
  lastError: string | null;
};

/** The proof of a lease: pass `claim` back to `recordSnapshot` to complete that attempt. */
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
   * Returns the link's url, the attempts recorded so far and a claim, or null
   * when nothing was claimed. Each claim differs from the last on that snapshot.
   */
  leaseSnapshot(
    owner: OwnerId,
    linkId: string,
    now: Date,
    until: Date,
  ): Promise<SnapshotLease | null>;

  /**
   * Write the result of the attempt that holds `claim`. Writes nothing and
   * returns false when the snapshot has since been claimed again or completed,
   * so an attempt that outlived its lease cannot overwrite a newer one.
   */
  recordSnapshot(
    owner: OwnerId,
    linkId: string,
    claim: number,
    result: SnapshotRecord,
  ): Promise<boolean>;

  /** The extracted text, or null when there is none. Kept out of `Link.snapshot`. */
  getSnapshotText(owner: OwnerId, linkId: string): Promise<string | null>;
}
