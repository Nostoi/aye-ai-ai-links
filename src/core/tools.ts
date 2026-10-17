import { CoreError } from "./errors.js";
import { notFound } from "./links.js";
import type { LinkStore } from "./store.js";
import type { ToolRecord, ToolStore, WaitDays } from "./tool-store.js";
import type { Link, OwnerId, Source, ToolStatus } from "./types.js";

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

export type ToolsDeps = { store: LinkStore; tools: ToolStore; now: () => Date };

/** What a tool action did: the row it wrote, and the row it replaced (null: there was none). */
export type ToolChange = { tool: ToolRecord; previous: ToolRecord | null };

const CHANGED =
  "That link's Keep handy state changed at the same moment. Read the link again and retry.";

/**
 * The row with `status` and `source`. Keeping its status keeps its dates and wait; a new status
 * starts now with a first wait, so a link that becomes a tool starts its clock then.
 */
function moveTo(
  current: ToolRecord | null,
  status: ToolStatus,
  source: Source,
  now: Date,
): ToolRecord {
  if (current?.status === status) return { ...current, source };
  return { status, source, since: now, answeredAt: null, waitDays: FIRST_WAIT_DAYS };
}

/**
 * Reads the link and its row, lets `decide` work out the next row (returning `current` itself
 * for no change), and writes it only while the row is unchanged since the read.
 */
async function change(
  deps: ToolsDeps,
  owner: OwnerId,
  id: string,
  decide: (current: ToolRecord | null, link: Link, now: Date) => ToolRecord,
): Promise<ToolChange> {
  const now = deps.now();
  const link = await deps.store.get(owner, id);
  if (!link) throw notFound(id);
  const current = await deps.tools.getTool(owner, id);
  const next = decide(current, link, now);
  if (next === current) return { tool: next, previous: current };
  const result = await deps.tools.updateToolIf(owner, id, current, next);
  if (!result) throw notFound(id);
  if (!result.applied) throw new CoreError("conflict", CHANGED);
  return { tool: next, previous: current };
}

function ownerOnly(source: Source): void {
  if (source === "inferred") {
    throw new CoreError(
      "invalid_input",
      "Only the owner can say this. Send stated or asked, not inferred.",
    );
  }
}

/**
 * Keep handy. Stated or asked is the owner's request: it keeps the link from any status, with a
 * first wait. Inferred is a guess: it only suggests the link, and never overrides kept or declined.
 */
export async function keepHandy(
  deps: ToolsDeps,
  owner: OwnerId,
  id: string,
  source: Source,
): Promise<ToolChange> {
  return change(deps, owner, id, (current, _link, now) => {
    if (source !== "inferred") {
      return { ...moveTo(current, "kept", source, now), waitDays: FIRST_WAIT_DAYS };
    }
    if (current?.status === "kept" || current?.status === "declined") return current;
    return moveTo(current, "suggested", "inferred", now);
  });
}

/** The owner's answer to a suggestion: yes keeps the link, no declines it; both as asked. */
export async function answerSuggestion(
  deps: ToolsDeps,
  owner: OwnerId,
  id: string,
  keep: boolean,
): Promise<ToolChange> {
  return change(deps, owner, id, (current, _link, now) => {
    if (current?.status !== "suggested") {
      throw new CoreError("conflict", "That link has no Keep handy suggestion to answer.");
    }
    return moveTo(current, keep ? "kept" : "declined", "asked", now);
  });
}

/** Not handy anymore: declines the link from any status, so no agent suggests it again. */
export async function notHandy(
  deps: ToolsDeps,
  owner: OwnerId,
  id: string,
  source: Source,
): Promise<ToolChange> {
  ownerOnly(source);
  return change(deps, owner, id, (current, _link, now) => moveTo(current, "declined", source, now));
}
