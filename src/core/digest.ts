import { CoreError } from "./errors.js";
import { recentFocus } from "./profile.js";
import type { ProfileStore } from "./profile-store.js";
import type { LinkSearch } from "./search.js";
import type { LinkStore, SurfacedClaim } from "./store.js";
import type { ToolStore } from "./tool-store.js";
import { isDue } from "./tools.js";
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
/** At most this many of a digest's links are picked for a focus match; the rest rotate. */
export const FOCUS_SLOTS = 3;

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
  /** Keep handy rows: a kept tool is not reading, so it gets no reason. */
  tools: ToolStore;
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

/** A fair queue: least recently touched first (last surfaced, or saved if never), then oldest saved. */
function rotation(a: Link, b: Link): number {
  const touched = (l: Link) => (l.lastSurfacedAt ?? l.savedAt).getTime();
  return (
    touched(a) - touched(b) || a.savedAt.getTime() - b.savedAt.getTime() || compareIds(a.id, b.id)
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
 * Up to `limit` eligible links that have a reason, in digest order, with each one's focus reasons.
 * Reads only. Eligible: active, not a kept tool, not snoozed at now, and surfaced at or before now -
 * SURFACE_COOLDOWN_MS.
 */
async function select(
  deps: DigestDeps,
  owner: OwnerId,
  now: Date,
  limit: number,
): Promise<{ picked: Link[]; focus: Map<string, DigestReason[]> }> {
  const notSurfacedAfter = new Date(now.getTime() - SURFACE_COOLDOWN_MS);
  const all = await deps.store.listLinks(owner);
  const tools = await deps.tools.listTools(owner);
  const candidates = new Map(
    all
      .filter((l) => tools.get(l.id)?.status !== "kept" && eligible(l, now, notSurfacedAfter))
      .map((l) => [l.id, l]),
  );
  if (candidates.size === 0) return { picked: [], focus: new Map() };

  const focus = await focusReasons(deps, owner, now, all.length, (id) => candidates.has(id));
  const focusPicked = [...focus.keys()].slice(0, FOCUS_SLOTS);
  const rest = [...candidates.values()]
    .filter(
      (l) =>
        !focusPicked.includes(l.id) &&
        (focus.has(l.id) || ownReasons(l, l.lastSurfacedAt, now).length > 0),
    )
    .sort(rotation);
  const picked = [...focusPicked.map((id) => candidates.get(id) as Link), ...rest];
  return { picked: picked.slice(0, limit), focus };
}

/**
 * Marks the owner's links `ids` surfaced at now, the one write behind the digest's cooldown. The
 * store re-checks eligibility; a link no longer eligible is skipped and left as it is.
 */
export async function claimSurfaced(
  deps: Pick<DigestDeps, "store" | "now">,
  owner: OwnerId,
  ids: string[],
  { exceptKeptTools = false }: { exceptKeptTools?: boolean } = {},
): Promise<SurfacedClaim[]> {
  const now = deps.now();
  const notSurfacedAfter = new Date(now.getTime() - SURFACE_COOLDOWN_MS);
  return ids.length === 0
    ? []
    : deps.store.claimSurfaced(owner, ids, { at: now, notSurfacedAfter, now, exceptKeptTools });
}

export async function unclaimSurfaced(
  deps: Pick<DigestDeps, "store">,
  owner: OwnerId,
  id: string,
  claimedAt: Date,
  previous: Date | null,
): Promise<boolean> {
  if (previous !== null && previous >= claimedAt) {
    throw new CoreError("invalid_input", "The surfacing to put back must be before the claim.");
  }
  return deps.store.unclaimSurfaced(owner, id, { at: claimedAt, previous });
}

/**
 * What `getDigest` would return now, without marking anything: up to `limit` links (DIGEST_SIZE
 * by default) in the same order, with every reason that applies.
 */
export async function previewDigest(
  deps: DigestDeps,
  owner: OwnerId,
  limit = DIGEST_SIZE,
): Promise<{ links: DigestLink[] }> {
  const now = deps.now();
  const { picked, focus } = await select(deps, owner, now, limit);
  const links = picked.map((link) => ({
    link,
    reasons: [...(focus.get(link.id) ?? []), ...ownReasons(link, link.lastSurfacedAt, now)],
  }));
  return { links };
}

/**
 * Picks up to DIGEST_SIZE eligible links that have a reason, marks them surfaced, and returns them
 * with every reason that applies.
 *
 * The claim re-checks eligibility in the store; a link it skips is left out, and the other reasons
 * are judged again from the link as claimed. The claim also skips a link kept handy since
 * selection. A claimed link left with no reason is left out but
 * stays marked. A response lost after the claim still uses up its links.
 */
export async function getDigest(
  deps: DigestDeps,
  owner: OwnerId,
): Promise<{ links: DigestLink[] }> {
  const now = deps.now();
  const { picked, focus } = await select(deps, owner, now, DIGEST_SIZE);
  const claimed = await claimSurfaced(
    { store: deps.store, now: () => now },
    owner,
    picked.map((l) => l.id),
    { exceptKeptTools: true },
  );
  const links = claimed
    .map(({ link, previousSurfacedAt }) => ({
      link,
      reasons: [...(focus.get(link.id) ?? []), ...ownReasons(link, previousSurfacedAt, now)],
    }))
    .filter((d) => d.reasons.length > 0);
  return { links };
}

/** A due kept tool for the digest's still-using check, with whole days since its last recorded opening (null: never opened). */
export type DueTool = { link: Link; daysSinceOpened: number | null };

/**
 * At most one kept tool that is due and eligible as digest links are (active, not snoozed at now,
 * surfaced at or before now - SURFACE_COOLDOWN_MS), the first in the digest's rotation. Reads
 * only; the caller claims it as it claims other picks.
 */
export async function dueTool(
  deps: Pick<DigestDeps, "store" | "tools" | "now">,
  owner: OwnerId,
): Promise<DueTool | null> {
  const now = deps.now();
  const notSurfacedAfter = new Date(now.getTime() - SURFACE_COOLDOWN_MS);
  const tools = await deps.tools.listTools(owner);
  const [link] = (await deps.store.listLinks(owner))
    .filter((l) => eligible(l, now, notSurfacedAfter) && isDue(l, tools.get(l.id) ?? null, now))
    .sort(rotation);
  return link ? dueToolOf(link, now) : null;
}

/**
 * Claims `dueTool`'s pick as the digest claims its other picks, then judges it again from the link
 * as claimed and its Keep handy row read after the claim. One no longer due is left out but stays
 * marked, as a digest pick left with no reason is.
 */
export async function claimDueTool(
  deps: Pick<DigestDeps, "store" | "tools" | "now">,
  owner: OwnerId,
): Promise<DueTool | null> {
  const now = deps.now();
  const picked = await dueTool({ ...deps, now: () => now }, owner);
  if (!picked) return null;
  const [claim] = await claimSurfaced({ store: deps.store, now: () => now }, owner, [
    picked.link.id,
  ]);
  if (!claim) return null;
  const tool = await deps.tools.getTool(owner, claim.link.id);
  return isDue(claim.link, tool, now) ? dueToolOf(claim.link, now) : null;
}

function dueToolOf(link: Link, now: Date): DueTool {
  const opened = link.lastOpenedAt;
  return {
    link,
    daysSinceOpened:
      opened === null ? null : Math.floor((now.getTime() - opened.getTime()) / DAY_MS),
  };
}
