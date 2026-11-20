import type { Link } from "../core/types.js";
import type { MenuItem } from "./card-menu.js";

const BACK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9.5a4.5 4.5 0 0 1 0 9H11"/></svg>`;
/** An archive box for Archive; a check would read as "selected" (#284). */
export const ARCHIVE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="4.5" rx="1"/><path d="M5 9v10.5h14V9"/><path d="M10 13h4"/></svg>`;

/** The owner's name for taking a link out of their lists; the wire value is `archived` too. */
export const ARCHIVE_LABEL = "Archive";

/** The small line under Archive, saying what happens. */
export const ARCHIVE_HINT = "Out of lists, still in search";

/** Archive's line in a Tidy up step. */
export const ARCHIVE_TIDY_LINE = "Out of your lists. Still found by search.";

/** What each state action's button says while it waits for the answer (#314). */
export const ARCHIVE_WORKING = "Archiving…";
export const BRING_BACK_WORKING = "Bringing back…";

/** The name of the list section holding archived links, and what an archived link's grey line and the Save page say. */
export const ARCHIVED = "Archived";

/** The Undo bar every Archive shows: a bold title, then the text (`showUndo(ticket, text, undo, title)`). */
export const ARCHIVE_UNDO = {
  title: "Archived.",
  text: "Off Home, All links and your spaces. Still findable in search.",
};

/** `Archived` for an archived link; null for an active one. */
export const outOfListsMarker = (link: Pick<Link, "state">) =>
  link.state === "active" ? null : ARCHIVED;

/** The Undo bar Bring it back shows: a title and no text. */
export const BRING_BACK_UNDO = { title: "Brought back.", text: "" };

/** The card menu's row that archives the link; its script is `archiveLinkScript`. */
export const ARCHIVE_ITEM: MenuItem = {
  act: "archive",
  icon: ARCHIVE,
  text: ARCHIVE_LABEL,
  hint: ARCHIVE_HINT,
};

/** An archived link's row that makes it active again. */
export const BRING_BACK_ITEM: MenuItem = { act: "bring-back", icon: BACK, text: "Bring it back" };

/** Each state action: its route and the bar its Undo is offered on. */
const STATE_ACTS = {
  archive: { route: "/home/archive", undo: ARCHIVE_UNDO, word: ARCHIVE_WORKING },
  "bring-back": { route: "/home/bring-back", undo: BRING_BACK_UNDO, word: BRING_BACK_WORKING },
};

/**
 * Archive and Bring it back on the cards inside `#root`, including those Show
 * older links appends. Defines the page-global `stateCard(card, act)` and `archiveCard(card)`
 * (Archive), which the gone line's Archive and Home's buttons also call; each takes the
 * pressed button as its last argument, which shows the action's working word while it is slow
 * (`busyLook`); a menu row passes none and the card only dims. An action posts its
 * route and takes the card out with `takeOut(listRoot, card, false, change)` (hidden, not removed;
 * a `takeOut` that keeps the card on the page shows `change.after` itself) once the answer is the
 * `StateChange` as JSON. Its Undo posts `/home/undo-state` with that change, exactly as received,
 * and calls the put-back `takeOut` returned. It sends nothing while another action on the card, or
 * its Undo, is out (`whileBusy`); an Undo clicked meanwhile waits for it (`whenFree`). A refusal, or
 * an Undo that does not succeed, is shown in `#error`.
 * `archiveCard(card, before)` awaits the optional `before` once the server has accepted and before the
 * card leaves, still under the card's mark; a refusal never calls it.
 * For the page's one script after `CARD_FETCH` and `deleteLinkScript` (it needs `post`, `failure`,
 * `showUndo`, `whileBusy`, `whenFree` and `takeOut`); the menu rows' listener is a block.
 */
export const archiveLinkScript = (
  root: string,
  error: string,
) => `const STATE_ACTS = ${JSON.stringify(STATE_ACTS)};
const stateCard = (card, act, before, button) =>
  whileBusy(card, async (answered, ticket) => {
    const listRoot = document.getElementById(${JSON.stringify(root)});
    const archiveAlert = document.getElementById(${JSON.stringify(error)});
    const id = card.dataset.id;
    const { route, undo } = STATE_ACTS[act];
    archiveAlert.textContent = "";
    const res = await post(route, { id });
    answered();
    const change = res && res.status === 200 ? await res.json().catch(() => null) : null;
    if (!change || !change.before || !change.after) {
      archiveAlert.textContent = await failure(res);
      return;
    }
    if (before) await before();
    const putBack = takeOut(listRoot, card, false, change);
    showUndo(ticket, undo.text, () => whenFree(card, async () => {
      const back = await post("/home/undo-state", { id, change });
      if (back && back.status === 204) putBack();
      else archiveAlert.textContent = await failure(back);
    }), undo.title);
  }, { button, word: STATE_ACTS[act].word });
const archiveCard = (card, before, button) => stateCard(card, "archive", before, button);
{
const archiveRoot = document.getElementById(${JSON.stringify(root)});
if (archiveRoot) {
  archiveRoot.addEventListener("click", (event) => {
    const button = event.target.closest(".card-menu button");
    if (!button || !(button.dataset.act in STATE_ACTS)) return;
    button.closest("details").open = false;
    stateCard(button.closest("[data-id]"), button.dataset.act);
  });
}
}`;
