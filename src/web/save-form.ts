import { hostOf } from "./host.js";
import { escapeHtml, page } from "./page.js";

/** What the Save page says when the bookmarklet found the page's address too long to send. */
export const LONG_MESSAGE = "This page's address is too long to save from the bookmarklet.";

/** What the Save page says when Save was sent to sign in: the query is still in the address bar. */
export const SIGNED_OUT = "You were signed out. Reload this page to sign in and come back.";

/** The address's host, in plain text under the field, so a changed address is visible. */
const hostLine = (url: string) => {
  const host = hostOf(url);
  return host
    ? `<p class="small" id="save-host">Saving a page from ${escapeHtml(host)}</p>`
    : `<p class="small" id="save-host" hidden></p>`;
};

const formBody = (url: string, title: string) => `<main class="save">
<h1 id="save-heading">Save a link</h1>
<form class="save-form" id="save-form">
<label for="save-url">Address</label>
<input id="save-url" name="url" type="url" required autocomplete="off" value="${escapeHtml(url)}">
${hostLine(url)}
<p id="url-error" role="alert"></p>
<label for="save-title">Title</label>
<input id="save-title" name="title" autocomplete="off" value="${escapeHtml(title)}">
<p id="title-error" role="alert"></p>
<label for="save-why">Why are you saving it? (optional)</label>
<textarea id="save-why" name="why" rows="3"></textarea>
<p id="save-error" role="alert"></p>
<button class="primary" type="submit">Save</button>
</form>
<section class="save-result" id="result" hidden>
<div id="saved-link" data-id="" hidden>
<p class="save-link-title"><a target="_blank" rel="noopener noreferrer" data-open></a></p>
<p class="small" id="saved-why" hidden></p>
</div>
<p id="why-kept" hidden></p>
<div class="actions">
<button type="button" id="bring-back" hidden>Bring it back</button>
<button class="primary" type="button" id="close">Close</button>
</div>
<p id="close-note" hidden>You can close this tab.</p>
<p id="result-error" role="alert"></p>
</section>
</main>`;

const longBody = `<main class="save">
<h1>Save a link</h1>
<p>${escapeHtml(LONG_MESSAGE)}</p>
</main>`;

/**
 * The Save page (#129). It is filled only from its own query, never from the owner's data, and
 * it writes nothing; Save posts the form to `POST /save`. Every value is escaped into an
 * attribute or element text, never into a script. `long` shows the long-address message and no
 * form. A bare page is an ordinary "add a link" form.
 */
export const saveForm = ({ url, title, long }: { url: string; title: string; long: boolean }) =>
  page("Save a link · Aye-AI-AI Links", long ? longBody : formBody(url, title), { home: true });
