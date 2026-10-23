import type { LinkEventKind, OwnerId } from "./types.js";

/** One row of the event log (`link_events`, #161). */
export type StatsEvent = { linkId: string; kind: LinkEventKind; at: Date };

/** What the Stats counts read that no other store holds: the event log and when it began. */
export interface StatsStore {
  /** The owner's events of live links, oldest first. */
  statsEvents(owner: OwnerId): Promise<StatsEvent[]>;
  /** When the log began (`stats_meta`). One value for the whole server. */
  trackingSince(): Promise<Date>;
}
