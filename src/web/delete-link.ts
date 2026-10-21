import type { MenuItem } from "./card-menu.js";
import { TRASH } from "./copy-menu.js";

/** The card menu's last row, which deletes the link; its script is `deleteLinkScript`. */
export const deleteLinkItem: MenuItem = { act: "delete-link", icon: TRASH, text: "Delete link" };

/**
 * Delete link on the cards inside `#root`, including those Show older links appends. Defines two
 * page-globals:
 * - `takeOut(listRoot, card, remove)` takes a card out of its list: it puts focus on the ⋯ of the
 *   next shown card in the list, across months, or else on the page's heading, then removes the
 *   card (`remove`) or hides it, and hides its month when no shown card is left in it. It returns
 *   the function that puts the card back where it was and shows its month. I'm done with it
 *   (`doneLinkScript`) uses it too.
 * - `deleteCard(card)`, which the edit dialog's Delete also calls: it posts `/links/delete`, takes
 *   the card out and offers Undo, which posts `/links/restore` and puts the same card back. It
 *   sends nothing while another action on the card is out (`whileBusy`). A refusal, or an Undo that
 *   does not succeed, is shown in `#error`.
 *
 * For the page's one script after `CARD_FETCH` (it needs `post`, `failure` and `showUndo`); the
 * menu row's listener is a block.
 */
export const deleteLinkScript = (
  root: string,
  error: string,
) => `const takeOut = (listRoot, card, remove) => {
  // A card moved out of the list ("I'm done with it") stays in the page, hidden.
  const shown = (el) => !el.closest("[hidden]");
  const parent = card.parentNode;
  const next = card.nextElementSibling;
  const cards = [...listRoot.querySelectorAll("[data-id]")];
  const after = cards.slice(cards.indexOf(card) + 1).find(shown);
  const nextMenu = after && after.querySelector(".card-menu summary");
  if (nextMenu) nextMenu.focus();
  else {
    const heading = document.querySelector("h1");
    heading.setAttribute("tabindex", "-1");
    heading.focus();
  }
  if (remove) card.remove();
  else card.hidden = true;
  const month = parent.closest("section.month");
  if (month && ![...parent.children].some(shown)) month.hidden = true;
  return () => {
    if (remove) parent.insertBefore(card, next);
    else card.hidden = false;
    if (month) month.hidden = false;
  };
};
const deleteCard = (card) =>
  whileBusy(card, async () => {
    const listRoot = document.getElementById(${JSON.stringify(root)});
    const deleteAlert = document.getElementById(${JSON.stringify(error)});
    const id = card.dataset.id;
    deleteAlert.textContent = "";
    const res = await post("/links/delete", { id });
    if (!res || res.status !== 204) {
      deleteAlert.textContent = await failure(res);
      return;
    }
    const putBack = takeOut(listRoot, card, true);
    showUndo("Link deleted.", async () => {
      const back = await post("/links/restore", { id });
      if (back && back.status === 204) putBack();
      else deleteAlert.textContent = await failure(back);
    });
  });
{
const deleteRoot = document.getElementById(${JSON.stringify(root)});
if (deleteRoot) {
  deleteRoot.addEventListener("click", (event) => {
    const button = event.target.closest(".card-menu button[data-act=delete-link]");
    if (!button) return;
    button.closest("details").open = false;
    deleteCard(button.closest("[data-id]"));
  });
}
}`;
