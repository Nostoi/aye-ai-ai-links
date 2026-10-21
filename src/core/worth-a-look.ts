import {
  claimSurfaced,
  compareIds,
  type DigestDeps,
  type DigestLink,
  dayRank,
  previewDigest,
  unclaimSurfaced,
} from "./digest.js";
import { CoreError } from "./errors.js";
import { recordOpening } from "./links.js";
import type { LinkExpectation } from "./store.js";
import type { ToolItem } from "./tools.js";
import type { Link, LinkPatch, LinkState, OwnerId } from "./types.js";

/** The home page's "Worth a look today": the use cases behind its cards and buttons. */

const DAY_MS = 86_400_000;
/** Cards on the home page, at most. */
export const WORTH_SIZE = 3;
/** How long Not now hides a link (owner ruling on #95). */
export const SNOOZE_MS = 14 * DAY_MS;

export type WorthDeps = DigestDeps;

/**
 * The earliest-flagged gone link the owner could act on: active, not snoozed at `now`, not a kept
 * tool (the shelf asks about those). Ties go to the lowest id. Reads only.
 */
async function gonePick(deps: WorthDeps, owner: OwnerId): Promise<Link | null> {
  const now = deps.now();
  const links = await deps.store.listLinks(owner);
  const checks = await deps.checks.listChecks(owner);
  const tools = await deps.tools.listTools(owner);
  const flaggedAt = (l: Link) => checks.get(l.id)?.flaggedAt ?? null;
  const gone = links.filter(
    (l) =>
      l.state === "active" &&
      (l.snoozedUntil === null || l.snoozedUntil <= now) &&
      tools.get(l.id)?.status !== "kept" &&
      flaggedAt(l) !== null,
  );
  gone.sort(
    (a, b) =>
      (flaggedAt(a) as Date).getTime() - (flaggedAt(b) as Date).getTime() || compareIds(a.id, b.id),
  );
  return gone[0] ?? null;
}

/**
 * Worth a look: at most one gone link, and reading picks for the other slots of WORTH_SIZE. The
 * digest never offers a gone link, so the gone pick is not among the reading picks. Leaves out the
 * links in `suggestions`: the caller passes the suggestions it shows on the shelf. A put-away link that
 * came back leads, and at most one does, so every came-back link shown carries its reason; the
 * other came-back links wait for a later build. Else a focus match leads.
 */
export async function worthALook(
  deps: WorthDeps,
  owner: OwnerId,
  suggestions: readonly ToolItem[],
): Promise<{ links: DigestLink[]; gone: Link | null }> {
  const gone = await gonePick(deps, owner);
  const shown = new Set(suggestions.map((s) => s.link.id));
  if (gone) shown.add(gone.id);
  const { links } = await previewDigest(deps, owner, Number.POSITIVE_INFINITY, shown);
  const isCameBack = (d: DigestLink) => d.reasons.some((r) => r.kind === "came_back");
  const lead =
    links.find(isCameBack) ?? links.find((d) => d.reasons.some((r) => r.kind === "focus_words"));
  const day = Math.floor(deps.now().getTime() / DAY_MS);
  const ranked = links
    .filter((d) => d !== lead && !isCameBack(d))
    .map((d) => ({ d, rank: dayRank(day, d.link.id) }));
  ranked.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const shuffled = ranked.map((r) => r.d);
  const reading = (lead ? [lead, ...shuffled] : shuffled).slice(0, WORTH_SIZE - (gone ? 1 : 0));
  return { links: reading, gone };
}

/**
 * The owner opened the link from home: records the opening and marks it surfaced, so home leaves
 * it out for the digest's cooldown. Never logged as a search result's open.
 */
export async function markOpened(deps: WorthDeps, owner: OwnerId, id: string): Promise<void> {
  const now = deps.now();
  const at = { store: deps.store, now: () => now };
  await recordOpening(at, owner, id);
  await claimSurfaced(at, owner, [id]);
}

export type Snooze = { until: Date; claimedAt: Date | null; previousSurfacedAt: Date | null };

/** Not now: marks the link surfaced, then snoozes it for SNOOZE_MS. */
export async function snoozeLink(deps: WorthDeps, owner: OwnerId, id: string): Promise<Snooze> {
  const now = deps.now();
  const link = await deps.store.get(owner, id);
  if (!link) throw new CoreError("not_found", "That link is gone. Reload the page.");
  const putAway = link.state === "archived" && link.putAwayAt !== null;
  if (link.state !== "active" && !putAway) throw new CoreError("conflict", ALREADY_DONE);
  if (link.snoozedUntil !== null && link.snoozedUntil > now) {
    throw new CoreError("conflict", ALREADY_PUT_OFF);
  }
  const [claim] = await claimSurfaced({ store: deps.store, now: () => now }, owner, [id]);
  const until = new Date(now.getTime() + SNOOZE_MS);
  const expected = {
    state: link.state,
    putAwayAt: link.putAwayAt,
    snoozedUntil: link.snoozedUntil,
  };
  try {
    await changeIf(deps, owner, id, expected, { snoozedUntil: until }, ALREADY_PUT_OFF);
  } catch (error) {
    if (claim) await unclaimSurfaced(deps, owner, id, now, claim.previousSurfacedAt);
    throw error;
  }
  return {
    until,
    claimedAt: claim ? now : null,
    previousSurfacedAt: claim?.previousSurfacedAt ?? null,
  };
}

const ALREADY_PUT_OFF = "This link is already put off. Reload.";
export const ALREADY_DONE = "This link is already out of your lists. Reload.";

export async function unsnoozeLink(
  deps: WorthDeps,
  owner: OwnerId,
  id: string,
  snooze: Snooze,
): Promise<void> {
  if (snooze.claimedAt) {
    await unclaimSurfaced(deps, owner, id, snooze.claimedAt, snooze.previousSurfacedAt);
  }
  await changeIf(deps, owner, id, { snoozedUntil: snooze.until }, { snoozedUntil: null });
}

/** What a state action replaced and what it left; Undo sends both back. */
export type StateChange = {
  before: { state: LinkState; putAwayAt: Date | null; snoozedUntil: Date | null };
  after: { state: LinkState; putAwayAt: Date | null };
};

type StateDeps = Pick<WorthDeps, "store" | "now">;

const beforeOf = (l: Link): StateChange["before"] => ({
  state: l.state,
  putAwayAt: l.putAwayAt,
  snoozedUntil: l.snoozedUntil,
});

async function current(deps: StateDeps, owner: OwnerId, id: string): Promise<Link> {
  const link = await deps.store.get(owner, id);
  if (!link) throw new CoreError("not_found", "That link is gone. Reload the page.");
  return link;
}

/** Put it away: active -> archived with putAwayAt = now; clears the snooze. */
export async function putAwayLink(
  deps: StateDeps,
  owner: OwnerId,
  id: string,
): Promise<StateChange> {
  const link = await current(deps, owner, id);
  if (link.state !== "active") throw new CoreError("conflict", ALREADY_DONE);
  const putAwayAt = deps.now();
  const expected = { state: "active" as const, putAwayAt: null, snoozedUntil: link.snoozedUntil };
  const patch: LinkPatch = { state: "archived", putAwayAt, snoozedUntil: null };
  await changeIf(deps, owner, id, expected, patch, ALREADY_DONE);
  return { before: beforeOf(link), after: { state: "archived", putAwayAt } };
}

/** It's stale: active or put away -> archived, putAwayAt null. */
export async function archiveLink(
  deps: StateDeps,
  owner: OwnerId,
  id: string,
): Promise<StateChange> {
  const link = await current(deps, owner, id);
  if (link.state === "archived" && link.putAwayAt === null) {
    throw new CoreError("conflict", ALREADY_DONE);
  }
  const expected = { state: link.state, putAwayAt: link.putAwayAt };
  await changeIf(deps, owner, id, expected, { state: "archived", putAwayAt: null }, ALREADY_DONE);
  return { before: beforeOf(link), after: { state: "archived", putAwayAt: null } };
}

/** Bring it back: any archived link -> active, putAwayAt null. */
export async function bringBackLink(
  deps: StateDeps,
  owner: OwnerId,
  id: string,
): Promise<StateChange> {
  const link = await current(deps, owner, id);
  if (link.state === "active" && link.putAwayAt === null) {
    return { before: beforeOf(link), after: { state: "active", putAwayAt: null } };
  }
  if (link.state !== "archived") throw new CoreError("conflict", CHANGED_SINCE);
  const expected = { state: "archived" as const, putAwayAt: link.putAwayAt };
  await changeIf(deps, owner, id, expected, { state: "active", putAwayAt: null });
  return { before: beforeOf(link), after: { state: "active", putAwayAt: null } };
}

/** Undo of any of the three: only while the link matches change.after; restores change.before. */
export async function undoStateChange(
  deps: StateDeps,
  owner: OwnerId,
  id: string,
  change: StateChange,
): Promise<void> {
  for (const side of [change.before, change.after]) {
    if (side.state === "active" && side.putAwayAt !== null) {
      throw new CoreError("invalid_input", "That can't be undone. Reload the page.");
    }
  }
  await changeIf(deps, owner, id, change.after, change.before);
}

/**
 * The owner's own reason for saving the link, recorded as "asked". It fills a missing why or
 * replaces an agent's guess, never a reason the owner gave. Blank text is refused.
 */
export async function tellWhy(
  deps: Pick<WorthDeps, "store">,
  owner: OwnerId,
  id: string,
  text: string,
): Promise<Link> {
  const why = text.trim();
  if (why === "") throw new CoreError("invalid_input", "Write the reason first.");
  return changeIf(
    deps,
    owner,
    id,
    { whySource: [null, "inferred"] },
    { why: { text: why, source: "asked" } },
    "This link already has a reason. Reload.",
  );
}

const CHANGED_SINCE = "That link was changed since, so it stays as it is. Reload the page.";

/** A missing or foreign link is not_found; one that no longer matches is a `conflict`. */
export async function changeIf(
  deps: Pick<WorthDeps, "store">,
  owner: OwnerId,
  id: string,
  expected: LinkExpectation,
  patch: LinkPatch,
  conflict = CHANGED_SINCE,
): Promise<Link> {
  const result = await deps.store.updateIf(owner, id, expected, patch);
  if (!result) throw new CoreError("not_found", "That link is gone. Reload the page.");
  if (!result.applied) throw new CoreError("conflict", conflict);
  return result.link;
}
