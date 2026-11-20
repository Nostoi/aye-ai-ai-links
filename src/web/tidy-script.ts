import { ARCHIVE_UNDO, ARCHIVE_WORKING } from "./done-link.js";
import { STILL_WORKS_WORKING } from "./gone-line.js";
import { KEEP_IT_UNDO, KEEP_WORKING } from "./intent.js";
import { SKIP_UNDO, SKIP_WORKING } from "./skip.js";
import { COUNT_MANY, COUNT_ONE } from "./tidy-tray.js";

/**
 * What each choice posts, what its answer holds (`answer`: a state or intent `change`, a snooze's
 * `until`, or a link check's `check`), the bar and route of its Undo, and its working word.
 */
const ACTS = {
  keep: {
    route: "/home/keep",
    answer: "change",
    undo: { ...KEEP_IT_UNDO, route: "/home/undo-intent" },
    word: KEEP_WORKING,
  },
  skip: {
    route: "/home/snooze",
    answer: "until",
    undo: { ...SKIP_UNDO, route: "/home/unsnooze" },
    word: SKIP_WORKING,
  },
  archive: {
    route: "/home/archive",
    answer: "change",
    undo: { ...ARCHIVE_UNDO, route: "/home/undo-state" },
    word: ARCHIVE_WORKING,
  },
  works: {
    route: "/links/still-works",
    answer: "check",
    undo: { text: "Marked as working.", route: "/links/still-works/undo" },
    word: STILL_WORKS_WORKING,
  },
};

/**
 * The tray's script, a block inside Home's script after `CARD_FETCH` and the Undo bar's
 * `showUndo`. The tray has one `state`, `closed`, `open`, `done` or `gone`, and `render` alone
 * decides what is visible from it: the closed words, the first undecided link's step while open,
 * the finish screen while done, nothing once gone. Start opens at the first undecided link (the
 * finish screen when none is left), Stop here closes, Close ends the tray and moves focus to Your
 * spaces, else the search field.
 *
 * The tray is one card for `whileBusy`: a second click is dropped while a choice is out, and an
 * Undo waits for it (`whenFree`), then runs. A choice posts its route; only an answer that is OK
 * marks the link decided, and, while open, shows the next undecided link or the finish screen and
 * moves focus to its heading. An answer that comes after Stop here or Close still counts, and shows
 * nothing. Archive answers the `StateChange` that its Undo posts back to
 * `/home/undo-state` exactly as received, Keep the intent change its Undo posts to
 * `/home/undo-intent`, Skip its `until` to `/home/unsnooze`, and It still works its `check` and
 * `previous` to `/links/still-works/undo`; then the link is undecided again: an open tray shows it
 * (the finish screen too), a closed or ended one only returns to `closed`, never open. A refusal is
 * shown in `#tidy-error`.
 *
 * A key presses the shown step's button whose `aria-keyshortcuts` it is (1 to 3 on an explore step,
 * 1 and 2 on a gone one) only while open, and not in a field, with a
 * modifier, while a dialog is open, or when auto-repeating. A choice that is slow to answer dims
 * its link's step, not the whole tray, and its title says its working word (`busyLook`); a key finds
 * the choice's button from the step and the action.
 */
export const TIDY_SCRIPT = `{
const tidyRoot = document.getElementById("tidy");
const tidyAlert = document.getElementById("tidy-error");
const tidyActs = ${JSON.stringify(ACTS)};
const steps = [...tidyRoot.querySelectorAll(".tidy-step")];
const closed = tidyRoot.querySelector(".tidy-closed");
const finished = tidyRoot.querySelector(".tidy-done");
const count = tidyRoot.querySelector("[data-tidy-count]");
const decided = new Set();
let state = "closed";
const undecided = () => steps.find((s) => !decided.has(s)) || null;
const shownStep = () => (state === "open" ? undecided() : null);
const render = () => {
  const current = shownStep();
  tidyRoot.hidden = state === "gone";
  closed.hidden = state !== "closed";
  for (const s of steps) s.hidden = s !== current;
  finished.hidden = state !== "done";
  const left = steps.length - decided.size;
  count.textContent =
    left === 0 ? "" : left === 1 ? ${JSON.stringify(COUNT_ONE)} : ${JSON.stringify(COUNT_MANY)}.replace("{n}", left);
};
const focusOn = (el) => {
  el.setAttribute("tabindex", "-1");
  el.focus();
};
const go = (next) => {
  state = next === "open" && !undecided() ? "done" : next;
  render();
  if (state === "open") focusOn(undecided().querySelector(".tidy-title"));
  if (state === "done") focusOn(finished.querySelector("h3"));
};
const undoBodies = {
  change: (id, data) => (data.before && data.after ? { id, change: data } : null),
  until: (id, data) => (data.until ? { id, until: data.until, previous: data.previous ?? null } : null),
  check: (id, data) => (data.check ? { id, check: data.check, previous: data.previous } : null),
};
const choose = (step, act) =>
  whileBusy(tidyRoot, async (answered, ticket) => {
    const id = step.dataset.id;
    const { route, undo, answer } = tidyActs[act];
    tidyAlert.textContent = "";
    const res = await post(route, { id });
    answered();
    const data = res && res.status === 200 ? await res.json().catch(() => null) : null;
    const body = data && undoBodies[answer](id, data);
    if (!body) {
      tidyAlert.textContent = await failure(res);
      return;
    }
    decided.add(step);
    if (state === "open") go("open");
    else render();
    showUndo(ticket, undo.text, () =>
      whenFree(tidyRoot, async () => {
        tidyAlert.textContent = "";
        const back = await post(undo.route, body);
        if (!back || back.status !== 204) {
          tidyAlert.textContent = await failure(back);
          return;
        }
        decided.delete(step);
        go(state === "gone" ? "closed" : state === "done" ? "open" : state);
      }), undo.title);
  }, { el: step, button: step.querySelector('button[data-act="' + act + '"]'), word: tidyActs[act].word });
const close = () => {
  state = "gone";
  render();
  const spaces = document.getElementById("spaces");
  focusOn(spaces || document.getElementById("q"));
};
tidyRoot.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const step = button.closest(".tidy-step");
  if (button.dataset.act) choose(step, button.dataset.act);
  else if (button.dataset.tidy === "start") go("open");
  else if (button.dataset.tidy === "stop") {
    go("closed");
    closed.querySelector("button").focus();
  } else if (button.dataset.tidy === "close") close();
});
document.addEventListener("keydown", (event) => {
  const step = shownStep();
  const active = event.target;
  if (!step || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (document.querySelector("dialog[open], body[data-panel]")) return;
  if (active && (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) return;
  const button = [...step.querySelectorAll("button[data-act]")].find((b) => b.getAttribute("aria-keyshortcuts") === event.key);
  if (button) choose(step, button.dataset.act);
});
}`;
