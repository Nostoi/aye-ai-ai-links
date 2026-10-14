import { claimSurfaced, type DigestDeps, type DigestLink, previewDigest } from "./digest.js";
import { CoreError } from "./errors.js";
import { updateLink } from "./links.js";
import type { LinkExpectation } from "./store.js";
import type { Link, LinkPatch, OwnerId } from "./types.js";

/** The home page's "Worth a look today": the use cases behind its cards and buttons. */

const DAY_MS = 86_400_000;
/** Cards on the home page, at most. */
export const WORTH_SIZE = 3;
/** How long Not now hides a link (owner ruling on #95). */
export const SNOOZE_MS = 14 * DAY_MS;

export type WorthDeps = DigestDeps;

/**
 * Up to WORTH_SIZE links from the whole digest queue, marking nothing. The picks change once a
 * day (UTC): each day starts WORTH_SIZE further along the queue, wrapping round.
 */
export async function worthALook(deps: WorthDeps, owner: OwnerId): Promise<DigestLink[]> {
  const { links } = await previewDigest(deps, owner, Number.POSITIVE_INFINITY);
  if (links.length <= WORTH_SIZE) return links;
  const day = Math.floor(deps.now().getTime() / DAY_MS);
  const start = (day * WORTH_SIZE) % links.length;
  return Array.from(
    { length: WORTH_SIZE },
    (_, i) => links[(start + i) % links.length] as DigestLink,
  );
}

/**
 * The owner opened the link from home: records the opening and marks it surfaced, so home leaves
 * it out for the digest's cooldown. Never logged as a search result's open.
 */
export async function markOpened(deps: WorthDeps, owner: OwnerId, id: string): Promise<void> {
  const now = deps.now();
  const at = { store: deps.store, now: () => now };
  await updateLink(at, owner, id, { opened: true });
  await claimSurfaced(at, owner, [id]);
}

/** Not now: marks the link surfaced, then snoozes it for SNOOZE_MS. Returns when the snooze ends. */
export async function snoozeLink(deps: WorthDeps, owner: OwnerId, id: string): Promise<Date> {
  const now = deps.now();
  await claimSurfaced({ store: deps.store, now: () => now }, owner, [id]);
  const until = new Date(now.getTime() + SNOOZE_MS);
  await updateLink(deps, owner, id, { snoozedUntil: until });
  return until;
}

/** The Undo of Not now: clears the snooze only while it is still the one Not now set (`until`). */
export async function unsnoozeLink(
  deps: WorthDeps,
  owner: OwnerId,
  id: string,
  until: Date,
): Promise<void> {
  await changeIf(deps, owner, id, { snoozedUntil: until }, { snoozedUntil: null });
}

/** I'm done with it. */
export async function archiveLink(deps: WorthDeps, owner: OwnerId, id: string): Promise<void> {
  await updateLink(deps, owner, id, { state: "archived" });
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
  deps: WorthDeps,
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
  deps: WorthDeps,
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
