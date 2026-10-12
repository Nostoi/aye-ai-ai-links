import { recentFocus } from "./profile.js";
import type { ProfileStore } from "./profile-store.js";
import type { LinkSearch } from "./search.js";
import type { LinkStore } from "./store.js";
import type { FocusEntry, Link, OwnerId } from "./types.js";

// Uncalibrated defaults (ROADMAP #34); the owner may change them.
const DAY_MS = 86_400_000;
/** Links in one digest, at most. */
export const DIGEST_SIZE = 5;
/** A link surfaced within this long before now is left out; one surfaced exactly this long ago is not. */
export const SURFACE_COOLDOWN_MS = 14 * DAY_MS;
/** Of the recent focus entries, only those created within this long count. */
export const FOCUS_WINDOW_MS = 30 * DAY_MS;
/** not_opened_recently: saved at least this long ago, and no opening recorded within it. */
export const NOT_OPENED_MS = 30 * DAY_MS;
/** Each focus entry gives its reason to at most this many links, its best-ranked eligible ones. */
export const FOCUS_MATCHES_PER_ENTRY = 3;

/**
 * Why a link is in the digest. `focus_words`: the link shares words with that focus entry, which
 * is a keyword match, not proof of relevance.
 */
export type DigestReason =
  | { kind: "focus_words"; focus: FocusEntry }
  | { kind: "no_why" }
  | { kind: "not_opened_recently" }
  | { kind: "never_surfaced" };

export type DigestLink = { link: Link; reasons: DigestReason[] };

export type DigestDeps = {
  store: LinkStore;
  profile: ProfileStore;
  /** Keyword matching only: with no similarity floor yet (#68), any link can come back as a meaning match. */
  keywordSearch: LinkSearch;
  now: () => Date;
};

const DECIMAL = /^\d+$/;

/** Decimal ids compare as numbers, others as strings. */
export function compareIds(a: string, b: string): number {
  if (DECIMAL.test(a) && DECIMAL.test(b)) {
    const [x, y] = [BigInt(a), BigInt(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function eligible(link: Link, now: Date, notSurfacedAfter: Date): boolean {
  return (
    link.state === "active" &&
    (link.snoozedUntil === null || link.snoozedUntil <= now) &&
    (link.lastSurfacedAt === null || link.lastSurfacedAt <= notSurfacedAfter)
  );
}

/** Every reason but focus. `surfacedBefore` is lastSurfacedAt as it was before this digest. */
function ownReasons(link: Link, surfacedBefore: Date | null, now: Date): DigestReason[] {
  const reasons: DigestReason[] = [];
  if (link.why === null) reasons.push({ kind: "no_why" });
  const longAgo = now.getTime() - NOT_OPENED_MS;
  if (
    link.savedAt.getTime() <= longAgo &&
    (link.lastOpenedAt === null || link.lastOpenedAt.getTime() <= longAgo)
  ) {
    reasons.push({ kind: "not_opened_recently" });
  }
  if (surfacedBefore === null) reasons.push({ kind: "never_surfaced" });
  return reasons;
}

/** Links not surfaced for longest come first (never surfaced before all), then the oldest saved. */
function rotation(a: Link, b: Link): number {
  const surfaced = (l: Link) => l.lastSurfacedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return (
    surfaced(a) - surfaced(b) || a.savedAt.getTime() - b.savedAt.getTime() || compareIds(a.id, b.id)
  );
}

/**
 * Focus reasons by link id. Entries are taken newest first and hits in rank order, so the map's
 * order is the focus links' digest order: by their newest matching entry, then rank in it.
 * Each search is the keyword engine's whole answer (limit = every link), untraced, so not logged.
 */
async function focusReasons(
  deps: DigestDeps,
  owner: OwnerId,
  now: Date,
  linkCount: number,
  isEligible: (id: string) => boolean,
): Promise<Map<string, DigestReason[]>> {
  const found = new Map<string, DigestReason[]>();
  const since = now.getTime() - FOCUS_WINDOW_MS;
  const entries = (await recentFocus(deps, owner)).filter((f) => f.createdAt.getTime() >= since);
  for (const focus of entries) {
    const hits = await deps.keywordSearch.search(owner, focus.text, {}, linkCount);
    for (const id of hits.filter(isEligible).slice(0, FOCUS_MATCHES_PER_ENTRY)) {
      found.set(id, [...(found.get(id) ?? []), { kind: "focus_words", focus }]);
    }
  }
  return found;
}

/**
 * Picks up to DIGEST_SIZE eligible links that have a reason, marks them surfaced, and returns them
 * with every reason that applies. Focus links come first; the rest rotate by `rotation`, so reason
 * kinds never outrank each other and every eligible link with a reason gets its turn.
 *
 * Eligible: active, not snoozed at now, and surfaced at or before now - SURFACE_COOLDOWN_MS.
 * The claim re-checks that in the store; a link it skips is left out, and the other reasons are
 * judged again from the link as claimed. A claimed link left with no reason is left out but stays
 * marked. A response lost after the claim still uses up its links.
 */
export async function getDigest(
  deps: DigestDeps,
  owner: OwnerId,
): Promise<{ links: DigestLink[] }> {
  const now = deps.now();
  const notSurfacedAfter = new Date(now.getTime() - SURFACE_COOLDOWN_MS);
  const all = await deps.store.listLinks(owner);
  const candidates = new Map(
    all.filter((l) => eligible(l, now, notSurfacedAfter)).map((l) => [l.id, l]),
  );
  if (candidates.size === 0) return { links: [] };

  const focus = await focusReasons(deps, owner, now, all.length, (id) => candidates.has(id));
  const rest = [...candidates.values()]
    .filter((l) => !focus.has(l.id) && ownReasons(l, l.lastSurfacedAt, now).length > 0)
    .sort(rotation);
  const picked = [...focus.keys(), ...rest.map((l) => l.id)].slice(0, DIGEST_SIZE);
  if (picked.length === 0) return { links: [] };

  const claimed = await deps.store.claimSurfaced(owner, picked, { at: now, notSurfacedAfter, now });
  const links = claimed
    .map(({ link, previousSurfacedAt }) => ({
      link,
      reasons: [...(focus.get(link.id) ?? []), ...ownReasons(link, previousSurfacedAt, now)],
    }))
    .filter((d) => d.reasons.length > 0);
  return { links };
}
