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
  partialCounts: [],
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

  it("the current window is a filled pill: ink fill, page-colour text, same border", () => {
    const rule = /\.stat-windows a\[aria-current=page\]\{([^}]*)\}/.exec(themeCss)?.[1] ?? "";
    expect(rule).toContain("background:var(--ink)");
    expect(rule).toContain("color:var(--bg)");
    expect(rule).toContain("border-color:var(--ink)");
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

  it("the partial note shows only when partialCounts is not empty", () => {
    const html = profileStats(
      stats({ window: "90", partialCounts: ["opened", "setAside", "notNow"] }),
      NOW,
    );
    expect(html).toContain(
      "Counting began on October 22, so openings, set-asides and Not now before then are only partly counted.",
    );
    expect(profileStats(stats({ partialCounts: [] }), NOW)).not.toContain("partly");
  });

  it("the all-time note names only Not now", () => {
    const html = profileStats(stats({ window: "all", partialCounts: ["notNow"] }), NOW);
    expect(html).toContain("so Not now before then is only partly counted.");
    expect(html).not.toContain("openings");
  });

  it("the reading shows as a guess with who and when", () => {
    const html = profileStats(stats(), NOW, {
      text: "You save <b>more</b> than you open.",
      writtenBy: "Claude <3",
      writtenAt: new Date("2026-10-20T08:00:00Z"),
      inputHash: "h",
    });
    expect(html).toContain("<h3>What this might say about you</h3>");
    expect(html).toContain("You save &lt;b&gt;more&lt;/b&gt; than you open.");
    expect(html).toContain('<small class="small">A guess by Claude &lt;3, October 20</small>');
    expect(html.indexOf("What this might say about you")).toBeGreaterThan(
      html.indexOf("Openings from bookmarks"),
    );
    expect(html).not.toContain("style=");
  });

  it("no reading, no heading", () => {
    for (const html of [profileStats(stats(), NOW), profileStats(stats(), NOW, null)]) {
      expect(html).not.toContain("What this might say about you");
      expect(html).not.toContain("A guess by");
      expect(html).not.toContain("stat-reading");
    }
  });
});
