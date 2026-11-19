import { DONE_UNDO, DONE_WORKING, PUT_AWAY_UNDO, PUT_AWAY_WORKING } from "./done-link.js";

/** What Keep says while it waits for the answer (#314). */
const KEEP_WORKING = "Keeping…";

/** What each choice posts, the bar its Undo is offered on (Keep has none), and its working word. */
const ACTS = {
  keep: { route: "/tidy/keep", undo: null, word: KEEP_WORKING },
  "put-away": { route: "/home/put-away", undo: PUT_AWAY_UNDO, word: PUT_AWAY_WORKING },
  stale: { route: "/home/archive", undo: DONE_UNDO, word: DONE_WORKING },
};
const KEYS = { 1: "keep", 2: "put-away", 3: "stale" };

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
 * nothing. Put it away and Done with it answer the `StateChange` that their Undo posts back to
 * `/home/undo-state` exactly as received, then the link is undecided again: an open tray shows it
 * (the finish screen too), a closed or ended one only returns to `closed`, never open. A refusal is
 * shown in `#tidy-error`.
 *
 * Keys 1, 2 and 3 press the shown link's choices only while open, and not in a field, with a
 * modifier, while a dialog is open, or when auto-repeating. A choice that is slow to answer dims
 * its link's step, not the whole tray, and its title says its working word (`busyLook`); a key finds
 * the choice's button from the step and the action.
 */
export const TIDY_SCRIPT = `{
const tidyRoot = document.getElementById("tidy");
const tidyAlert = document.getElementById("tidy-error");
const tidyActs = ${JSON.stringify(ACTS)};
const tidyKeys = ${JSON.stringify(KEYS)};
const steps = [...tidyRoot.querySelectorAll(".tidy-step")];
const closed = tidyRoot.querySelector(".tidy-closed");
const finished = tidyRoot.querySelector(".tidy-done");
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
const choose = (step, act) =>
  whileBusy(tidyRoot, async (answered, ticket) => {
    const id = step.dataset.id;
    const { route, undo } = tidyActs[act];
    tidyAlert.textContent = "";
    const res = await post(route, { id });
    answered();
    const change = undo && res && res.status === 200 ? await res.json().catch(() => null) : null;
    if (undo ? !change || !change.before || !change.after : !res || res.status !== 204) {
      tidyAlert.textContent = await failure(res);
      return;
    }
    decided.add(step);
    if (state === "open") go("open");
    if (!undo) return;
    showUndo(ticket, undo.text, () =>
      whenFree(tidyRoot, async () => {
        tidyAlert.textContent = "";
        const back = await post("/home/undo-state", { id, change });
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
  const act = tidyKeys[event.key];
  const step = shownStep();
  const active = event.target;
  if (!act || !step || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (document.querySelector("dialog[open]")) return;
  if (active && (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) return;
  choose(step, act);
});
}`;
