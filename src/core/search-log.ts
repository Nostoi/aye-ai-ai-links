import type { SearchFilters, SearchTrace } from "./search.js";
import type { OwnerId } from "./types.js";

/** One link a logged search returned. `similarity` is null for a link found by keyword only. */
export type LoggedResult = { id: string; urlKey: string; similarity: number | null };

export type SearchLogEntry = Pick<SearchTrace, "mode" | "embedded" | "modelKey"> &
  Pick<SearchTrace, "meaningCandidates"> & {
    query: string;
    filters: SearchFilters;
    results: LoggedResult[];
  };

export interface SearchLog {
  record(owner: OwnerId, by: string, entry: SearchLogEntry, at: Date): Promise<void>;
  pairOpen(
    owner: OwnerId,
    by: string,
    link: { id: string; urlKey: string },
    since: Date,
    at: Date,
  ): Promise<void>;
}

/** A search is paired with the same agent's next get_link only within this long. */
export const OPEN_WINDOW_MS = 30 * 60 * 1000;

/** Best effort: a failure is reported and never reaches the caller's search or get_link. */
async function bestEffort(what: string, work: () => Promise<void> | undefined): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`[search-log] could not ${what}:`, error);
  }
}

export const logSearch = (
  log: SearchLog | undefined,
  owner: OwnerId,
  by: string,
  entry: SearchLogEntry,
  at: Date,
): Promise<void> => bestEffort("record a search", () => log?.record(owner, by, entry, at));

/** Pairs the opened link with the agent's latest search, if that search is recent and still unpaired. */
export const logOpen = (
  log: SearchLog | undefined,
  owner: OwnerId,
  by: string,
  link: { id: string; urlKey: string },
  at: Date,
): Promise<void> =>
  bestEffort("pair an opened link", () =>
    log?.pairOpen(
      owner,
      by,
      { id: link.id, urlKey: link.urlKey },
      new Date(at.getTime() - OPEN_WINDOW_MS),
      at,
    ),
  );
