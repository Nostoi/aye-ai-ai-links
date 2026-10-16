import type { Link } from "../core/types.js";
import { escapeHtml } from "./page.js";

/** Only web links are made clickable; anything else is shown as text. */
export const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * A saved web link, opening in a new tab. `data-open` lets the page's `openedScript` record the
 * opening, so every page that links out to a saved link must use this. Not for a non-web URL.
 */
export const openLink = (link: Link, label: string, className?: string) =>
  `<a${className ? ` class="${className}"` : ""} href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" data-open>${label}</a>`;

/** A saved link's title (escaped HTML): linked by `openLink` when it is a web link, else plain. */
export function linkTitle(link: Link): string {
  const label = escapeHtml(link.title ?? link.url);
  return isWebUrl(link.url) ? openLink(link, label) : label;
}

/**
 * Records the openings of the saved links inside `#root`. A click or middle click on an
 * `a[data-open]` posts its card's `data-id` to `route` with keepalive, and the link opens as
 * usual; opening from the browser's context menu is not seen. Listening on `#root` covers cards
 * Show older links appends. A block, so these names cannot clash with another script.
 */
export const openedScript = (root: string, route: string) => `<script>
{
const openRoot = document.getElementById(${JSON.stringify(root)});
const recordOpen = (event) => {
  const link = event.target.closest("a[data-open]");
  if (!link || (event.type === "auxclick" && event.button !== 1)) return;
  fetch(${JSON.stringify(route)}, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: link.closest("[data-id]").dataset.id }),
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
