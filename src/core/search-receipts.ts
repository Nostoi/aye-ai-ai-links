import { randomBytes } from "node:crypto";
import { OPEN_WINDOW_MS, type SearchLogEntry } from "./search-log.js";
import type { OwnerId } from "./types.js";

/** A receipt as a page sends it back: the shape `SearchReceipts` issues. */
export const isReceiptToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/**
 * A search the owner's page showed, held in memory until the page reports it (#134). Nothing here
 * touches the database: the page loads without writing, and a restart loses these.
 */
export type PendingSearch = { entry: SearchLogEntry; at: Date };

/** Whether a navigation came from the app's own page or the address bar, not another site. */
export const fromOwnPage = (secFetchSite: string | undefined): boolean =>
  secFetchSite === undefined || secFetchSite === "same-origin" || secFetchSite === "none";

/**
 * Pending receipts: a random token per search, bound to the owner who searched. At most `max`
 * are kept, each for `OPEN_WINDOW_MS`; past the limit the oldest go first.
 */
export class SearchReceipts {
  private readonly held = new Map<string, PendingSearch & { owner: OwnerId }>();
  private readonly now: () => Date;
  private readonly token: () => string;
  private readonly max: number;

  constructor({
    now = () => new Date(),
    token = () => randomBytes(18).toString("base64url"),
    max = 200,
  }: { now?: () => Date; token?: () => string; max?: number } = {}) {
    this.now = now;
    this.token = token;
    this.max = max;
  }

  /** Holds the entry for the owner and returns its receipt. */
  issue(owner: OwnerId, entry: SearchLogEntry): string {
    const at = this.now();
    const receipt = this.token();
    this.held.set(receipt, { owner, entry, at });
    while (this.held.size > this.max) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
    }
    return receipt;
  }

  /** The owner's own pending search for the receipt, or undefined when unknown, another's or expired. */
  find(owner: OwnerId, receipt: string): PendingSearch | undefined {
    const held = this.held.get(receipt);
    if (!held) return undefined;
    if (this.now().getTime() - held.at.getTime() >= OPEN_WINDOW_MS) {
      this.held.delete(receipt);
      return undefined;
    }
    return held.owner === owner ? { entry: held.entry, at: held.at } : undefined;
  }
}
