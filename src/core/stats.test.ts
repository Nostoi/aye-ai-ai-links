import { describe, expect, it } from "vitest";
import { computeStats, parseWindow, type StatsFacts } from "./stats.js";
import type { StatsEvent } from "./stats-store.js";
import type { Link, LinkEventKind, LinkTag } from "./types.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-23T12:00:00Z");
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

function link(id: string, over: Partial<Link> = {}): Link {
  return {
    id,
    url: `https://example.com/${id}`,
    urlKey: `example.com/${id}`,
    title: id,
    summary: null,
    summarySource: null,
    why: null,
    tags: [],
    savedAt: ago(5),
    savedBy: "test",
    lastOpenedAt: null,
    lastSurfacedAt: null,
    snoozedUntil: null,
    putAwayAt: null,
    tidyKeptAt: null,
    state: "active",
    snapshot: null,
    ...over,
  };
}

const ev = (linkId: string, kind: LinkEventKind, at: Date): StatsEvent => ({ linkId, kind, at });
const tag = (name: string, kind: LinkTag["kind"] = "topic"): LinkTag => ({
  key: name.toLowerCase(),
  name,
  source: "stated",
  kind,
  kindSource: "stated",
});

function facts(over: Partial<StatsFacts> = {}): StatsFacts {
  return { links: [], declined: new Set(), events: [], trackingSince: ago(400), ...over };
}

describe("parseWindow", () => {
  it("falls back to all", () => {
    expect(parseWindow(undefined)).toBe("all");
    expect(parseWindow("7")).toBe("all");
    expect(parseWindow("")).toBe("all");
  });
  it("takes 30 as a number", () => {
    expect(parseWindow(30)).toBe("30");
    expect(parseWindow("90")).toBe("90");
    expect(parseWindow(365)).toBe("365");
    expect(parseWindow("all")).toBe("all");
  });
});

describe("computeStats", () => {
  it("saved counts links saved in the window", () => {
    const f = facts({
      links: [
        link("in", { savedAt: ago(10) }),
        link("edge", { savedAt: ago(30) }),
        link("out", { savedAt: new Date(ago(30).getTime() - 1) }),
      ],
    });
    expect(computeStats(f, "30", NOW).saved).toBe(2);
    expect(computeStats(f, "all", NOW).saved).toBe(3);
  });

  it("opened counts distinct links with an opened event in the window", () => {
    const f = facts({
      links: [link("a"), link("b"), link("c")],
      events: [
        ev("a", "opened", ago(3)),
        ev("a", "opened", ago(2)),
        ev("b", "opened", ago(40)),
        ev("c", "put_away", ago(1)),
      ],
    });
    expect(computeStats(f, "30", NOW).opened).toBe(1);
    expect(computeStats(f, "90", NOW).opened).toBe(2);
  });

  it("all-time opened also counts a last_opened_at with no event", () => {
    const f = facts({
      links: [link("a", { lastOpenedAt: ago(100) }), link("b"), link("c")],
      events: [ev("c", "opened", ago(200))],
    });
    expect(computeStats(f, "all", NOW).opened).toBe(2);
    expect(computeStats(f, "365", NOW).opened).toBe(1);
  });

  it("not opened yet leaves out set-aside and declined links", () => {
    const f = facts({
      links: [
        link("fresh"),
        link("archived", { state: "archived" }),
        link("declined"),
        link("opened-by-time", { lastOpenedAt: ago(2) }),
        link("opened-by-event"),
        link("old", { savedAt: ago(60) }),
      ],
      declined: new Set(["declined"]),
      events: [ev("opened-by-event", "opened", ago(1))],
    });
    expect(computeStats(f, "30", NOW).notOpenedYet).toBe(1);
    expect(computeStats(f, "all", NOW).notOpenedYet).toBe(2);
  });

  it("set aside uses the latest set-aside event", () => {
    const f = facts({
      links: [
        link("recent", { state: "archived" }),
        link("old", { state: "archived" }),
        link("declined"),
      ],
      declined: new Set(["declined"]),
      events: [
        ev("recent", "put_away", ago(5)),
        ev("old", "put_away", ago(50)),
        ev("declined", "not_handy", ago(10)),
      ],
    });
    expect(computeStats(f, "30", NOW).setAside).toBe(2);
    expect(computeStats(f, "90", NOW).setAside).toBe(3);
  });

  it("a stale link with no event counts only in all time", () => {
    const f = facts({ links: [link("stale", { state: "archived" })] });
    expect(computeStats(f, "365", NOW).setAside).toBe(0);
    expect(computeStats(f, "all", NOW).setAside).toBe(1);
  });

  it("a link brought back is not set aside", () => {
    const f = facts({ links: [link("back")], events: [ev("back", "put_away", ago(5))] });
    expect(computeStats(f, "30", NOW).setAside).toBe(0);
    expect(computeStats(f, "all", NOW).setAside).toBe(0);
  });

  it("a link put away 20 days ago, brought back, and marked stale 40 days ago counts in the 30-day window by its latest event only", () => {
    // Set aside and brought back long ago (put_away 40 days ago), then went stale 20 days ago.
    // Its first set-aside event is outside the 30-day window, its latest inside: it counts.
    // The log lists events oldest first, so a rule that takes the first set-aside event fails.
    const f = facts({
      links: [link("x", { state: "archived" })],
      events: [ev("x", "put_away", ago(40)), ev("x", "stale", ago(20))],
    });
    expect(computeStats(f, "30", NOW).setAside).toBe(1);
    // Reverse: latest set-aside event outside the window decides, even though the link is archived.
    const g = facts({
      links: [link("y", { state: "archived" })],
      events: [ev("y", "stale", ago(60)), ev("y", "put_away", ago(40))],
    });
    expect(computeStats(g, "30", NOW).setAside).toBe(0);
  });

  it("not now is its own count", () => {
    const f = facts({
      links: [link("a"), link("b")],
      events: [ev("a", "not_now", ago(2)), ev("a", "not_now", ago(1)), ev("b", "not_now", ago(60))],
    });
    const s = computeStats(f, "30", NOW);
    expect(s.notNow).toBe(1);
    expect(s.setAside).toBe(0);
    expect(computeStats(f, "all", NOW).notNow).toBe(2);
  });

  it("tag rows count saved in the window and ever opened", () => {
    const f = facts({
      links: [
        link("a", { tags: [tag("Go"), tag("Home", "project")], savedAt: ago(3) }),
        link("b", { tags: [tag("Go")], savedAt: ago(4), lastOpenedAt: ago(1) }),
        link("c", { tags: [tag("Go")], savedAt: ago(90) }),
        link("d", { tags: [tag("Art")], savedAt: ago(2) }),
      ],
      events: [ev("a", "opened", ago(100))],
    });
    expect(computeStats(f, "30", NOW).tags).toEqual([
      { name: "Go", kind: "topic", saved: 2, opened: 2 },
      { name: "Art", kind: "topic", saved: 1, opened: 0 },
      { name: "Home", kind: "project", saved: 1, opened: 1 },
    ]);
  });

  it("partial is true when the window starts before tracking", () => {
    const f = facts({ trackingSince: ago(50) });
    expect(computeStats(f, "30", NOW).partial).toBe(false);
    expect(computeStats(f, "90", NOW).partial).toBe(true);
    expect(computeStats(f, "all", NOW).partial).toBe(true);
    expect(computeStats(f, "90", NOW).trackingSince).toEqual(ago(50));
  });

  it("an empty library gives zeros and no tags", () => {
    const s = computeStats(facts(), "all", NOW);
    expect(s).toMatchObject({
      window: "all",
      saved: 0,
      opened: 0,
      notOpenedYet: 0,
      setAside: 0,
      notNow: 0,
      tags: [],
    });
  });
});
