import { createHash } from "node:crypto";
import type { CopyView } from "../core/copy-reading.js";
import { isWebUrl } from "../core/url-key.js";
import { copyHtml } from "./copy-markdown.js";
import { hostOf } from "./host.js";
import { escapeHtml, PAGE_STYLE, page, savedOn } from "./page.js";

export const copyHref = (linkId: string) => `/links/${encodeURIComponent(linkId)}/copy`;

const styleHash = createHash("sha256").update(PAGE_STYLE).digest("base64");

/** Every answer of the copy route: the page runs no script and loads nothing from outside. */
export const COPY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": `default-src 'none'; img-src 'self' data:; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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
    `<main class="copy">
<h1>${escapeHtml(title)}</h1>
${site}<p class="small">Saved copy from ${savedOn(view.madeAt, now)}</p>
<p class="small">${NEUTRAL}</p>
${body}
</main>`,
    { home: true },
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
