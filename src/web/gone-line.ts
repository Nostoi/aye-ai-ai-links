import type { GoneView } from "../core/link-check.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { Link } from "../core/types.js";
import { copyHref } from "./copy-page.js";

/** The words on a card whose link seems gone. */
export const GONE_TEXT = "This page seems gone";

/**
 * The line a card carries once its link seems gone (#128). An active link also gets It still works
 * and I'm done with it; a link already done with gets the line only. It carries no date. A link
 * with a saved copy (`copy`) also gets a link to read it, first in the row.
 */
export function goneLine(link: Link, view: GoneView | null | undefined, copy?: CopyInfo): string {
  if (!view) return "";
  const read = copy
    ? `<a href="${copyHref(link.id)}" data-act="read-copy">Read the saved copy</a>`
    : "";
  const answers =
    link.state === "active"
      ? `<button type="button" data-act="still-works">It still works</button><button type="button" data-act="gone-done">I'm done with it</button>`
      : "";
  const buttons =
    read + answers === "" ? "" : `\n<div class="actions small-actions">${read}${answers}</div>`;
  return `<div class="gone-line" data-gone>
<p class="small">${GONE_TEXT}</p>${buttons}
</div>`;
}

/**
 * The gone line's buttons on the cards inside `#root`, including those Show older links appends.
 * It still works posts `/links/still-works`, hides that card's line and offers Undo, which sends
 * back the rows the answer held. I'm done with it is the menu's own (`doneCard`), so the page's
 * script includes `doneLinkScript` too. Each button is off until the other's answer comes. A
 * refusal is shown in `#error`, and a refused Undo leaves things hidden. A block; needs
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
    if (button.dataset.act !== "still-works") {
      await doneCard(card);
      buttons.forEach((b) => (b.disabled = false));
      return;
    }
    const id = card.dataset.id;
    goneError.textContent = "";
    const res = await post("/links/still-works", { id });
    buttons.forEach((b) => (b.disabled = false));
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
}
}`;
