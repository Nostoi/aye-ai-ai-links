import type { HandyView } from "../core/tools.js";
import type { Link } from "../core/types.js";
import type { MenuItem } from "./card-menu.js";

const PLUS = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M5.25 8h5.5M8 5.25v5.5"/></svg>`;
const MINUS = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M5.25 8h5.5"/></svg>`;

/** The card menu's Keep handy row. */
export const KEEP_ITEM: MenuItem = { act: "keep", icon: PLUS, text: "Keep handy" };

/** The card menu's row for a kept link, and the Handy tile's. */
export const NOT_HANDY: MenuItem = { act: "not-handy", icon: MINUS, text: "Not handy anymore" };

/**
 * A link's Keep handy control on the search the Handy shelf's Add opens: "Keep handy", or
 * "Handy · Not handy anymore" once kept (#125). Both are rendered and one is hidden, so the script
 * only swaps them. An archived link gets none: it can't be on the shelf. Other cards have only
 * the ⋯ menu's rows (`editMenu`).
 */
export function handyControl(link: Link, view: HandyView | null | undefined): string {
  if (link.state !== "active") return "";
  const kept = view?.status === "kept";
  return `<div class="actions small-actions handy-control" data-handy>
<button type="button" data-act="keep"${kept ? " hidden" : ""}>Keep handy</button>
<span class="handy-on"${kept ? "" : " hidden"}>Handy · <button type="button" data-act="not-handy">Not handy anymore</button></span>
</div>`;
}

/**
 * Keep handy and Not handy anymore inside `#root`, in the ⋯ menu and the visible control, including
 * those Show older links appends. Keep handy posts `/tools/keep` and Not handy anymore
 * `/tools/not-handy`; every row and control on the card then shows the new state, so the two agree,
 * and focus moves to the control's visible button, or to the ⋯ when the menu was used. Each offers
 * Undo, which sends back the rows the action answered to `/tools/undo`. A refusal is shown in
 * `#error`. A card takes no other action while one is out (`whileBusy`). A block; needs
 * `CARD_FETCH` and `showUndo`.
 */
export const keepHandyScript = (root: string, error: string) => `{
const keepRoot = document.getElementById(${JSON.stringify(root)});
const keepError = document.getElementById(${JSON.stringify(error)});
const showKept = (card, kept, menu) => {
  for (const b of card.querySelectorAll("button[data-act=keep]")) b.hidden = kept;
  for (const b of card.querySelectorAll(".card-menu button[data-act=not-handy]")) b.hidden = !kept;
  const control = card.querySelector("[data-handy]");
  const on = control && control.querySelector(".handy-on");
  if (on) on.hidden = !kept;
  if (menu || !control) card.querySelector(".card-menu summary").focus();
  else (kept ? on.querySelector("button") : control.querySelector("button[data-act=keep]")).focus();
};
if (keepRoot) {
  keepRoot.addEventListener("click", async (event) => {
    const button = event.target.closest(
      "[data-handy] button[data-act], .card-menu button[data-act=keep], .card-menu button[data-act=not-handy]",
    );
    if (!button) return;
    const card = button.closest("[data-id]");
    const menu = button.closest("details");
    if (menu) menu.open = false;
    await whileBusy(card, async () => {
      const id = card.dataset.id;
      const keep = button.dataset.act === "keep";
      keepError.textContent = "";
      const res = await post(keep ? "/tools/keep" : "/tools/not-handy", { id });
      const moved = res && res.status === 200 ? await res.json().catch(() => null) : null;
      if (!moved || !moved.tool) {
        (menu ? menu.querySelector("summary") : button).focus();
        keepError.textContent = await failure(res);
        return;
      }
      showKept(card, keep, menu);
      showUndo(keep ? "Kept on your Handy shelf." : "Not handy anymore.", async () => {
        const back = await post("/tools/undo", { id, tool: moved.tool, previous: moved.previous });
        if (back && back.status === 204) showKept(card, !keep, menu);
        else keepError.textContent = await failure(back);
      });
    });
  });
}
}`;
