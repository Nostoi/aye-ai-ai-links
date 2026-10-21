import type { GoneView } from "../core/link-check.js";
import type { Link } from "../core/types.js";

/** The words on a card whose link seems gone. */
export const GONE_TEXT = "This page seems gone";

/**
 * The line a card carries once its link seems gone (#128). An active link also gets It still works
 * and I'm done with it; a link already done with gets the line only. It carries no date, and no
 * link to a saved copy: the card's grey line (`cardLine`) has that.
 */
export function goneLine(link: Link, view: GoneView | null | undefined): string {
  if (!view) return "";
  const buttons =
    link.state === "active"
      ? `\n<div class="actions small-actions"><button type="button" data-act="still-works">It still works</button><button type="button" data-act="gone-done">I'm done with it</button></div>`
      : "";
  return `<div class="gone-line" data-gone>
<p class="small">${GONE_TEXT}</p>${buttons}
</div>`;
}

/**
 * The gone line's buttons on the cards inside `#root`, including those Show older links appends.
 * It still works posts `/links/still-works`, hides that card's line and offers Undo, which sends
 * back the rows the answer held. I'm done with it is the menu's own (`doneCard`), so the page's
 * script includes `doneLinkScript` too. Each button is off until the other's answer comes, and
 * a card takes no other action while It still works is out (`whileBusy`). A refusal is shown in
 * `#error`, and a refused Undo leaves things hidden. A block; needs `CARD_FETCH` and `showUndo`.
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
      if (button.dataset.act !== "still-works") return await doneCard(card);
      const id = card.dataset.id;
      await whileBusy(card, async () => {
        goneError.textContent = "";
        const res = await post("/links/still-works", { id });
        const moved = res && res.status === 200 ? await res.json().catch(() => null) : null;
        if (!moved || !moved.check) {
          goneError.textContent = await failure(res);
          return;
        }
        line.hidden = true;
        showUndo("Marked as working.", async () => {
          const back = await post("/links/still-works/undo", { id, check: moved.check, previous: moved.previous });
          if (back && back.status === 204) line.hidden = false;
          else goneError.textContent = await failure(back);
        });
      });
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
}
}`;
