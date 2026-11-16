import { createHash } from "node:crypto";
import { hostOf } from "./host.js";
import { escapeHtml, PAGE_STYLE, page, pageScripts } from "./page.js";

/**
 * The page an agent's open link shows (#133): it records the opening, then forwards to the link.
 * The address is only ever in the Continue link's escaped `href`; the script is fixed text that
 * reads it from there, so no saved address reaches a script and the script's hash never changes.
 * Without scripts, the Continue link still works and nothing is recorded.
 */

const GO_ID = "open-go";

/** Posts to the page's own address with keepalive, so the report outlives the page, then forwards. */
export const OPEN_SCRIPT = `{
const go = document.getElementById(${JSON.stringify(GO_ID)});
fetch(location.pathname, { method: "POST", redirect: "manual", keepalive: true }).catch(() => {});
if (go) location.replace(go.href);
}`;

const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** Every answer of the open routes' pages: no cache, no referrer, no indexing, and only these scripts. */
export const OPEN_HEADERS: Record<string, string> = {
  "Content-Security-Policy": `default-src 'none'; img-src 'self' data:; font-src 'self'; style-src ${hash(PAGE_STYLE)}; script-src ${[...pageScripts({}), OPEN_SCRIPT].map(hash).join(" ")}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/** The forwarding page for a web link's address. */
export function openPage(url: string): string {
  const site = escapeHtml(hostOf(url) || url);
  return page(
    `Opening ${hostOf(url) || "the link"}`,
    `<main>
<h1>Opening ${site}…</h1>
<p><a id="${GO_ID}" href="${escapeHtml(url)}" rel="noreferrer">Continue to ${site}</a></p>
</main>
<script>${OPEN_SCRIPT}</script>`,
  );
}

/** One fixed body for every code that opens nothing: unknown, or its link deleted. */
export const openMissingPage = () =>
  page(
    "Not found",
    "<main>\n<h1>Not found</h1>\n<p>This link doesn't open anything. It may have been deleted.</p>\n</main>",
  );
