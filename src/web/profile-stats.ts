import {
  type PartialCount,
  STATS_TAG_ROWS,
  type Stats,
  type StatsWindow,
  type TagStat,
} from "../core/stats.js";
import { escapeHtml, savedOn } from "./page.js";

const WINDOW_LABELS: [StatsWindow, string][] = [
  ["30", "Last month"],
  ["90", "3 months"],
  ["365", "Year"],
  ["all", "All time"],
];

const windowLink = ([window, label]: [StatsWindow, string], current: StatsWindow) =>
  `<a href="?window=${window}"${window === current ? ' aria-current="page"' : ""}>${label}</a>`;

const card = (label: string, count: number, subline = "") =>
  `<div class="stat-card"><p class="stat-count">${count}</p><p class="stat-label">${label}</p>${subline ? `<p class="small">${subline}</p>` : ""}</div>`;

/** Bar widths are `pct-N` classes (theme.ts), so the section needs no inline style. */
function tagRow(t: TagStat, largest: number): string {
  const openedPct = Math.round((t.opened / largest) * 100);
  const savedPct = Math.round((t.saved / largest) * 100);
  return `<li class="stat-tag"><span class="stat-name">${escapeHtml(t.name)}</span><span class="stat-bar" aria-hidden="true"><span class="stat-opened pct-${openedPct}"></span><span class="stat-unopened pct-${savedPct - openedPct}"></span></span><span class="stat-counts small">${t.saved} saved · ${t.opened} opened</span></li>`;
}

const PARTIAL_LABELS: Record<PartialCount, string> = {
  opened: "openings",
  setAside: "set-asides",
  notNow: "Not now",
};

function partialNote(stats: Stats, now: Date): string {
  const names = stats.partialCounts.map((c) => PARTIAL_LABELS[c]);
  if (names.length === 0) return "";
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const verb = names.length === 1 ? "is" : "are";
  return `<p class="small">Counting began on ${savedOn(stats.trackingSince, now)}, so ${list} before then ${verb} only partly counted.</p>`;
}

function tagBlock(tags: TagStat[]): string {
  if (tags.length === 0) return "";
  const largest = Math.max(...tags.map((t) => t.saved));
  const more = tags.length - STATS_TAG_ROWS;
  return `<h3>By project and topic</h3>
<ul class="stat-tags">
${tags
  .slice(0, STATS_TAG_ROWS)
  .map((t) => tagRow(t, largest))
  .join("\n")}
</ul>${more > 0 ? `\n<p class="small">and ${more} more</p>` : ""}`;
}

/** The profile's "Your library" section: counts for one window, then the tag rows. */
export function profileStats(stats: Stats, now: Date): string {
  return `<section class="profile-stats" aria-labelledby="stats-heading">
<h2 id="stats-heading">Your library</h2>
<nav class="stat-windows" aria-label="Time window">${WINDOW_LABELS.map((w) => windowLink(w, stats.window)).join("")}</nav>
<div class="stat-grid">
${card("Saved", stats.saved)}
${card("Opened", stats.opened)}
${card("Not opened yet", stats.notOpenedYet)}
${card("Set aside", stats.setAside, "done, stale, put away or not handy")}
</div>
${stats.notNow > 0 ? `<p>Put off with Not now: ${stats.notNow}</p>` : ""}
${partialNote(stats, now)}
<p class="small">Openings from bookmarks or outside the app aren't counted.</p>
${tagBlock(stats.tags)}
</section>`;
}
