import { compareIds, type DigestDeps, FOCUS_WINDOW_MS, NOT_OPENED_MS } from "./digest.js";
import { isGone } from "./link-check.js";
import { recentFocus } from "./profile.js";
import type { FocusEntry, Link, OwnerId } from "./types.js";

/** The Tidy up queue: the use cases behind Home's Tidy up tray. Keep is `keepLink` (To keep). */

/** Links in one Tidy up session; `tidySession` offers one only when this many are left to show. */
export const TIDY_SESSION = 5;

export type TidyDeps = Pick<
  DigestDeps,
  "store" | "tools" | "checks" | "profile" | "focusMatch" | "now"
>;

/** `fit`: the newest current focus entry whose words match the link, if any. */
export type TidyLink = { link: Link; fit: FocusEntry | null };

/**
 * The owner's links that qualify, oldest saved first, then lowest id. A link qualifies when it is
 * active, saved and last opened at least NOT_OPENED_MS ago, To explore (a To keep link is never
 * asked about), not a kept tool, not gone (Home's gone row asks about those), and not in `skip`.
 */
async function qualifying(
  deps: TidyDeps,
  owner: OwnerId,
  now: Date,
  skip: ReadonlySet<string>,
): Promise<Link[]> {
  const oldBefore = now.getTime() - NOT_OPENED_MS;
  const tools = await deps.tools.listTools(owner);
  const checks = await deps.checks.listChecks(owner);
  return (await deps.store.listLinks(owner))
    .filter(
      (l) =>
        !skip.has(l.id) &&
        l.state === "active" &&
        l.intent === "explore" &&
        l.savedAt.getTime() <= oldBefore &&
        (l.lastOpenedAt === null || l.lastOpenedAt.getTime() <= oldBefore) &&
        tools.get(l.id)?.status !== "kept" &&
        !isGone(checks.get(l.id) ?? null),
    )
    .sort((a, b) => a.savedAt.getTime() - b.savedAt.getTime() || compareIds(a.id, b.id));
}

/** The focus entries that count as "working on now": created within FOCUS_WINDOW_MS, newest first. */
export async function currentFocus(deps: TidyDeps, owner: OwnerId): Promise<FocusEntry[]> {
  const since = deps.now().getTime() - FOCUS_WINDOW_MS;
  return (await recentFocus(deps, owner)).filter((f) => f.createdAt.getTime() >= since);
}

/**
 * Up to `limit` old links, oldest saved first, then lowest id. Gone links are left out: Home's
 * gone row asks about them. Links in `skip` (what Home already shows) are left out before the
 * limit applies. One focus match per current focus entry, newest first.
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
  return picked.map((link) => ({ link, fit: fits.get(link.id) ?? null }));
}

/**
 * One Tidy up session for Home: the queue, with `skip` (what Home shows above it) left out, or
 * null unless a full TIDY_SESSION of links is left, so Home never offers five and shows fewer.
 */
export async function tidySession(
  deps: TidyDeps,
  owner: OwnerId,
  skip: ReadonlySet<string>,
): Promise<TidyLink[] | null> {
  const queue = await tidyQueue(deps, owner, TIDY_SESSION, skip);
  return queue.length < TIDY_SESSION ? null : queue;
}
