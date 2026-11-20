import type { MenuItem } from "./card-menu.js";

/** Two chevrons: skip ahead (#340). */
export const SKIP_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l6 6-6 6"/><path d="M13 6l6 6-6 6"/></svg>`;

/** The small line under Skip, and its Undo bar. */
export const SKIP_HINT = "Back in two weeks";

/** Skip's line in a Tidy up step. */
export const SKIP_TIDY_LINE = "Back in two weeks.";

/** What Skip says while it waits for the answer (#314). */
export const SKIP_WORKING = "Skipping…";

/** The Undo bar Skip shows: a title, then `SKIP_HINT`. */
export const SKIP_UNDO = { title: "Skipped.", text: `${SKIP_HINT}.` };

/** Home's menu row that skips a link for two weeks; Home's script posts it (#195). */
export const SKIP_ITEM: MenuItem = {
  act: "snooze",
  icon: SKIP_ICON,
  text: "Skip",
  hint: SKIP_HINT,
};
