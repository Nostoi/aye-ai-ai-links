import type { ToolRecord, WaitDays } from "./tool-store.js";
import type { Link } from "./types.js";

/**
 * Keep handy: every rule about tools. The doors only translate requests into these calls.
 * Nothing is written on opening: an opening moves the clock through `lastOpenedAt` alone
 * (#125 comment 6225715918), so the wait is worked out when it is checked.
 */

const DAY_MS = 86_400_000;
/** The first wait, and the wait after any recorded opening (owner ruling, #125). */
export const FIRST_WAIT_DAYS: WaitDays = 30;

const latest = (dates: (Date | null)[]): Date =>
  new Date(Math.max(...dates.filter((d): d is Date => d !== null).map((d) => d.getTime())));

/** The last check: the last "Still using it" answer, or when the link took its status. */
const lastCheck = (tool: ToolRecord): Date => latest([tool.answeredAt, tool.since]);

/**
 * Opened since the last check. An opening in the same millisecond counts (ruling, 2026-10-16:
 * "any opening resets"); at a fresh keep this can only give the first wait, which it has anyway.
 */
const openedSinceCheck = (link: Link, tool: ToolRecord): boolean =>
  link.lastOpenedAt !== null && link.lastOpenedAt.getTime() >= lastCheck(tool).getTime();

/** The latest of the last recorded opening, the last answer and when the link became a tool. */
export function clockStart(link: Link, tool: ToolRecord): Date {
  return latest([link.lastOpenedAt, tool.answeredAt, tool.since]);
}

/** The wait that applies now: FIRST_WAIT_DAYS after an opening recorded since the last check. */
export function currentWaitDays(link: Link, tool: ToolRecord): WaitDays {
  return openedSinceCheck(link, tool) ? FIRST_WAIT_DAYS : tool.waitDays;
}

/** A kept tool on an active link whose current wait has run out since its clock start. */
export function isDue(link: Link, tool: ToolRecord | null, now: Date): boolean {
  if (tool?.status !== "kept" || link.state !== "active") return false;
  return now.getTime() - clockStart(link, tool).getTime() >= currentWaitDays(link, tool) * DAY_MS;
}
