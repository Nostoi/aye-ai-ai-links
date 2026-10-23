import type { OwnerId } from "./types.js";

/** The AI's latest reading of an owner's stats (`stats_readings`, #161). */
export type StatsReading = { text: string; writtenBy: string; writtenAt: Date; inputHash: string };

export interface StatsReadingStore {
  /**
   * Null unless the owner has a live link saved at or before the reading's writtenAt: an emptied
   * library, or one holding only newer links, shows no reading (the row is kept, so Undo brings it back).
   */
  getReading(owner: OwnerId): Promise<StatsReading | null>;
  /**
   * Writes only while the stored reading's writtenAt equals `expectedWrittenAt` and the owner has a live
   * link. Null expects no visible reading, so it also replaces one that getReading hides.
   */
  putReadingIf(
    owner: OwnerId,
    expectedWrittenAt: Date | null,
    reading: StatsReading,
  ): Promise<boolean>;
  /** Cross-owner: owners with a live link whose reading is missing, hidden, or written at or before `dueBefore`. */
  readingCandidates(dueBefore: Date): Promise<OwnerId[]>;
}
