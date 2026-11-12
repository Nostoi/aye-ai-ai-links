import type { MenuItem } from "./card-menu.js";

const CLOCK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M12 7.5V12l3 2"/></svg>`;

/** The small line under Not now, in the menu and on Home's featured card (owner, 2026-11-12). */
export const NOT_NOW_HINT = "Not suggested for two weeks";

/** Home's menu row that puts a link off for two weeks; Home's script posts it (#195). */
export const NOT_NOW_ITEM: MenuItem = {
  act: "snooze",
  icon: CLOCK,
  text: "Not now",
  hint: NOT_NOW_HINT,
};
