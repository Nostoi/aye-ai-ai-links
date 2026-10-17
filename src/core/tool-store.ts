import type { OwnerId, Source, ToolStatus } from "./types.js";

/** How long a kept tool waits before "Still using it?", in days. */
export type WaitDays = 30 | 60 | 120;

/** A link's Keep handy row. A link with no row is an ordinary link. */
export type ToolRecord = {
  status: ToolStatus;
  source: Source;
  /** When the link took its current status. */
  since: Date;
  /** The last "Still using it" answer, or null. */
  answeredAt: Date | null;
  waitDays: WaitDays;
};

/** The row as it is after a conditional write, and whether the write happened. */
export type ToolWrite = { tool: ToolRecord | null; applied: boolean };

/**
 * Persistence contract for Keep handy rows. Any implementation must meet all of it.
 *
 * - Owner scoping: every method takes the owner and never reads or changes another owner's rows.
 * - Ids: those of `LinkStore`. An id never issued, or one owned by someone else, yields null,
 *   never an error.
 * - A row is deleted with its link.
 */
export interface ToolStore {
  /** The link's row, or null when it has none or the link is not the owner's. */
  getTool(owner: OwnerId, linkId: string): Promise<ToolRecord | null>;

  /** Every row of the owner's, keyed by link id. An owner with none (or an unknown one) yields an empty map. */
  listTools(owner: OwnerId): Promise<Map<string, ToolRecord>>;

  /**
   * Conditional write, in one atomic step: set the link's row to `next`, creating it (a null
   * `next` deletes it), but only while the row still equals `expected` (null: no row), as
   * `sameTool` compares them. Returns the row as it is afterwards with `applied`, or null when
   * the link is absent, foreign or never issued; then nothing is written. Core supplies both
   * rows; the store holds no rule.
   */
  updateToolIf(
    owner: OwnerId,
    linkId: string,
    expected: ToolRecord | null,
    next: ToolRecord | null,
  ): Promise<ToolWrite | null>;
}

/** Field by field, dates to the millisecond. Both stores compare rows with this. */
export function sameTool(a: ToolRecord | null, b: ToolRecord | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.status === b.status &&
    a.source === b.source &&
    a.since.getTime() === b.since.getTime() &&
    (a.answeredAt?.getTime() ?? null) === (b.answeredAt?.getTime() ?? null) &&
    a.waitDays === b.waitDays
  );
}
