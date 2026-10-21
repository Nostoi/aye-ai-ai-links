import type { MenuItem } from "./card-menu.js";

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

/** The card menu's first row, which takes the link out of your lists; its script is `doneLinkScript`. */
export const DONE_ITEM: MenuItem = { act: "archive", icon: CHECK, text: STALE_LABEL };

/**
 * It's stale on the cards inside `#root`, including those Show older links appends. Defines
 * the page-global `doneCard(card)`, which the gone line's It's stale also calls: it posts
 * `/home/archive`, takes the card out with `takeOut` (hidden, not removed) and offers Undo, which
 * posts `/home/unarchive` and shows the card again. It sends nothing while another action on the
 * card is out (`whileBusy`). A refusal, or an Undo that does not succeed, is shown in `#error`.
 * For the page's one script after `CARD_FETCH` and `deleteLinkScript` (it needs `post`, `failure`,
 * `showUndo`, `whileBusy` and `takeOut`); the menu row's listener is a block.
 */
export const doneLinkScript = (root: string, error: string) => `const doneCard = (card) =>
  whileBusy(card, async () => {
    const listRoot = document.getElementById(${JSON.stringify(root)});
    const doneAlert = document.getElementById(${JSON.stringify(error)});
    const id = card.dataset.id;
    doneAlert.textContent = "";
    const res = await post("/home/archive", { id });
    if (!res || res.status !== 204) {
      doneAlert.textContent = await failure(res);
      return;
    }
    const putBack = takeOut(listRoot, card, false);
    showUndo(${JSON.stringify(STALE_UNDO.text)}, async () => {
      const back = await post("/home/unarchive", { id });
      if (back && back.status === 204) putBack();
      else doneAlert.textContent = await failure(back);
    }, ${JSON.stringify(STALE_UNDO.title)});
  });
{
const doneRoot = document.getElementById(${JSON.stringify(root)});
if (doneRoot) {
  doneRoot.addEventListener("click", (event) => {
    const button = event.target.closest(".card-menu button[data-act=archive]");
    if (!button) return;
    button.closest("details").open = false;
    doneCard(button.closest("[data-id]"));
  });
}
}`;
