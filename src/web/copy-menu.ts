import type { MenuItem } from "./card-menu.js";

export const TRASH = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5M14 11v5"/></svg>`;

/** The menu row that removes a link's saved copy; its script is `removeCopyScript`. */
export const removeCopyItem: MenuItem = {
  act: "remove-copy",
  icon: TRASH,
  text: "Remove saved copy",
};

/**
 * Remove saved copy on the cards inside `#root`, including those Show older links appends. It posts
 * `/links/copy/remove`, hides the card's Remove row and its grey line's Saved copy link, puts
 * focus on the ⋯ and offers Undo, which posts `/links/copy/restore` and shows them again. A
 * refusal, or an Undo that does not succeed, is shown in `#error`. A card takes no other action
 * while it is out (`whileBusy`). A block; needs `CARD_FETCH` and `showUndo`.
 */
export const removeCopyScript = (root: string, error: string) => `{
const copyRoot = document.getElementById(${JSON.stringify(root)});
const copyError = document.getElementById(${JSON.stringify(error)});
if (copyRoot) {
  copyRoot.addEventListener("click", async (event) => {
    const button = event.target.closest(".card-menu button[data-act=remove-copy]");
    if (!button) return;
    const menu = button.closest("details");
    const card = button.closest("[data-id]");
    menu.open = false;
    await whileBusy(card, async () => {
      const id = card.dataset.id;
      const rows = [...card.querySelectorAll("[data-act=read-copy], [data-act=remove-copy]")];
      copyError.textContent = "";
      const res = await post("/links/copy/remove", { id });
      if (!res || res.status !== 204) {
        copyError.textContent = await failure(res);
        return;
      }
      for (const row of rows) row.hidden = true;
      menu.querySelector("summary").focus();
      showUndo("Saved copy removed.", async () => {
        const back = await post("/links/copy/restore", { id });
        if (back && back.status === 204) for (const row of rows) row.hidden = false;
        else copyError.textContent = await failure(back);
      });
    });
  });
}
}`;
