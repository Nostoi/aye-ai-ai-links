import { describe, expect, it } from "vitest";
import type { ToolRecord } from "./tool-store.js";
import { clockStart, currentWaitDays, isDue } from "./tools.js";
import type { Link } from "./types.js";

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T00:00:00Z");
const day = (d: number) => new Date(T0.getTime() + d * DAY);

const linkWith = (over: Partial<Link> = {}): Link => ({
  id: "1",
  url: "https://ex.com/1",
  urlKey: "ex.com/1",
  title: null,
  summary: null,
  why: null,
  tags: [],
  savedAt: day(-100),
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});

const tool = (over: Partial<ToolRecord> = {}): ToolRecord => ({
  status: "kept",
  source: "stated",
  since: day(0),
  answeredAt: null,
  waitDays: 30,
  ...over,
});

describe("clockStart", () => {
  it("is the latest of the last opening, the last answer and since", () => {
    expect(clockStart(linkWith(), tool())).toEqual(day(0));
    expect(clockStart(linkWith({ lastOpenedAt: day(5) }), tool({ answeredAt: day(3) }))).toEqual(
      day(5),
    );
    expect(clockStart(linkWith({ lastOpenedAt: day(2) }), tool({ answeredAt: day(3) }))).toEqual(
      day(3),
    );
    expect(clockStart(linkWith({ lastOpenedAt: day(-9) }), tool())).toEqual(day(0));
  });
});

describe("isDue", () => {
  it("is due at 30 days and not at 29, nor a millisecond before 30", () => {
    const l = linkWith();
    expect(isDue(l, tool(), day(29))).toBe(false);
    expect(isDue(l, tool(), new Date(day(30).getTime() - 1))).toBe(false);
    expect(isDue(l, tool(), day(30))).toBe(true);
  });

  it("uses the stored wait from the last answer when nothing was opened since", () => {
    const t = tool({ answeredAt: day(30), waitDays: 60 });
    expect(isDue(linkWith({ lastOpenedAt: day(10) }), t, day(89))).toBe(false);
    expect(isDue(linkWith({ lastOpenedAt: day(10) }), t, day(90))).toBe(true);
  });

  it("an opening since the last check brings the wait back to 30 days from that opening", () => {
    const t = tool({ answeredAt: day(90), waitDays: 120 });
    const opened = linkWith({ lastOpenedAt: day(100) });
    expect(currentWaitDays(opened, t)).toBe(30);
    expect(isDue(opened, t, day(129))).toBe(false);
    expect(isDue(opened, t, day(130))).toBe(true);
  });

  it("an opening in the same millisecond as the last answer counts as since", () => {
    const t = tool({ answeredAt: day(30), waitDays: 60 });
    const opened = linkWith({ lastOpenedAt: day(30) });
    expect(currentWaitDays(opened, t)).toBe(30);
    expect(isDue(opened, t, day(60))).toBe(true);
  });

  it("an opening in the same millisecond as a fresh keep leaves the first wait of 30", () => {
    const opened = linkWith({ lastOpenedAt: day(0) });
    expect(currentWaitDays(opened, tool())).toBe(30);
    expect(isDue(opened, tool(), day(29))).toBe(false);
    expect(isDue(opened, tool(), day(30))).toBe(true);
  });

  it("an opening before the last check leaves the stored wait", () => {
    const t = tool({ answeredAt: day(90), waitDays: 120 });
    const opened = linkWith({ lastOpenedAt: day(80) });
    expect(currentWaitDays(opened, t)).toBe(120);
    expect(isDue(opened, t, day(209))).toBe(false);
    expect(isDue(opened, t, day(210))).toBe(true);
  });

  it("is never due for an archived link, a suggestion, a declined link or a link with no row", () => {
    const late = day(1000);
    expect(isDue(linkWith({ state: "archived" }), tool(), late)).toBe(false);
    expect(isDue(linkWith(), tool({ status: "suggested", source: "inferred" }), late)).toBe(false);
    expect(isDue(linkWith(), tool({ status: "declined" }), late)).toBe(false);
    expect(isDue(linkWith(), null, late)).toBe(false);
  });
});
