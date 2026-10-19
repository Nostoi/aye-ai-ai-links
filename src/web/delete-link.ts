import type { MenuItem } from "./card-menu.js";
import { TRASH } from "./copy-menu.js";

/** The card menu's last row, which deletes the link; its script is `deleteLinkScript`. */
export const deleteLinkItem: MenuItem = { act: "delete-link", icon: TRASH, text: "Delete link" };

/**
 * Delete link on the cards inside `#root`, including those Show older links appends. Defines the
 * page-global `deleteCard(card)`, which the edit dialog's Delete also calls: it posts
 * `/links/delete`, then removes the card (hiding its month when that empties it), puts focus on
 * the next card's ⋯ or else the page's heading, and offers Undo, which posts `/links/restore` and
 * puts the same card back where it was. A refusal, or an Undo that does not succeed, is shown in
 * `#error`. For the page's one script after `CARD_FETCH` (it needs `post`, `failure` and
 * `showUndo`); the menu row's listener is a block.
 */
export const deleteLinkScript = (
  root: string,
  error: string,
) => `const deleteCard = async (card) => {
  const deleteAlert = document.getElementById(${JSON.stringify(error)});
  const id = card.dataset.id;
  deleteAlert.textContent = "";
  const res = await post("/links/delete", { id });
  if (!res || res.status !== 204) {
    deleteAlert.textContent = await failure(res);
    return;
  }
  const parent = card.parentNode;
  const next = card.nextElementSibling;
  const nextMenu = next && next.querySelector(".card-menu summary");
  if (nextMenu) nextMenu.focus();
  else {
    const heading = document.querySelector("h1");
    heading.setAttribute("tabindex", "-1");
    heading.focus();
  }
  card.remove();
  const month = parent.closest("section.month");
  if (month && !parent.querySelector("li")) month.hidden = true;
  showUndo("Link deleted.", async () => {
    const back = await post("/links/restore", { id });
    if (back && back.status === 204) {
      parent.insertBefore(card, next);
      if (month) month.hidden = false;
    } else deleteAlert.textContent = await failure(back);
  });
};
{
const deleteRoot = document.getElementById(${JSON.stringify(root)});
if (deleteRoot) {
  deleteRoot.addEventListener("click", async (event) => {
    const button = event.target.closest(".card-menu button[data-act=delete-link]");
    if (!button || button.disabled) return;
    button.closest("details").open = false;
    button.disabled = true;
    await deleteCard(button.closest("[data-id]"));
    button.disabled = false;
  });
}
}`;
