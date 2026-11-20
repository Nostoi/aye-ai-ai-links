import { compareIds, type DigestDeps, FOCUS_WINDOW_MS, NOT_OPENED_MS } from "./digest.js";
import { isGone } from "./link-check.js";
import { recentFocus } from "./profile.js";
import type { FocusEntry, Link, OwnerId } from "./types.js";
import { SNOOZE_MS } from "./worth-a-look.js";

/** The Tidy up queue: the use cases behind Home's Tidy up tray. Keep is `keepLink` (To keep). */

/** Links in one Tidy up session, at most. */
export const TIDY_SESSION = 5;

export type TidyDeps = Pick<
  DigestDeps,
  "store" | "tools" | "checks" | "profile" | "focusMatch" | "now"
>;

/**
 * `gone`: the page seems gone, so the question is whether it still works. `fit`: the newest
 * current focus entry whose words match the link, if any.
 */
export type TidyLink = { link: Link; gone: boolean; fit: FocusEntry | null };

/**
 * The owner's links that qualify: first the ones whose page seems gone (whatever their intent or
 * age), by when they were flagged, then the old To explore ones, oldest saved first, then lowest
 * id. Both are active, not a kept tool, not in `skip`, and not under a Skip: a snooze that ends
 * after now but within SNOOZE_MS. A longer snooze (an agent's) does not hold Tidy back. An old
 * link was saved and last opened at least NOT_OPENED_MS ago.
 */
async function qualifying(
  deps: TidyDeps,
  owner: OwnerId,
  now: Date,
  skip: ReadonlySet<string>,
): Promise<{ link: Link; gone: boolean }[]> {
  const oldBefore = now.getTime() - NOT_OPENED_MS;
  const skippedUntil = now.getTime() + SNOOZE_MS;
  const tools = await deps.tools.listTools(owner);
  const checks = await deps.checks.listChecks(owner);
  const asked = (await deps.store.listLinks(owner)).filter(
    (l) =>
      !skip.has(l.id) &&
      l.state === "active" &&
      !(
        l.snoozedUntil !== null &&
        l.snoozedUntil > now &&
        l.snoozedUntil.getTime() <= skippedUntil
      ) &&
      tools.get(l.id)?.status !== "kept",
  );
  const flaggedAt = (l: Link) => checks.get(l.id)?.flaggedAt?.getTime() ?? 0;
  const gone = asked
    .filter((l) => isGone(checks.get(l.id) ?? null))
    .sort((a, b) => flaggedAt(a) - flaggedAt(b) || compareIds(a.id, b.id));
  const old = asked
    .filter(
      (l) =>
        !isGone(checks.get(l.id) ?? null) &&
        l.intent === "explore" &&
        l.savedAt.getTime() <= oldBefore &&
        (l.lastOpenedAt === null || l.lastOpenedAt.getTime() <= oldBefore),
    )
    .sort((a, b) => a.savedAt.getTime() - b.savedAt.getTime() || compareIds(a.id, b.id));
  return [
    ...gone.map((link) => ({ link, gone: true })),
    ...old.map((link) => ({ link, gone: false })),
  ];
}

/** The focus entries that count as "working on now": created within FOCUS_WINDOW_MS, newest first. */
export async function currentFocus(deps: TidyDeps, owner: OwnerId): Promise<FocusEntry[]> {
  const since = deps.now().getTime() - FOCUS_WINDOW_MS;
  return (await recentFocus(deps, owner)).filter((f) => f.createdAt.getTime() >= since);
}

/**
 * Up to `limit` links to ask about, gone pages first, then old links oldest saved first. Links in
 * `skip` (what Home already shows) are left out before the limit applies. One focus match per
 * current focus entry, newest first.
 */
export async function tidyQueue(
  deps: TidyDeps,
  owner: OwnerId,
  limit: number,
  skip: ReadonlySet<string> = new Set(),
): Promise<TidyLink[]> {
  const now = deps.now();
  const picked = (await qualifying(deps, owner, now, skip)).slice(0, limit);
  const entries = await currentFocus(deps, owner);
  const fits = new Map<string, FocusEntry>();
  if (picked.length > 0) {
    for (const entry of entries) {
      for (const { id } of await deps.focusMatch.match(owner, entry.text, {})) {
        if (!fits.has(id)) fits.set(id, entry);
      }
    }
  }
  return picked.map(({ link, gone }) => ({ link, gone, fit: fits.get(link.id) ?? null }));
}

/**
 * One Tidy up session for Home: the queue, with `skip` (what Home shows above it) left out, or
 * null when no link qualifies.
 */
export async function tidySession(
  deps: TidyDeps,
  owner: OwnerId,
  skip: ReadonlySet<string>,
): Promise<TidyLink[] | null> {
  const queue = await tidyQueue(deps, owner, TIDY_SESSION, skip);
  return queue.length === 0 ? null : queue;
}
