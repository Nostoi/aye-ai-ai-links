import type { OwnerId } from "./types.js";

/** The AI's latest reading of an owner's stats (`stats_readings`, #161). */
export type StatsReading = { text: string; writtenBy: string; writtenAt: Date; inputHash: string };

export interface StatsReadingStore {
  /** Null when the owner has no live link: an emptied library shows no reading (row kept, so Undo brings it back). */
  getReading(owner: OwnerId): Promise<StatsReading | null>;
  /** Writes only while the stored reading's writtenAt equals `expectedWrittenAt` (null: none) and the owner has a live link. */
  putReadingIf(
    owner: OwnerId,
    expectedWrittenAt: Date | null,
    reading: StatsReading,
  ): Promise<boolean>;
  /** Cross-owner: owners with a live link whose reading is missing or written at or before `dueBefore`. */
  readingCandidates(dueBefore: Date): Promise<OwnerId[]>;
}
