import type { Stats } from "../core/stats.js";

/** A library with nothing in it, for page tests that only need `profilePage` to render. */
export const emptyStats: Stats = {
  window: "all",
  saved: 0,
  opened: 0,
  notOpenedYet: 0,
  setAside: 0,
  notNow: 0,
  tags: [],
  trackingSince: new Date("2026-10-01T00:00:00Z"),
  partialCounts: ["notNow"],
};
