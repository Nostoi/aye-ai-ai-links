import type { OwnerId } from "./types.js";

export const CHECK_RESULTS = ["alive", "dead", "unknown"] as const;
/** A check's verdict; `unknown` is "couldn't check", never dead. */
export type CheckResult = (typeof CHECK_RESULTS)[number];

/** A link's dead-link check row (#128). A link with no row has never been checked. */
export type LinkCheck = {
  /** When the last check started. */
  checkedAt: Date;
  result: CheckResult;
  /** What the last check got, such as `http:404` or `network:ENOTFOUND`; null for `alive`. */
  detail: string | null;
  /** The first dead check since the last alive one, or null. */
  firstDeadAt: Date | null;
  /** When the link was flagged as gone, or null. Never set without `firstDeadAt`. */
  flaggedAt: Date | null;
  /** The owner's last "It still works", or null. */
  stillWorksAt: Date | null;
};

/** The row as it is after a conditional write, and whether the write happened. */
export type CheckWrite = { check: LinkCheck | null; applied: boolean };

/** A link due for a check, with the URL to check. */
export type DueCheck = { owner: OwnerId; linkId: string; url: string };

/** The due read's cutoffs: a link is due when its last check is at or before its state's cutoff. */
export type CheckCutoffs = { active: Date; archived: Date };

/**
 * Persistence contract for dead-link check rows. Any implementation must meet all of it.
 *
 * - Owner scoping: every method takes the owner and never reads or changes another owner's rows,
 *   except `dueChecks`: cross-owner maintenance for the check runner, never for a request (as
 *   `ImageStore.pendingImages` is).
 * - Ids: those of `LinkStore`. An id never issued, or one owned by someone else, yields null,
 *   never an error.
 * - A row is deleted with its link.
 * - The store holds no rule: core supplies the cutoffs and every row it writes.
 */
export interface LinkCheckStore {
  /**
   * Cross-owner read. Up to `limit` links of every owner whose last check (or `saved_at`, when they
   * have no row) is at or before the cutoff for their current state: `active` for an active link,
   * `archived` for an archived one. Oldest first, ties by link id.
   */
  dueChecks(cutoffs: CheckCutoffs, limit: number): Promise<DueCheck[]>;

  /** The link's row, or null when it has none or the link is not the owner's. */
  getCheck(owner: OwnerId, linkId: string): Promise<LinkCheck | null>;

  /** Every row of the owner's, keyed by link id. An owner with none (or an unknown one) yields an empty map. */
  listChecks(owner: OwnerId): Promise<Map<string, LinkCheck>>;

  /**
   * Conditional write, in one atomic step: set the link's row to `next`, creating it, but only
   * while the row still equals `expected` (null: no row), as `sameCheck` compares them. Returns the
   * row as it is afterwards with `applied`, or null when the link is absent, foreign or never
   * issued; then nothing is written.
   */
  updateCheckIf(
    owner: OwnerId,
    linkId: string,
    expected: LinkCheck | null,
    next: LinkCheck,
  ): Promise<CheckWrite | null>;
}

const ms = (d: Date | null): number | null => d?.getTime() ?? null;

/** Field by field, dates to the millisecond. Both stores compare rows with this. */
export function sameCheck(a: LinkCheck | null, b: LinkCheck | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.checkedAt.getTime() === b.checkedAt.getTime() &&
    a.result === b.result &&
    a.detail === b.detail &&
    ms(a.firstDeadAt) === ms(b.firstDeadAt) &&
    ms(a.flaggedAt) === ms(b.flaggedAt) &&
    ms(a.stillWorksAt) === ms(b.stillWorksAt)
  );
}
