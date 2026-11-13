import { escapeHtml } from "./page.js";

/**
 * A round icon button that opens leftward on hover or keyboard focus to show its label and a
 * small grey hint (#298). The words are real text inside the button, only faded out until it
 * opens, so its accessible name always carries both. The theme draws it (`.slide`); a touch
 * screen shows the words at once. `act` is the `data-act` the page's script listens for.
 */
export const slideButton = (act: string, icon: string, label: string, hint: string) =>
  `<button type="button" class="slide" data-act="${act}">${icon}<span class="slide-words"><span>${escapeHtml(label)}</span><small>${escapeHtml(hint)}</small></span></button>`;
