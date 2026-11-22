import type { Link } from "../core/types.js";
import { isWebUrl } from "../core/url-key.js";
import { displayTitle } from "./display-title.js";
import { escapeHtml } from "./page.js";

/**
 * A saved web link, opening in a new tab. `data-open` lets the page's `openedScript` record the
 * opening, so every page that links out to a saved link must use this. Not for a non-web URL.
 */
export const openLink = (link: Link, label: string, className?: string, attrs = "") =>
  `<a${className ? ` class="${className}"` : ""}${attrs} href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" data-open>${label}</a>`;

/**
 * A saved link's title (escaped HTML): linked by `openLink` when it is a web link, else plain.
 * `label` is already-escaped HTML to show instead of the title, for a card that trims it.
 */
export function linkTitle(link: Link, label: string = escapeHtml(displayTitle(link))): string {
  return isWebUrl(link.url) ? openLink(link, label) : label;
}

/**
 * Records the openings of the saved links inside `#root`. A click or middle click on an
 * `a[data-open]` posts its card's `data-id` to `route` with keepalive, and the link opens as
 * usual; opening from the browser's context menu is not seen. Listening on `#root` covers cards
 * Show older links appends. A block, so these names cannot clash with another script. With
 * `withReceipt`, the receipt of the nearest `[data-receipt]` around the clicked link, read at click
 * time, is sent along as `receipt`, which pairs the opening with that search: the results page's
 * `main`, or the quick-find dialog's own answer (#360); every other list sends none (#134).
 */
export const openedScript = (root: string, route: string, withReceipt = false) => `<script>
{
const openRoot = document.getElementById(${JSON.stringify(root)});
const recordOpen = (event) => {
  const link = event.target.closest("a[data-open]");
  if (!link || (event.type === "auxclick" && event.button !== 1)) return;
  const card = link.closest("[data-id]");${
    withReceipt
      ? `
  const receipt = link.closest("[data-receipt]")?.dataset.receipt;`
      : ""
  }
  fetch(${JSON.stringify(route)}, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: card.dataset.id${withReceipt ? ", receipt" : ""} }),
    redirect: "manual",
    keepalive: true,
  }).catch(() => {});
};
if (openRoot) {
  openRoot.addEventListener("click", recordOpen);
  openRoot.addEventListener("auxclick", recordOpen);
}
}
</script>`;

/**
 * Reports the search the results page showed, once it has loaded, so the log holds searches
 * nothing was opened from too (#134). Keepalive, and a failure is ignored: the page is already shown.
 */
export const searchReportScript = `<script>
{
const receipt = document.querySelector("main[data-receipt]")?.dataset.receipt;
if (receipt) {
  fetch("/search/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receipt }),
    redirect: "manual",
    keepalive: true,
  }).catch(() => {});
}
}
</script>`;
