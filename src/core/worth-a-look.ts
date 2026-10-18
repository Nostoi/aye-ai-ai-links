import { createHash } from "node:crypto";
import {
  claimSurfaced,
  type DigestDeps,
  type DigestLink,
  previewDigest,
  unclaimSurfaced,
} from "./digest.js";
import { CoreError } from "./errors.js";
import { recordOpening } from "./links.js";
import type { LinkExpectation } from "./store.js";
import { listSuggestions } from "./tools.js";
import type { Link, LinkPatch, OwnerId } from "./types.js";

/** The home page's "Worth a look today": the use cases behind its cards and buttons. */

const DAY_MS = 86_400_000;
/** Cards on the home page, at most. */
export const WORTH_SIZE = 3;
/** How long Not now hides a link (owner ruling on #95). */
export const SNOOZE_MS = 14 * DAY_MS;

export type WorthDeps = DigestDeps;

/** A link's place in one day's shuffle: the same all that day (UTC), different the next. */
const dayRank = (day: number, id: string) =>
  createHash("sha256").update(`${day}:${id}`).digest("hex");

export async function worthALook(deps: WorthDeps, owner: OwnerId): Promise<DigestLink[]> {
  const shown = new Set((await listSuggestions(deps, owner)).map((s) => s.link.id));
  const { links } = await previewDigest(deps, owner, Number.POSITIVE_INFINITY, shown);
  const lead = links.find((d) => d.reasons.some((r) => r.kind === "focus_words"));
  const day = Math.floor(deps.now().getTime() / DAY_MS);
  const ranked = links.filter((d) => d !== lead).map((d) => ({ d, rank: dayRank(day, d.link.id) }));
  ranked.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const shuffled = ranked.map((r) => r.d);
  return (lead ? [lead, ...shuffled] : shuffled).slice(0, WORTH_SIZE);
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
  if (link.state !== "active") throw new CoreError("conflict", ALREADY_DONE);
  if (link.snoozedUntil !== null && link.snoozedUntil > now) {
    throw new CoreError("conflict", ALREADY_PUT_OFF);
  }
  const [claim] = await claimSurfaced({ store: deps.store, now: () => now }, owner, [id]);
  const until = new Date(now.getTime() + SNOOZE_MS);
  const expected = { state: "active" as const, snoozedUntil: link.snoozedUntil };
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
const ALREADY_DONE = "This link is already moved out of your list. Reload.";

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

/** I'm done with it. */
export async function archiveLink(deps: WorthDeps, owner: OwnerId, id: string): Promise<void> {
  await changeIf(deps, owner, id, { state: "active" }, { state: "archived" }, ALREADY_DONE);
}

/** The Undo of I'm done with it: makes the link active only while it is still archived. */
export async function unarchiveLink(deps: WorthDeps, owner: OwnerId, id: string): Promise<void> {
  await changeIf(deps, owner, id, { state: "archived" }, { state: "active" });
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
async function changeIf(
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
