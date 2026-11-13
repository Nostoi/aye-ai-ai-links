import type { GoneView } from "../core/link-check.js";
import type { Link } from "../core/types.js";
import { ARCHIVE, DONE_HINT, DONE_LABEL } from "./done-link.js";
import { escapeHtml } from "./page.js";
import { slideButton } from "./slide-button.js";

/** The words on a card whose link seems gone. */
export const GONE_TEXT = "This page seems gone";

/** The small line under It still works. */
export const STILL_WORKS_HINT = "Clears this warning";

/** A chain link, for It still works. */
const LINK_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>`;

/**
 * The amber band a card carries once its link seems gone (#128, #298): the warning, then, on an
 * active link, It still works and Done with it as sliding icon buttons, Done with it last. A link
 * already done or put away gets the warning only. `done` is the `data-act` of Done with it, which
 * the page's script knows (`gone-done`, or `done` on a Handy tile); `read` is the address of a
 * saved copy, linked beside the warning where a page wants it (Home's gone row; every other page's
 * grey line has it). The band carries no date. The theme draws it along its card's bottom edge.
 */
export function goneBand(
  link: Link,
  { done = "gone-done", read }: { done?: string; read?: string | undefined } = {},
): string {
  const copy = read
    ? `\n<a class="gone-copy" href="${escapeHtml(read)}" data-act="read-copy">Read the saved copy</a>`
    : "";
  const buttons =
    link.state === "active"
      ? `\n<div class="gone-actions">${slideButton("still-works", LINK_ICON, "It still works", STILL_WORKS_HINT)}${slideButton(done, ARCHIVE, DONE_LABEL, DONE_HINT)}</div>`
      : "";
  return `<div class="gone-band" data-gone>
<p>${GONE_TEXT}</p>${copy}${buttons}
</div>`;
}

/** `goneBand` for a link whose check says it seems gone; empty otherwise. */
export const goneLine = (
  link: Link,
  view: GoneView | null | undefined,
  options?: Parameters<typeof goneBand>[1],
): string => (view ? goneBand(link, options) : "");

/**
 * The gone band's buttons on the cards inside `#root`, including those Show older links appends.
 * It still works posts `/links/still-works`; once the server agrees it collapses and hides that
 * card's band (`collapseBand`), moves focus to the card's ⋯ and offers Undo, which sends back the
 * rows the answer held and shows the band whole again (`resetBand`). Done with it is the menu's
 * own (`doneCard`, so the page's script includes `doneLinkScript` too): the band collapses after
 * the server accepts and before the card leaves, and is made whole again inside the hidden card
 * so Undo brings back the card with its band. Each button is off until the other's answer
 * comes, and a card takes no other action while one is out (`whileBusy`). A refusal is shown in
 * `#error` and leaves the band as it was, and a refused Undo leaves things hidden. A block; needs
 * `CARD_FETCH` and `showUndo`.
 */
export const goneScript = (root: string, error: string) => `{
const goneRoot = document.getElementById(${JSON.stringify(root)});
const goneError = document.getElementById(${JSON.stringify(error)});
if (goneRoot) {
  goneRoot.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-gone] button[data-act]");
    if (!button) return;
    const line = button.closest("[data-gone]");
    const card = line.closest("[data-id]");
    const buttons = [...line.querySelectorAll("button")];
    if (buttons.some((b) => b.disabled)) return;
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (button.dataset.act !== "still-works") {
        await doneCard(card, () => collapseBand(line));
        return resetBand(line);
      }
      const id = card.dataset.id;
      await whileBusy(card, async () => {
        goneError.textContent = "";
        const res = await post("/links/still-works", { id });
        const moved = res && res.status === 200 ? await res.json().catch(() => null) : null;
        if (!moved || !moved.check) {
          goneError.textContent = await failure(res);
          return;
        }
        await collapseBand(line);
        const menu = card.querySelector(".card-menu summary");
        if (menu) menu.focus();
        showUndo("Marked as working.", async () => {
          const back = await post("/links/still-works/undo", { id, check: moved.check, previous: moved.previous });
          if (back && back.status === 204) resetBand(line);
          else goneError.textContent = await failure(back);
        });
      });
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
}
}`;
