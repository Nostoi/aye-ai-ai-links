import { CoreError } from "./errors.js";
import type { LinkCheckOutcome } from "./fetch.js";
import type { CheckCutoffs, CheckResult, LinkCheck, LinkCheckStore } from "./link-check-store.js";
import { notFound } from "./links.js";
import type { LinkStore } from "./store.js";
import type { OwnerId } from "./types.js";

/**
 * Dead-link checks (#128): every rule about them. The check runner and the doors only call these.
 * Design: docs/specs/2026-10-17-dead-link-checks-design.md.
 */

const DAY_MS = 86_400_000;
/** Days between checks of an active link, Keep handy tools on active links included (ruling). */
export const CHECK_ACTIVE_DAYS = 7;
/** Days between checks of an archived link: "monthly" (A4). */
export const CHECK_ARCHIVED_DAYS = 30;
/** A dead check at least this long after the streak's first dead one flags the link (ruling). */
export const FLAG_AFTER_MS = 7 * DAY_MS;

/** What one check found. `detail` is null for alive. */
export type CheckVerdict = { result: CheckResult; detail: string | null };

/** The due read's cutoffs at `now`. Neither interval is under FLAG_AFTER_MS, so every next dead check counts. */
export function checkCutoffs(now: Date): CheckCutoffs {
  return {
    active: new Date(now.getTime() - CHECK_ACTIVE_DAYS * DAY_MS),
    archived: new Date(now.getTime() - CHECK_ARCHIVED_DAYS * DAY_MS),
  };
}

/**
 * The verdict of one check, or null for one aborted by shutdown, which records nothing. Only clear
 * signals are dead: a 404 or 410 as the final answer, and ENOTFOUND when `resolverUp` (the
 * checker could resolve a known name just after). Anything else is unknown: couldn't check is never dead.
 */
export function judgeCheck(outcome: LinkCheckOutcome, resolverUp: boolean): CheckVerdict | null {
  switch (outcome.kind) {
    case "ok":
      return { result: "alive", detail: null };
    case "http_error": {
      const dead = outcome.status === 404 || outcome.status === 410;
      return { result: dead ? "dead" : "unknown", detail: `http:${outcome.status}` };
    }
    case "network_error":
      if (outcome.code !== "ENOTFOUND") {
        return { result: "unknown", detail: `network:${outcome.code}` };
      }
      return resolverUp
        ? { result: "dead", detail: "network:ENOTFOUND" }
        : { result: "unknown", detail: "network:ENOTFOUND:offline" };
    case "timeout":
      return { result: "unknown", detail: "timeout" };
    case "refused":
      return { result: "unknown", detail: `refused:${outcome.reason}` };
    case "too_large":
      return { result: "unknown", detail: "too_large" };
    case "aborted":
      return null;
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

/**
 * The row after a check that started at `at`. Every check writes `checkedAt`, `result` and
 * `detail`. Alive clears the streak and the flag. Unknown changes neither. Dead is dropped when
 * the owner said It still works at or after `at`. Otherwise it starts the streak, and flags the
 * link once FLAG_AFTER_MS have passed since the streak's first dead check.
 */
export function applyCheck(current: LinkCheck | null, verdict: CheckVerdict, at: Date): LinkCheck {
  const next: LinkCheck = {
    checkedAt: at,
    result: verdict.result,
    detail: verdict.detail,
    firstDeadAt: current?.firstDeadAt ?? null,
    flaggedAt: current?.flaggedAt ?? null,
    stillWorksAt: current?.stillWorksAt ?? null,
  };
  if (verdict.result === "alive") return { ...next, firstDeadAt: null, flaggedAt: null };
  if (verdict.result === "unknown") return next;
  if (next.stillWorksAt !== null && next.stillWorksAt.getTime() >= at.getTime()) return next;
  const firstDeadAt = next.firstDeadAt ?? at;
  const flaggedAt =
    next.flaggedAt ?? (at.getTime() - firstDeadAt.getTime() >= FLAG_AFTER_MS ? at : null);
  return { ...next, firstDeadAt, flaggedAt };
}

/** Gone: flagged. The one test every reader uses. */
export function isGone(check: LinkCheck | null): boolean {
  return check !== null && check.flaggedAt !== null;
}

/** When a gone link was flagged, and when it was last checked. */
export type GoneView = { since: Date; checkedAt: Date };

export function goneView(check: LinkCheck | null): GoneView | null {
  return check !== null && check.flaggedAt !== null
    ? { since: check.flaggedAt, checkedAt: check.checkedAt }
    : null;
}

export type LinkCheckDeps = { store: LinkStore; checks: LinkCheckStore; now: () => Date };

/** What It still works did: the row it wrote, and the row it replaced. */
export type CheckChange = { check: LinkCheck; previous: LinkCheck };

const NOT_GONE = "This link isn't marked as gone. Reload the page.";
const CHECKED_SINCE = "This link was checked since, so it stays as it is.";

/**
 * It still works: only on a flagged link. Clears the flag and the streak and records when (A3), so
 * the link is flagged again only after two new dead checks at least FLAG_AFTER_MS apart.
 */
export async function stillWorks(
  deps: LinkCheckDeps,
  owner: OwnerId,
  id: string,
): Promise<CheckChange> {
  const now = deps.now();
  if (!(await deps.store.get(owner, id))) throw notFound(id);
  const current = await deps.checks.getCheck(owner, id);
  if (current === null || !isGone(current)) throw new CoreError("conflict", NOT_GONE);
  const next: LinkCheck = { ...current, firstDeadAt: null, flaggedAt: null, stillWorksAt: now };
  const result = await deps.checks.updateCheckIf(owner, id, current, next);
  if (!result) throw notFound(id);
  if (!result.applied) throw new CoreError("conflict", CHECKED_SINCE);
  return { check: next, previous: current };
}

/** A real time no later than `now`; null passes (the column is empty). */
const isPast = (when: Date | null, now: Date): boolean =>
  when === null || (Number.isFinite(when.getTime()) && when <= now);

/**
 * Whether It still works could have replaced `previous` by `now`: only a flagged row, whose dates are
 * real and not in the future, flagged at least FLAG_AFTER_MS after its first dead check.
 */
function isRestorable(previous: LinkCheck, now: Date): boolean {
  const { checkedAt, firstDeadAt, flaggedAt, stillWorksAt } = previous;
  return (
    flaggedAt !== null &&
    firstDeadAt !== null &&
    [checkedAt, firstDeadAt, flaggedAt, stillWorksAt].every((d) => isPast(d, now)) &&
    flaggedAt.getTime() - firstDeadAt.getTime() >= FLAG_AFTER_MS
  );
}

/**
 * The Undo of It still works (`restoreTool`'s rule): puts back `previous`'s flag, streak and
 * stillWorksAt, only while the row still equals, by value, what It still works wrote
 * (`expectedCurrent`). Otherwise it is a conflict and nothing changes. An earlier row no check could
 * have left is refused as invalid_input. No time limit here; the Undo bar closes on its own.
 */
export async function restoreCheck(
  deps: Pick<LinkCheckDeps, "checks" | "now">,
  owner: OwnerId,
  id: string,
  previous: LinkCheck,
  expectedCurrent: LinkCheck,
): Promise<void> {
  if (!isRestorable(previous, deps.now())) {
    throw new CoreError("invalid_input", "That check state can't be restored.");
  }
  const next: LinkCheck = {
    ...expectedCurrent,
    firstDeadAt: previous.firstDeadAt,
    flaggedAt: previous.flaggedAt,
    stillWorksAt: previous.stillWorksAt,
  };
  const result = await deps.checks.updateCheckIf(owner, id, expectedCurrent, next);
  if (!result) throw notFound(id);
  if (!result.applied) throw new CoreError("conflict", CHECKED_SINCE);
}
