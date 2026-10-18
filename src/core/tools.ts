import { CoreError } from "./errors.js";
import { type GoneView, goneView, isGone } from "./link-check.js";
import type { LinkCheck, LinkCheckStore } from "./link-check-store.js";
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

/**
 * A kept tool on an active link whose current wait has run out since its clock start. The wait
 * alone: `stillUsing` doubles on it, gone or not. Readers asking whether to show "Still using it?"
 * use `isDue`.
 */
export function waitRanOut(link: Link, tool: ToolRecord | null, now: Date): boolean {
  if (tool?.status !== "kept" || link.state !== "active") return false;
  return now.getTime() - clockStart(link, tool).getTime() >= currentWaitDays(link, tool) * DAY_MS;
}

/** Due for "Still using it?": its wait ran out and the link isn't gone, since the dead check replaces that question (#128). */
export function isDue(
  link: Link,
  tool: ToolRecord | null,
  check: LinkCheck | null,
  now: Date,
): boolean {
  return !isGone(check) && waitRanOut(link, tool, now);
}

export type ToolsDeps = {
  store: LinkStore;
  tools: ToolStore;
  checks: LinkCheckStore;
  now: () => Date;
};

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
 * Keep handy. Stated or asked is the owner's request: it keeps the link from any status.
 * Inferred is a guess: it only suggests the link, and never overrides kept or declined.
 */
export async function keepHandy(
  deps: ToolsDeps,
  owner: OwnerId,
  id: string,
  source: Source,
): Promise<ToolChange> {
  return change(deps, owner, id, (current, _link, now) => {
    if (source !== "inferred") return moveTo(current, "kept", source, now);
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

const DOUBLED: Record<WaitDays, WaitDays> = { 30: 60, 60: 120, 120: 120 };

/**
 * Still using it: restarts the clock. After an opening recorded since the last check the wait goes
 * back to FIRST_WAIT_DAYS. Otherwise it doubles, up to 120 days, only when the tool is due; an
 * answer while not due keeps the wait, so a repeated or unprompted answer can't jump it.
 * Only a kept tool is answered.
 */
export async function stillUsing(
  deps: ToolsDeps,
  owner: OwnerId,
  id: string,
  source: Source,
): Promise<ToolChange> {
  ownerOnly(source);
  return change(deps, owner, id, (current, link, now) => {
    if (current?.status !== "kept") {
      throw new CoreError(
        "conflict",
        "That link is not kept handy, so there is no Still using it to answer.",
      );
    }
    const waitDays = openedSinceCheck(link, current)
      ? FIRST_WAIT_DAYS
      : waitRanOut(link, current, now)
        ? DOUBLED[current.waitDays]
        : current.waitDays;
    return { ...current, answeredAt: now, waitDays };
  });
}

const WAIT_DAYS: readonly number[] = [30, 60, 120];
const SOURCES_BY_STATUS: Record<ToolStatus, readonly Source[]> = {
  kept: ["stated", "asked"],
  suggested: ["inferred"],
  declined: ["stated", "asked"],
};

/** Whether some tool action could have written `row` by `now`. */
function isProducible(row: ToolRecord, now: Date): boolean {
  const { since, answeredAt } = row;
  return (
    SOURCES_BY_STATUS[row.status].includes(row.source) &&
    WAIT_DAYS.includes(row.waitDays) &&
    since <= now &&
    (answeredAt === null || (answeredAt <= now && answeredAt >= since))
  );
}

/**
 * The Undo of a tool action: puts `previous` back (null removes the row), but only while the row
 * still holds the values `expectedCurrent` (the action's written row) has, compared by value. If
 * it differs, that is a conflict and nothing changes, as with home's Undo. A later change that
 * leaves the row with identical values is not detected. A `previous` no action could have
 * written is refused as invalid_input.
 */
export async function restoreTool(
  deps: Pick<ToolsDeps, "tools" | "now">,
  owner: OwnerId,
  id: string,
  previous: ToolRecord | null,
  expectedCurrent: ToolRecord,
): Promise<void> {
  if (previous && !isProducible(previous, deps.now())) {
    throw new CoreError("invalid_input", "That Keep handy state can't be restored.");
  }
  const result = await deps.tools.updateToolIf(owner, id, expectedCurrent, previous);
  if (!result) throw notFound(id);
  if (!result.applied) {
    throw new CoreError(
      "conflict",
      "That link's Keep handy state was changed since, so it stays as it is.",
    );
  }
}

/** A link's Keep handy state as the doors show it; null for an ordinary link. */
export type HandyView = { status: ToolStatus; source: Source; due: boolean };

export function handyView(
  link: Link,
  tool: ToolRecord | null,
  check: LinkCheck | null,
  now: Date,
): HandyView | null {
  return tool && { status: tool.status, source: tool.source, due: isDue(link, tool, check, now) };
}

/** A link's Keep handy state and its gone state, as the doors show them. */
export type LinkView = { handy: HandyView | null; gone: GoneView | null };

type ViewDeps = Pick<ToolsDeps, "tools" | "checks" | "now">;

const viewOf = (
  link: Link,
  tool: ToolRecord | null,
  check: LinkCheck | null,
  now: Date,
): LinkView => ({ handy: handyView(link, tool, check, now), gone: goneView(check) });

/** One link's view, from one read of its tool row and one of its check row. Another owner's link has no rows for `owner`, so it gets nulls. */
export async function linkView(deps: ViewDeps, owner: OwnerId, link: Link): Promise<LinkView> {
  const tool = await deps.tools.getTool(owner, link.id);
  return viewOf(link, tool, await deps.checks.getCheck(owner, link.id), deps.now());
}

/** One link's Keep handy state. */
export async function handyOf(
  deps: ViewDeps,
  owner: OwnerId,
  link: Link,
): Promise<HandyView | null> {
  return (await linkView(deps, owner, link)).handy;
}

/** Each link's view by id, from one read of the owner's tool rows and one of their check rows. */
export async function linkViews(
  deps: ViewDeps,
  owner: OwnerId,
  links: readonly Link[],
): Promise<Map<string, LinkView>> {
  const tools = await deps.tools.listTools(owner);
  const checks = await deps.checks.listChecks(owner);
  const now = deps.now();
  return new Map(
    links.map((l) => [l.id, viewOf(l, tools.get(l.id) ?? null, checks.get(l.id) ?? null, now)]),
  );
}

/** Each link's Keep handy state by id. */
export async function handyOfLinks(
  deps: ViewDeps,
  owner: OwnerId,
  links: Link[],
): Promise<Map<string, HandyView | null>> {
  const views = await linkViews(deps, owner, links);
  return new Map([...views].map(([id, v]) => [id, v.handy]));
}

/** A tool row with its link. */
export type ToolItem = { link: Link; tool: ToolRecord };
/** A tile on the Handy shelf. `gone`: its link seems gone, so it is asked about as gone, never as due. */
export type ShelfItem = ToolItem & { due: boolean; gone: boolean };

/** The owner's active links whose row has `status`, in the store's link order. */
async function toolItems(deps: ToolsDeps, owner: OwnerId, status: ToolStatus): Promise<ToolItem[]> {
  const links = await deps.store.listLinks(owner);
  const tools = await deps.tools.listTools(owner);
  return links.flatMap((link) => {
    const tool = tools.get(link.id);
    return tool?.status === status && link.state === "active" ? [{ link, tool }] : [];
  });
}

const newestFirst = (a: Date, b: Date) => b.getTime() - a.getTime();

/** Opened tools first, most recent opening first; then never-opened ones by since, newest first. */
function shelfOrder(a: ToolItem, b: ToolItem): number {
  const x = a.link.lastOpenedAt;
  const y = b.link.lastOpenedAt;
  if (x && y) return newestFirst(x, y);
  if (x || y) return x ? -1 : 1;
  return newestFirst(a.tool.since, b.tool.since);
}

/**
 * The Handy shelf: every kept tool on an active link, each with its due and gone flags. Due
 * and gone tools come first (owner ruling 2026-10-16; #128), so the tiles asking something lead
 * the shelf; within each group, shelf order.
 */
export async function listShelf(deps: ToolsDeps, owner: OwnerId): Promise<ShelfItem[]> {
  const now = deps.now();
  const checks = await deps.checks.listChecks(owner);
  const items = (await toolItems(deps, owner, "kept")).map((i) => {
    const check = checks.get(i.link.id) ?? null;
    return { ...i, due: isDue(i.link, i.tool, check, now), gone: isGone(check) };
  });
  const asking = (i: ShelfItem) => Number(i.due || i.gone);
  return items.sort((a, b) => asking(b) - asking(a) || shelfOrder(a, b));
}

export const SUGGESTION_SIZE = 2;

/**
 * The shelf's suggestions: the newest SUGGESTION_SIZE suggested tools on active links that don't
 * seem gone (#128), newest first. A gone link is skipped, so the next suggestion fills its place.
 */
export async function listSuggestions(deps: ToolsDeps, owner: OwnerId): Promise<ToolItem[]> {
  const checks = await deps.checks.listChecks(owner);
  return (await toolItems(deps, owner, "suggested"))
    .filter((i) => !isGone(checks.get(i.link.id) ?? null))
    .sort((a, b) => newestFirst(a.tool.since, b.tool.since))
    .slice(0, SUGGESTION_SIZE);
}
