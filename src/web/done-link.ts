import type { MenuItem } from "./card-menu.js";

const CHECK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

/** The card menu's first row, which moves the link out of your list; its script is `doneLinkScript`. */
export const DONE_ITEM: MenuItem = { act: "archive", icon: CHECK, text: "I'm done with it" };

/**
 * I'm done with it on the cards inside `#root`, including those Show older links appends. Defines
 * the page-global `doneCard(card)`, which the gone line's I'm done with it also calls: it posts
 * `/home/archive`, takes the card out with `takeOut` (hidden, not removed) and offers Undo, which
 * posts `/home/unarchive` and shows the card again. A card is busy until its answer comes, so a
 * second click sends nothing. A refusal, or an Undo that does not succeed, is shown in `#error`.
 * For the page's one script after `CARD_FETCH` and `deleteLinkScript` (it needs `post`, `failure`,
 * `showUndo` and `takeOut`); the menu row's listener is a block.
 */
export const doneLinkScript = (root: string, error: string) => `const doneCard = (() => {
  const busy = new WeakSet();
  return async (card) => {
    if (busy.has(card)) return;
    const listRoot = document.getElementById(${JSON.stringify(root)});
    const doneAlert = document.getElementById(${JSON.stringify(error)});
    const id = card.dataset.id;
    doneAlert.textContent = "";
    busy.add(card);
    const res = await post("/home/archive", { id });
    busy.delete(card);
    if (!res || res.status !== 204) {
      doneAlert.textContent = await failure(res);
      return;
    }
    const putBack = takeOut(listRoot, card, false);
    showUndo("Moved out of your list.", async () => {
      const back = await post("/home/unarchive", { id });
      if (back && back.status === 204) putBack();
      else doneAlert.textContent = await failure(back);
    });
  };
})();
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
