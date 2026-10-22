import { createHash } from "node:crypto";
import type { CopyView } from "../core/copy-reading.js";
import type { HandyView } from "../core/tools.js";
import { isWebUrl } from "../core/url-key.js";
import { backLink, COPY_END_SCRIPT, copyEnd } from "./copy-end.js";
import { copyHtml } from "./copy-markdown.js";
import { displayTitle } from "./display-title.js";
import { PUT_AWAY_MARKER } from "./done-link.js";
import { hostOf } from "./host.js";
import { whyText } from "./link-rows.js";
import { openedScript, openLink } from "./open-link.js";
import { escapeHtml, PAGE_STYLE, page, pageScripts, savedOn, scriptText } from "./page.js";

/**
 * A link's saved copy. `from` is the address of the list page the link is on, so the copy page can
 * say where Back goes (`backTarget`); the route checks it, so any value is safe to send.
 */
export const copyHref = (linkId: string, from?: string) =>
  `/links/${encodeURIComponent(linkId)}/copy${from === undefined ? "" : `?from=${encodeURIComponent(from)}`}`;

/** Where the copy page's Back goes: `label` completes "Back to …". */
export type Back = { label: string; href: string };

/** The one element holding the page's frame, whose clicks on an `a[data-open]` it records. */
const FRAME_ID = "copy-frame";
const OPENED = openedScript(FRAME_ID, "/links/opened", PUT_AWAY_MARKER);
const END = `<script>${COPY_END_SCRIPT}</script>`;

/** The page's own scripts: its menu, and the Undo bar the end row offers. */
const COPY_PAGE_OPTIONS = { menu: true, undo: true };

/**
 * Every script of the copy page: the page's own for its menu and Undo bar, the one recording an
 * opening, and the end row's.
 * The CSP lists these and no other, hashed from here and never from the page they render into,
 * so a script that reached the page through the article would still be refused.
 */
export const copyScripts = [...pageScripts(COPY_PAGE_OPTIONS), scriptText(OPENED), scriptText(END)];

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

/**
 * The saved copy of one link: its article, or why there is none to show, in the app's frame: the
 * top bar, Back and Open on the site, the title, one grey line and the why when there is one.
 */
export function copyPage(
  view: CopyView,
  now: Date,
  back: Back,
  handy: HandyView | null = null,
): string {
  const { link, copy } = view;
  const title = displayTitle(link);
  const open = isWebUrl(link.url)
    ? openLink(
        link,
        `Open on ${escapeHtml(hostOf(link.url) || link.url)} <span aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span>`,
        "copy-open",
      )
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
    `<main class="copy" id="${FRAME_ID}" data-id="${escapeHtml(link.id)}">
<div class="copy-nav">${backLink(back)}${open}</div>
<h1>${escapeHtml(title)}</h1>
<p class="small copy-line">Your copy from ${savedOn(view.madeAt, now)} · the page may have changed</p>
${link.why ? `<p class="copy-why">${whyText(link.why)}</p>\n` : ""}${body}
${copyEnd(link, handy, back)}
</main>
${OPENED}
${END}`,
    COPY_PAGE_OPTIONS,
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
