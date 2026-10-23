import type { Stats } from "./stats.js";

/** The longest reading the server stores, in code points: two to four plain sentences. */
export const READING_MAX = 600;

/** The AI could not be reached. A bad reply is any other error. */
export class StatsReaderUnavailable extends Error {
  override name = "StatsReaderUnavailable";
}

/** Writes the short reading of an owner's stats. Implemented over the one AI connection in `src/ai/`. */
export interface StatsReader {
  read(
    input: { allTime: Stats; lastMonth: Stats; focus: string[] },
    signal: AbortSignal,
  ): Promise<string>;
}
