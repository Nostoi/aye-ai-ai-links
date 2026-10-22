import { createHash } from "node:crypto";
import type { CopyView } from "../core/copy-reading.js";
import { isWebUrl } from "../core/url-key.js";
import { copyHtml } from "./copy-markdown.js";
import { hostOf } from "./host.js";
import { openedScript } from "./open-link.js";
import { escapeHtml, PAGE_STYLE, page, pageScripts, savedOn, scriptText } from "./page.js";

export const copyHref = (linkId: string) => `/links/${encodeURIComponent(linkId)}/copy`;

/** The one element holding the page's frame, whose clicks on an `a[data-open]` it records. */
const FRAME_ID = "copy-frame";
const OPENED = openedScript(FRAME_ID, "/links/opened");

/**
 * Every script of the copy page: the page's own for its menu, and the one recording an opening.
 * The CSP lists these and no other, hashed from here and never from the page they render into,
 * so a script that reached the page through the article would still be refused.
 */
export const copyScripts = [...pageScripts({ menu: true }), scriptText(OPENED)];

const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/**
 * Every answer of the copy route: loads nothing from outside, runs only `copyScripts` and sends
 * requests only to the app itself (the sign-out and the opening it records).
 */
export const COPY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": `default-src 'none'; img-src 'self' data:; style-src ${hash(PAGE_STYLE)}; script-src ${[...new Set(copyScripts)].map(hash).join(" ")}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const NEUTRAL = "A reading copy kept by this app. The page itself may have changed since.";

/** The saved copy of one link: its article, or why there is none to show. */
export function copyPage(view: CopyView, now: Date): string {
  const { link, copy } = view;
  const title = link.title ?? link.url;
  const site = isWebUrl(link.url)
    ? `<p class="small"><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(hostOf(link.url) || link.url)}</a></p>\n`
    : "";
  const body =
    copy === "missing"
      ? "<p>This saved copy's files are missing.</p>"
      : copy === "unreadable"
        ? "<p>The saved copy couldn't be read just now.</p>"
        : `<article class="copy-article">${copyHtml(copy.markdown, {
            linkId: link.id,
            nonce: copy.nonce,
            images: copy.images,
          })}</article>`;
  return page(
    title,
    `<main class="copy" id="${FRAME_ID}">
<h1>${escapeHtml(title)}</h1>
${site}<p class="small">Saved copy from ${savedOn(view.madeAt, now)}</p>
<p class="small">${NEUTRAL}</p>
${body}
</main>
${OPENED}`,
    { menu: true },
  );
}

/** One fixed body for every copy that isn't the owner's to read. */
export const copyNotFoundPage = () =>
  page(
    "Not found",
    `<main class="copy">\n<h1>Not found</h1>\n<p>No saved copy here.</p>\n</main>`,
    {
      home: true,
    },
  );
