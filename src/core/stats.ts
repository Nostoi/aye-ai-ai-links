import type { StatsReading, StatsReadingStore } from "./stats-reading-store.js";
import type { StatsEvent, StatsStore } from "./stats-store.js";
import type { LinkStore } from "./store.js";
import type { ToolStore } from "./tool-store.js";
import type { Link, OwnerId, TagKind } from "./types.js";

export const STATS_WINDOWS = ["30", "90", "365", "all"] as const;
export type StatsWindow = (typeof STATS_WINDOWS)[number];
/** How many tag rows the page shows; core and `get_stats` return them all. */
export const STATS_TAG_ROWS = 8;

const DAY_MS = 86_400_000;
const SET_ASIDE_KINDS: ReadonlySet<StatsEvent["kind"]> = new Set([
  "put_away",
  "stale",
  "not_handy",
]);

/** 30 and "30" both work; anything unknown is all time. */
export function parseWindow(raw: string | number | undefined): StatsWindow {
  const text = String(raw);
  return STATS_WINDOWS.find((w) => w === text) ?? "all";
}

export type TagStat = { name: string; kind: TagKind; saved: number; opened: number };

export type PartialCount = "opened" | "setAside" | "notNow";

export type Stats = {
  window: StatsWindow;
  saved: number;
  opened: number;
  notOpenedYet: number;
  setAside: number;
  notNow: number;
  /** Every tag, most saved first, ties by name. */
  tags: TagStat[];
  trackingSince: Date;
  /** The counts that may be too low because the window starts before tracking began. */
  partialCounts: PartialCount[];
};

export type StatsFacts = {
  links: Link[];
  /** Ids of links whose Keep handy row is declined. */
  declined: Set<string>;
  events: StatsEvent[];
  trackingSince: Date;
};

/** The counting rules of docs/specs/2026-10-22-stats-design.md, "The counts". */
export function computeStats(facts: StatsFacts, window: StatsWindow, now: Date): Stats {
  const { links, declined, events, trackingSince } = facts;
  const start = window === "all" ? null : new Date(now.getTime() - Number(window) * DAY_MS);
  const inWindow = (at: Date): boolean => start === null || at >= start;

  const eventLinks = (kind: StatsEvent["kind"], onlyInWindow: boolean): Set<string> =>
    new Set(
      events
        .filter((e) => e.kind === kind && (!onlyInWindow || inWindow(e.at)))
        .map((e) => e.linkId),
    );

  const openedEver = eventLinks("opened", false);
  for (const l of links) if (l.lastOpenedAt) openedEver.add(l.id);
  const openedInWindow = eventLinks("opened", true);
  const opened = start === null ? openedEver.size : openedInWindow.size;

  const latestSetAside = new Map<string, Date>();
  for (const e of events) {
    if (!SET_ASIDE_KINDS.has(e.kind)) continue;
    const seen = latestSetAside.get(e.linkId);
    if (!seen || e.at > seen) latestSetAside.set(e.linkId, e.at);
  }

  const savedInWindow = links.filter((l) => inWindow(l.savedAt));
  const isSetAside = (l: Link): boolean => l.state === "archived" || declined.has(l.id);
  const setAside = links.filter((l) => {
    if (!isSetAside(l)) return false;
    if (start === null) return true;
    const latest = latestSetAside.get(l.id);
    return latest !== undefined && latest >= start;
  }).length;

  const notOpenedYet = savedInWindow.filter(
    (l) => l.state === "active" && !declined.has(l.id) && !openedEver.has(l.id),
  ).length;

  const tagRows = new Map<string, TagStat>();
  for (const l of savedInWindow) {
    for (const t of l.tags) {
      const row = tagRows.get(t.name) ?? { name: t.name, kind: t.kind, saved: 0, opened: 0 };
      row.saved += 1;
      if (openedEver.has(l.id)) row.opened += 1;
      tagRows.set(t.name, row);
    }
  }
  const tags = [...tagRows.values()].sort(
    (a, b) => b.saved - a.saved || a.name.localeCompare(b.name),
  );

  return {
    window,
    saved: savedInWindow.length,
    opened,
    notOpenedYet,
    setAside,
    notNow: eventLinks("not_now", true).size,
    tags,
    trackingSince,
    partialCounts:
      start === null ? ["notNow"] : start < trackingSince ? ["opened", "setAside", "notNow"] : [],
  };
}

export async function getStats(
  deps: { store: LinkStore; tools: ToolStore; stats: StatsStore; now: () => Date },
  owner: OwnerId,
  window: StatsWindow,
): Promise<Stats> {
  const [links, tools, events, trackingSince] = await Promise.all([
    deps.store.listLinks(owner),
    deps.tools.listTools(owner),
    deps.stats.statsEvents(owner),
    deps.stats.trackingSince(),
  ]);
  const declined = new Set([...tools].filter(([, t]) => t.status === "declined").map(([id]) => id));
  return computeStats({ links, declined, events, trackingSince }, window, deps.now());
}

/**
 * The reading to show, or null. The one visibility rule: without an AI connection (`readingOn`
 * false) a stored reading is never shown, to the page, an agent or Ask AI.
 */
export async function statsReading(
  deps: { readings: StatsReadingStore; readingOn?: boolean | undefined },
  owner: OwnerId,
): Promise<StatsReading | null> {
  return deps.readingOn ? deps.readings.getReading(owner) : null;
}
