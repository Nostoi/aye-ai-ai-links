import { isGone } from "./link-check.js";
import type { LinkCheckStore } from "./link-check-store.js";
import { recentFocus } from "./profile.js";
import type { ProfileStore } from "./profile-store.js";
import type { FocusMatch } from "./search.js";
import type { LinkStore } from "./store.js";
import type { ToolStore } from "./tool-store.js";
import { isDue } from "./tools.js";
import type { FocusEntry, Link, OwnerId } from "./types.js";

// Uncalibrated defaults (ROADMAP #34); the owner may change them.
const DAY_MS = 86_400_000;
/** Links in one digest, at most. */
export const DIGEST_SIZE = 5;
/** Of the recent focus entries, only those created within this long count. */
export const FOCUS_WINDOW_MS = 30 * DAY_MS;
/** not_opened_recently: saved at least this long ago, and no opening recorded within it. */
export const NOT_OPENED_MS = 30 * DAY_MS;
/** At most this many of a digest's links are picked for a focus match; the rest follow by age. */
export const FOCUS_SLOTS = 3;

/**
 * Why a link is in the digest. `focus_words`: the link's own title, summary, why or tags share
 * `words` with that focus entry, which is a keyword match, not proof of relevance. `words` are
 * the entry's words that matched, rarest first and never empty, as they were when the digest or
 * page was built: an edit can make them stale until it is reloaded. `still_using_check`: a kept
 * tool that is due, asked about alone, with whole days since its last recorded opening (null:
 * none recorded).
 */
export type DigestReason =
  | { kind: "focus_words"; focus: FocusEntry; words: string[] }
  | { kind: "no_why" }
  | { kind: "not_opened_recently" }
  | { kind: "still_using_check"; daysSinceOpened: number | null };

export type DigestLink = { link: Link; reasons: DigestReason[] };

export type DigestDeps = {
  store: LinkStore;
  /** Keep handy rows: a kept tool is not reading, so it gets no reason. */
  tools: ToolStore;
  /** Dead-link checks: a gone link is not reading, so it gets no reason (#128). */
  checks: LinkCheckStore;
  profile: ProfileStore;
  /** Keyword matching only: with no similarity floor yet (#68), any link can come back as a meaning match. */
  focusMatch: FocusMatch;
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

const isActive = (link: Link, now: Date) =>
  link.state === "active" && (link.snoozedUntil === null || link.snoozedUntil <= now);

/** Oldest saved first, then lowest id: the one order Explore and the digest share. */
const oldestFirst = (a: Link, b: Link) =>
  a.savedAt.getTime() - b.savedAt.getTime() || compareIds(a.id, b.id);

/** Every reason but focus. */
function ownReasons(link: Link, now: Date): DigestReason[] {
  const reasons: DigestReason[] = [];
  if (link.why === null) reasons.push({ kind: "no_why" });
  const longAgo = now.getTime() - NOT_OPENED_MS;
  if (
    link.savedAt.getTime() <= longAgo &&
    (link.lastOpenedAt === null || link.lastOpenedAt.getTime() <= longAgo)
  ) {
    reasons.push({ kind: "not_opened_recently" });
  }
  return reasons;
}

/**
 * Focus reasons by link id, one per current entry whose words match the link. Membership only: the
 * keyword engine's rank never decides a card. Each match is the engine's whole answer, untraced, so
 * not logged.
 */
async function focusReasons(
  deps: DigestDeps,
  owner: OwnerId,
  entries: FocusEntry[],
  isCandidate: (id: string) => boolean,
): Promise<Map<string, DigestReason[]>> {
  const found = new Map<string, DigestReason[]>();
  for (const focus of entries) {
    const hits = await deps.focusMatch.match(owner, focus.text, {});
    for (const { id, words } of hits.filter((h) => isCandidate(h.id))) {
      found.set(id, [...(found.get(id) ?? []), { kind: "focus_words", focus, words }]);
    }
  }
  return found;
}

/** The focus entries inside FOCUS_WINDOW_MS, newest first, as `recentFocus` returns them. */
async function focusEntries(deps: DigestDeps, owner: OwnerId, now: Date): Promise<FocusEntry[]> {
  const since = now.getTime() - FOCUS_WINDOW_MS;
  return (await recentFocus(deps, owner)).filter((f) => f.createdAt.getTime() >= since);
}

/**
 * Up to `limit` links in the one order Explore and the digest share, with each one's focus reasons.
 * Reads only, and keeps no state: the same links come back until the owner decides one. A candidate
 * is active, To explore (a To keep link is never picked, #339), not a kept tool, not gone (#128),
 * not snoozed at now and not in `exclude`. Up to `focusSlots` focus matches come first, oldest
 * saved first; the rest follow in that order too.
 */
async function select(
  deps: DigestDeps,
  owner: OwnerId,
  now: Date,
  limit: number,
  exclude: ReadonlySet<string>,
  focusSlots: number,
): Promise<{ picked: Link[]; focus: Map<string, DigestReason[]> }> {
  const tools = await deps.tools.listTools(owner);
  const checks = await deps.checks.listChecks(owner);
  const candidates = new Map(
    (await deps.store.listLinks(owner))
      .filter(
        (l) =>
          !isGone(checks.get(l.id) ?? null) &&
          !exclude.has(l.id) &&
          l.intent === "explore" &&
          tools.get(l.id)?.status !== "kept" &&
          isActive(l, now),
      )
      .map((l) => [l.id, l]),
  );
  if (candidates.size === 0) return { picked: [], focus: new Map() };

  const focus = await focusReasons(deps, owner, await focusEntries(deps, owner, now), (id) =>
    candidates.has(id),
  );
  const ordered = [...candidates.values()].sort(oldestFirst);
  const lead = ordered.filter((l) => focus.has(l.id)).slice(0, focusSlots);
  const rest = ordered.filter((l) => !lead.includes(l));
  return { picked: [...lead, ...rest].slice(0, limit), focus };
}

/**
 * Reading picks, writing nothing: up to `limit` links (DIGEST_SIZE by default), in the order Explore
 * uses, with every reason that applies. A link can have none: a new To explore link that has a why.
 * Up to `focusSlots` of them lead for a focus match (FOCUS_SLOTS by default). It never holds the
 * still-using check, which `getDigest` adds.
 */
export async function previewDigest(
  deps: DigestDeps,
  owner: OwnerId,
  limit = DIGEST_SIZE,
  exclude: ReadonlySet<string> = new Set(),
  focusSlots = FOCUS_SLOTS,
): Promise<{ links: DigestLink[] }> {
  const now = deps.now();
  const { picked, focus } = await select(deps, owner, now, limit, exclude, focusSlots);
  const links = picked.map((link) => ({
    link,
    reasons: [...(focus.get(link.id) ?? []), ...ownReasons(link, now)],
  }));
  return { links };
}

/**
 * The digest: up to DIGEST_SIZE links as `previewDigest` picks them, with a due kept tool taking one
 * of the slots and coming last as a `still_using_check`; at most one per digest. It writes nothing,
 * so a repeat call returns the same links until the owner decides them.
 */
export async function getDigest(
  deps: DigestDeps,
  owner: OwnerId,
): Promise<{ links: DigestLink[] }> {
  const now = deps.now();
  const check = await dueTool({ ...deps, now: () => now }, owner);
  const { links } = await previewDigest(
    { ...deps, now: () => now },
    owner,
    DIGEST_SIZE - (check ? 1 : 0),
  );
  if (check) {
    links.push({
      link: check.link,
      reasons: [{ kind: "still_using_check", daysSinceOpened: check.daysSinceOpened }],
    });
  }
  return { links };
}

/** A due kept tool for the digest's still-using check, with whole days since its last recorded opening (null: never opened). */
export type DueTool = { link: Link; daysSinceOpened: number | null };

/**
 * At most one kept tool that is due, active and not snoozed at now, the oldest saved first. A gone
 * tool is never due (#128). Reads only.
 */
export async function dueTool(
  deps: Pick<DigestDeps, "store" | "tools" | "checks" | "now">,
  owner: OwnerId,
): Promise<DueTool | null> {
  const now = deps.now();
  const tools = await deps.tools.listTools(owner);
  const checks = await deps.checks.listChecks(owner);
  const [link] = (await deps.store.listLinks(owner))
    .filter(
      (l) => isActive(l, now) && isDue(l, tools.get(l.id) ?? null, checks.get(l.id) ?? null, now),
    )
    .sort(oldestFirst);
  return link ? dueToolOf(link, now) : null;
}

function dueToolOf(link: Link, now: Date): DueTool {
  const opened = link.lastOpenedAt;
  return {
    link,
    daysSinceOpened:
      opened === null ? null : Math.floor((now.getTime() - opened.getTime()) / DAY_MS),
  };
}
