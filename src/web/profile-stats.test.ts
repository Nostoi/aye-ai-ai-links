import { describe, expect, it } from "vitest";
import { STATS_TAG_ROWS, type Stats, type TagStat } from "../core/stats.js";
import { profileStats } from "./profile-stats.js";
import { themeCss } from "./theme.js";

const NOW = new Date("2026-10-23T12:00:00Z");

const stats = (over: Partial<Stats> = {}): Stats => ({
  window: "30",
  saved: 12,
  opened: 5,
  notOpenedYet: 4,
  setAside: 3,
  notNow: 0,
  tags: [],
  trackingSince: new Date("2026-10-22T09:00:00Z"),
  partial: false,
  ...over,
});

const tag = (name: string, saved: number, opened = 0): TagStat => ({
  name,
  kind: "topic",
  saved,
  opened,
});

const card = (html: string, label: string) =>
  html.match(
    new RegExp(`<div class="stat-card">(?:(?!</div>).)*${label}(?:(?!</div>).)*</div>`, "s"),
  )?.[0] ?? "";

const row = (html: string, name: string) =>
  html.match(
    new RegExp(`<li class="stat-tag">(?:(?!</li>).)*${name}(?:(?!</li>).)*</li>`, "s"),
  )?.[0] ?? "";

const WINDOWS = [
  ["30", "Last month"],
  ["90", "3 months"],
  ["365", "Year"],
  ["all", "All time"],
] as const;

describe("the profile stats section", () => {
  it("the stats section shows the four counts", () => {
    const html = profileStats(stats(), NOW);
    expect(html).toContain("<h2");
    expect(html).toContain("Your library");
    expect(card(html, "Saved")).toContain(">12<");
    expect(card(html, "Opened")).toContain(">5<");
    expect(card(html, "Not opened yet")).toContain(">4<");
    const aside = card(html, "Set aside");
    expect(aside).toContain(">3<");
    expect(aside).toContain("done, stale, put away or not handy");
    expect(html).toContain("Openings from bookmarks or outside the app aren't counted.");
  });

  it("shows Put off with Not now only when something was", () => {
    expect(profileStats(stats({ notNow: 0 }), NOW)).not.toContain("Put off with Not now");
    expect(profileStats(stats({ notNow: 2 }), NOW)).toContain("Put off with Not now: 2");
  });

  it("the current window is marked", () => {
    for (const [window, label] of WINDOWS) {
      const html = profileStats(stats({ window }), NOW);
      const current = [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]*)<\/a>/g)];
      expect(current.map((m) => m[1])).toEqual([label]);
    }
  });

  it("the window links are plain links that work without script", () => {
    const html = profileStats(stats(), NOW);
    for (const [href, label] of WINDOWS) {
      expect(html).toMatch(new RegExp(`<a [^>]*href="\\?window=${href}"[^>]*>${label}</a>`));
    }
    expect(html).toContain("<nav");
    expect(html).not.toContain("<script");
  });

  it("the window links are at least 44px tall", () => {
    expect(themeCss).toMatch(/\.stat-windows a\{[^}]*min-height:44px/);
  });

  it("only eight tags show, then and N more", () => {
    const tags = Array.from({ length: STATS_TAG_ROWS + 3 }, (_, i) => tag(`topic${i}`, 20 - i));
    const html = profileStats(stats({ tags }), NOW);
    expect(html).toContain("By project and topic");
    expect((html.match(/class="stat-tag"/g) ?? []).length).toBe(STATS_TAG_ROWS);
    expect(html).toContain("topic7");
    expect(html).not.toContain("topic8");
    expect(html).toContain("and 3 more");
    const exact = profileStats(stats({ tags: tags.slice(0, STATS_TAG_ROWS) }), NOW);
    expect(exact).not.toContain(" more<");
  });

  it("shows each tag's counts and a two-tone bar sized against the largest", () => {
    const html = profileStats(stats({ tags: [tag("Big", 10, 5), tag("Small", 5, 5)] }), NOW);
    expect(html).toContain("10 saved · 5 opened");
    expect(html).toContain("5 saved · 5 opened");
    expect(row(html, "Big")).toMatch(/stat-opened pct-50/);
    expect(row(html, "Big")).toMatch(/stat-unopened pct-50/);
    expect(row(html, "Small")).toMatch(/stat-opened pct-50/);
    expect(row(html, "Small")).toMatch(/stat-unopened pct-0/);
    expect(html).not.toContain("style=");
  });

  it("escapes a tag name", () => {
    const html = profileStats(stats({ tags: [tag("<img src=x>", 1)] }), NOW);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it("no tags heading for an empty library", () => {
    expect(profileStats(stats({ tags: [] }), NOW)).not.toContain("By project and topic");
  });

  it("the partial note shows only when partial", () => {
    const partial = profileStats(stats({ partial: true }), NOW);
    expect(partial).toContain("only partly counted");
    expect(partial).toContain("October 22");
    expect(profileStats(stats({ partial: false }), NOW)).not.toContain("partly");
  });

  it("the all-time note names only Not now", () => {
    const html = profileStats(stats({ window: "all", partial: true }), NOW);
    expect(html).toContain("Not now is counted from October 22");
    expect(html).not.toContain("partly");
    expect(html).not.toContain("Openings and set-asides");
  });
});
