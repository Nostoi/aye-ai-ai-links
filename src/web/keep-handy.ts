import type { HandyView } from "../core/tools.js";
import type { Link } from "../core/types.js";

/**
 * A link's Keep handy control on search results, All links and space pages: "Keep handy", or
 * "Handy · Not handy anymore" once kept (#125). Both are rendered and one is hidden, so the script
 * only swaps them. An archived link gets none: it can't be on the shelf.
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
 * The Keep handy controls inside `#root`, including those Show older links appends. Keep handy
 * posts `/tools/keep` and Not handy anymore `/tools/not-handy`; the control then shows the new
 * state and focus moves to its visible button. Not handy anymore offers Undo, which sends back the
 * rows the action answered to `/tools/undo`. A refusal is shown in `#error`. A block; needs
 * `CARD_FETCH` and `showUndo`.
 */
export const keepHandyScript = (root: string, error: string) => `{
const keepRoot = document.getElementById(${JSON.stringify(root)});
const keepError = document.getElementById(${JSON.stringify(error)});
const showKept = (control, kept) => {
  const keep = control.querySelector("button[data-act=keep]");
  const on = control.querySelector(".handy-on");
  keep.hidden = kept;
  on.hidden = !kept;
  (kept ? on.querySelector("button") : keep).focus();
};
if (keepRoot) {
  keepRoot.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-handy] button[data-act]");
    if (!button || button.disabled) return;
    const control = button.closest("[data-handy]");
    const id = control.closest("[data-id]").dataset.id;
    const keep = button.dataset.act === "keep";
    keepError.textContent = "";
    button.disabled = true;
    const res = await post(keep ? "/tools/keep" : "/tools/not-handy", { id });
    button.disabled = false;
    const moved = res && res.status === 200 ? await res.json().catch(() => null) : null;
    if (!moved || !moved.tool) {
      button.focus();
      keepError.textContent = await failure(res);
      return;
    }
    showKept(control, keep);
    if (keep) return;
    showUndo("Not handy anymore.", async () => {
      const back = await post("/tools/undo", { id, tool: moved.tool, previous: moved.previous });
      if (back && back.status === 204) showKept(control, true);
      else keepError.textContent = await failure(back);
    });
  });
}
}`;
