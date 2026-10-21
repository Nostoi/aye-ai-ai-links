import { compareIds, type DigestDeps, FOCUS_WINDOW_MS, NOT_OPENED_MS } from "./digest.js";
import { isGone } from "./link-check.js";
import { recentFocus } from "./profile.js";
import type { FocusEntry, Link, OwnerId } from "./types.js";
import { ALREADY_DONE, changeIf } from "./worth-a-look.js";

/** The Tidy up queue and Keep's wait: the use cases behind the Tidy up pages. */

const DAY_MS = 86_400_000;
/** Links in one Tidy up session; Home offers it once this many qualify. */
export const TIDY_SESSION = 5;
/** After Keep, a link stays out of Tidy up this long. */
export const TIDY_KEEP_WAIT_MS = 180 * DAY_MS;

export type TidyDeps = Pick<
  DigestDeps,
  "store" | "tools" | "checks" | "profile" | "keywordSearch" | "now"
>;

/** `fit`: the newest current focus entry whose keyword search finds the link, if any. */
export type TidyLink = { link: Link; fit: FocusEntry | null };

/**
 * The owner's links that qualify, oldest saved first, then lowest id. A link qualifies when it is
 * active, saved and last opened at least NOT_OPENED_MS ago, not a kept tool, not gone (Home's gone
 * row asks about those), and not kept in Tidy up within TIDY_KEEP_WAIT_MS.
 */
async function qualifying(deps: TidyDeps, owner: OwnerId, now: Date): Promise<Link[]> {
  const oldBefore = now.getTime() - NOT_OPENED_MS;
  const keptBefore = now.getTime() - TIDY_KEEP_WAIT_MS;
  const tools = await deps.tools.listTools(owner);
  const checks = await deps.checks.listChecks(owner);
  return (await deps.store.listLinks(owner))
    .filter(
      (l) =>
        l.state === "active" &&
        l.savedAt.getTime() <= oldBefore &&
        (l.lastOpenedAt === null || l.lastOpenedAt.getTime() <= oldBefore) &&
        tools.get(l.id)?.status !== "kept" &&
        !isGone(checks.get(l.id) ?? null) &&
        (l.tidyKeptAt === null || l.tidyKeptAt.getTime() <= keptBefore),
    )
    .sort((a, b) => a.savedAt.getTime() - b.savedAt.getTime() || compareIds(a.id, b.id));
}

/**
 * Up to `limit` old links, oldest saved first, then lowest id. Gone links are left out: Home's
 * gone row asks about them. One keyword search per current focus entry, newest first.
 */
export async function tidyQueue(
  deps: TidyDeps,
  owner: OwnerId,
  limit: number,
): Promise<TidyLink[]> {
  const now = deps.now();
  const picked = (await qualifying(deps, owner, now)).slice(0, limit);
  const since = now.getTime() - FOCUS_WINDOW_MS;
  const entries = (await recentFocus(deps, owner)).filter((f) => f.createdAt.getTime() >= since);
  const fits = new Map<string, FocusEntry>();
  if (picked.length > 0) {
    const all = await deps.store.listLinks(owner);
    for (const entry of entries) {
      for (const id of await deps.keywordSearch.search(owner, entry.text, {}, all.length)) {
        if (!fits.has(id)) fits.set(id, entry);
      }
    }
  }
  return picked.map((link) => ({ link, fit: fits.get(link.id) ?? null }));
}

/** Keep: sets tidyKeptAt = now while the link is active; a link that changed since is a conflict. */
export async function keepInTidy(deps: TidyDeps, owner: OwnerId, id: string): Promise<void> {
  await changeIf(
    deps,
    owner,
    id,
    { state: "active", putAwayAt: null },
    { tidyKeptAt: deps.now() },
    ALREADY_DONE,
  );
}

/** Whether Home offers Tidy up: at least TIDY_SESSION links qualify. */
export async function tidyReady(deps: TidyDeps, owner: OwnerId): Promise<boolean> {
  return (await qualifying(deps, owner, deps.now())).length >= TIDY_SESSION;
}
