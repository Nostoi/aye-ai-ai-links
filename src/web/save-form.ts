import { escapeHtml, page } from "./page.js";

/** What the Save page says when the bookmarklet found the page's address too long to send. */
export const LONG_MESSAGE = "This page's address is too long to save from the bookmarklet.";

/**
 * The Save page (#129), which the bookmarklet opens in a new tab. It is the page's Save dialog
 * (#329), open at load and filled only from the page's own query, never from the owner's data,
 * escaped into attribute values; it writes nothing, and its Save posts to `POST /save`. Behind the
 * dialog is the menu and a heading. `long` shows the long-address message instead, with the dialog
 * closed and empty. It has no Ask AI, which would put the owner's id on a page any site can open.
 */
export const saveForm = ({ url, title, long }: { url: string; title: string; long: boolean }) =>
  page(
    "Save a link · Aye-AI-AI Links",
    `<main class="save">
<h1>Save a link</h1>${long ? `\n<p>${escapeHtml(LONG_MESSAGE)}</p>` : ""}
</main>`,
    { menu: true, ...(long ? {} : { saveFill: { url, title } }) },
  );
