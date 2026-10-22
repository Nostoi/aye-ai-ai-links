import type { Link } from "../core/types.js";
import type { MenuItem } from "./card-menu.js";

const TRAY = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 13l2.5-6.5h11L20 13"/><path d="M4 13v5.5h16V13h-4.5a3.5 3.5 0 0 1-7 0z"/></svg>`;
const BACK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9.5a4.5 4.5 0 0 1 0 9H11"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

/** The owner's name for taking a link out of their lists; the wire value stays `archived`. */
export const STALE_LABEL = "It's stale";

/** The name of the list section holding links the owner has let go (the done views). */
export const OUT_OF_LISTS = "Out of your lists";

/** The Undo bar every It's stale shows: a bold title, then the text (`showUndo(text, undo, title)`). */
export const STALE_UNDO = {
  title: "Let go.",
  text: "You won't see it again unless you search for it.",
};

/** What a link out of your lists is called on its grey line and the Save page. */
export const PUT_AWAY_MARKER = "Put away";
export const STALE_MARKER = "Stale";

/** `Put away` or `Stale` for a link out of your lists (archived with or without `putAwayAt`); null for an active one. */
export const outOfListsMarker = (link: Pick<Link, "state" | "putAwayAt">) =>
  link.state === "active" ? null : link.putAwayAt ? PUT_AWAY_MARKER : STALE_MARKER;

/** The Undo bar every Put it away shows. */
export const PUT_AWAY_UNDO = {
  title: "Put away.",
  text: "Out of your lists but still saved. If you start something it fits, it'll come back.",
};

/** The Undo bar Bring it back shows: a title and no text. */
export const BRING_BACK_UNDO = { title: "Back in your lists.", text: "" };

/** The card menu's first row, which takes the link out of your lists; its script is `doneLinkScript`. */
export const DONE_ITEM: MenuItem = { act: "archive", icon: CHECK, text: STALE_LABEL };

/** The card menu's row that puts a link away until something it fits comes up. */
export const PUT_AWAY_ITEM: MenuItem = { act: "put-away", icon: TRAY, text: "Put it away" };

/** An archived link's row that returns it to your lists. */
export const BRING_BACK_ITEM: MenuItem = { act: "bring-back", icon: BACK, text: "Bring it back" };

/** Each state action: its route and the bar its Undo is offered on. */
const STATE_ACTS = {
  archive: { route: "/home/archive", undo: STALE_UNDO },
  "put-away": { route: "/home/put-away", undo: PUT_AWAY_UNDO },
  "bring-back": { route: "/home/bring-back", undo: BRING_BACK_UNDO },
};

/**
 * It's stale, Put it away and Bring it back on the cards inside `#root`, including those Show
 * older links appends. Defines the page-global `stateCard(card, act)` and `doneCard(card)` (It's
 * stale), which the gone line's It's stale and Home's buttons also call. An action posts its
 * route and takes the card out with `takeOut(listRoot, card, false, change)` (hidden, not removed;
 * a `takeOut` that keeps the card on the page shows `change.after` itself) once the answer is the
 * `StateChange` as JSON. Its Undo posts `/home/undo-state` with that change, exactly as received,
 * and calls the put-back `takeOut` returned. It sends nothing while another action on the card, or
 * its Undo, is out (`whileBusy`). A refusal, or an Undo that does not succeed, is shown in `#error`.
 * For the page's one script after `CARD_FETCH` and `deleteLinkScript` (it needs `post`, `failure`,
 * `showUndo`, `whileBusy` and `takeOut`); the menu rows' listener is a block.
 */
export const doneLinkScript = (
  root: string,
  error: string,
) => `const STATE_ACTS = ${JSON.stringify(STATE_ACTS)};
const stateCard = (card, act) =>
  whileBusy(card, async () => {
    const listRoot = document.getElementById(${JSON.stringify(root)});
    const doneAlert = document.getElementById(${JSON.stringify(error)});
    const id = card.dataset.id;
    const { route, undo } = STATE_ACTS[act];
    doneAlert.textContent = "";
    const res = await post(route, { id });
    const change = res && res.status === 200 ? await res.json().catch(() => null) : null;
    if (!change || !change.before || !change.after) {
      doneAlert.textContent = await failure(res);
      return;
    }
    const putBack = takeOut(listRoot, card, false, change);
    showUndo(undo.text, () => whileBusy(card, async () => {
      const back = await post("/home/undo-state", { id, change });
      if (back && back.status === 204) putBack();
      else doneAlert.textContent = await failure(back);
    }), undo.title);
  });
const doneCard = (card) => stateCard(card, "archive");
{
const doneRoot = document.getElementById(${JSON.stringify(root)});
if (doneRoot) {
  doneRoot.addEventListener("click", (event) => {
    const button = event.target.closest(".card-menu button");
    if (!button || !(button.dataset.act in STATE_ACTS)) return;
    button.closest("details").open = false;
    stateCard(button.closest("[data-id]"), button.dataset.act);
  });
}
}`;
