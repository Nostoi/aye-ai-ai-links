import type { ListRanks, SearchFilters, SearchTrace } from "./search.js";
import type { PendingSearch } from "./search-receipts.js";
import type { OwnerId } from "./types.js";

/** One link a logged search returned. `similarity` is null for a link found by keyword only. */
export type LoggedResult = {
  id: string;
  urlKey: string;
  similarity: number | null;
  ranks: ListRanks;
};

export type SearchLogEntry = Pick<SearchTrace, "mode" | "embedded" | "modelKey"> &
  Pick<SearchTrace, "meaningCandidates"> & {
    query: string;
    filters: SearchFilters;
    /** The request limit after clamping. Fewer results than this means the search was exhaustive. */
    limit: number;
    results: LoggedResult[];
  };

/** A logged web search as its receipt finds it: who searched, when, whether it is paired, what it showed. */
export type ReceiptRow = {
  by: string;
  createdAt: Date;
  openedLinkId: string | null;
  resultIds: string[];
};

export interface SearchLog {
  /** With a `receipt`, a second write of the same receipt writes nothing. */
  record(
    owner: OwnerId,
    by: string,
    entry: SearchLogEntry,
    at: Date,
    receipt?: string,
  ): Promise<void>;
  /** The owner's row for the receipt, or null: another owner's receipt reads as none. */
  receiptRow(owner: OwnerId, receipt: string): Promise<ReceiptRow | null>;
  /** Pairs the owner's row for the receipt, only while it is still unpaired. */
  pairReceipt(
    owner: OwnerId,
    receipt: string,
    link: { id: string; urlKey: string },
    at: Date,
  ): Promise<void>;
  pairOpen(
    owner: OwnerId,
    by: string,
    link: { id: string; urlKey: string },
    since: Date,
    at: Date,
  ): Promise<void>;
}

/**
 * A search is paired with an open of one of its results only within this long: the same agent's
 * next get_link, or a click on its web results page.
 */
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
  receipt?: string,
): Promise<void> => bestEffort("record a search", () => log?.record(owner, by, entry, at, receipt));

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

/** Writes the web search the page showed, from its pending entry. The same receipt twice writes one row. */
export const logReceipt = (
  log: SearchLog | undefined,
  owner: OwnerId,
  by: string,
  receipt: string,
  pending: PendingSearch | undefined,
): Promise<void> =>
  pending ? logSearch(log, owner, by, pending.entry, pending.at, receipt) : Promise.resolve();

/**
 * Pairs a click on a web results page with the search it came from. The row for `receipt` is
 * written first if the page's own report has not arrived. The row must be the owner's, written by
 * `by`, unpaired and inside the window, and the opened link one of its results.
 */
export const logOpenFromReceipt = (
  log: SearchLog | undefined,
  owner: OwnerId,
  by: string,
  receipt: string,
  pending: PendingSearch | undefined,
  link: { id: string; urlKey: string },
  at: Date,
): Promise<void> =>
  bestEffort("pair an opened link with its web search", async () => {
    if (!log) return;
    if (pending) await log.record(owner, by, pending.entry, pending.at, receipt);
    const row = await log.receiptRow(owner, receipt);
    if (
      !row ||
      row.by !== by ||
      row.openedLinkId !== null ||
      row.createdAt.getTime() < at.getTime() - OPEN_WINDOW_MS ||
      !row.resultIds.includes(link.id)
    ) {
      return;
    }
    await log.pairReceipt(owner, receipt, { id: link.id, urlKey: link.urlKey }, at);
  });
