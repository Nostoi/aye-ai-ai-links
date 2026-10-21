import { SAVE_PATH } from "../auth/login-return.js";
import { PUT_AWAY_MARKER, STALE_MARKER } from "./done-link.js";
import { hostOf } from "./host.js";
import { openedScript } from "./open-link.js";
import { escapeHtml, page } from "./page.js";
import { CARD_FETCH } from "./tell-why.js";

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
<p class="small" id="saved-state" hidden></p>
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
 * Save posts the form to `POST /save` without following a redirect. An answer replaces the form:
 * Saved; or Already saved on its date, with the link opening in a new tab (its opening recorded by
 * `openedScript`), its why, and Bring it back when it is archived. Once there is an answer the
 * address bar is cleaned to `/save`, so a reload shows an empty form; before that the query stays,
 * so a reload after a sign-out refills the form. A refusal is shown under its field. Close closes
 * the tab, or says it can be closed when the browser keeps it open. Needs `CARD_FETCH`.
 */
const SAVE_SCRIPT = `<script>
${CARD_FETCH}
{
const form = document.getElementById("save-form");
const urlField = document.getElementById("save-url");
const hostLine = document.getElementById("save-host");
const titleField = document.getElementById("save-title");
const whyField = document.getElementById("save-why");
const urlError = document.getElementById("url-error");
const titleError = document.getElementById("title-error");
const saveError = document.getElementById("save-error");
const heading = document.getElementById("save-heading");
const result = document.getElementById("result");
const savedLink = document.getElementById("saved-link");
const anchor = savedLink.querySelector("a");
const savedWhy = document.getElementById("saved-why");
const whyKept = document.getElementById("why-kept");
const savedState = document.getElementById("saved-state");
const bringBack = document.getElementById("bring-back");
const closeButton = document.getElementById("close");
const closeNote = document.getElementById("close-note");
const resultError = document.getElementById("result-error");

urlField.addEventListener("input", () => {
  const parsed = URL.parse(urlField.value.trim());
  const name = parsed ? parsed.hostname : "";
  hostLine.textContent = name ? "Saving a page from " + name : "";
  hostLine.hidden = name === "";
});

const show = (data) => {
  heading.textContent = data.created ? "Saved" : "Already saved on " + data.savedOn;
  if (!data.created) {
    savedLink.dataset.id = data.id;
    anchor.setAttribute("href", data.url);
    anchor.textContent = data.title || data.url;
    savedLink.hidden = false;
    if (data.whyKept) {
      savedWhy.textContent = data.why ? "Why: " + data.why : "";
      savedWhy.hidden = !data.why;
    } else {
      whyKept.textContent = "It already had a reason, so yours wasn't saved: “" + data.why + "”";
      whyKept.hidden = false;
    }
    bringBack.hidden = data.state !== "archived";
    savedState.textContent = data.putAwayAt ? ${JSON.stringify(PUT_AWAY_MARKER)} : ${JSON.stringify(STALE_MARKER)};
    savedState.hidden = bringBack.hidden;
  }
  form.hidden = true;
  result.hidden = false;
  history.replaceState(null, "", ${JSON.stringify(SAVE_PATH)});
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector("button[type=submit]");
  if (submit.disabled) return;
  urlError.textContent = "";
  titleError.textContent = "";
  saveError.textContent = "";
  submit.disabled = true;
  const res = await post(${JSON.stringify(SAVE_PATH)}, {
    url: urlField.value,
    title: titleField.value,
    why: whyField.value,
  });
  const data = res && res.status === 200 ? await res.json().catch(() => null) : null;
  submit.disabled = false;
  if (data && typeof data.id === "string" && typeof data.created === "boolean") {
    show(data);
    return;
  }
  if (res && (res.type === "opaqueredirect" || res.status === 0)) {
    saveError.textContent = ${JSON.stringify(SIGNED_OUT)};
    return;
  }
  const refused = res && res.status === 400 ? await res.json().catch(() => null) : null;
  const where =
    refused && refused.code === "invalid_url"
      ? urlError
      : refused && refused.code === "invalid_input"
        ? titleError
        : saveError;
  where.textContent =
    refused && typeof refused.message === "string" ? refused.message : await failure(res);
});

bringBack.addEventListener("click", () =>
  whileBusy(bringBack, async () => {
    resultError.textContent = "";
    const res = await post("/home/bring-back", { id: savedLink.dataset.id });
    if (res && res.status === 200) {
      heading.textContent = "Back in your list";
      bringBack.hidden = true;
      savedState.hidden = true;
    } else {
      resultError.textContent = await failure(res);
    }
  }),
);

closeButton.addEventListener("click", () => {
  window.close();
  if (window.closed) return;
  closeButton.hidden = true;
  closeNote.hidden = false;
});
}
</script>`;

/**
 * The Save page (#129). It is filled only from its own query, never from the owner's data, and
 * it writes nothing; Save posts the form to `POST /save`. Every value is escaped into an
 * attribute or element text, never into a script. `long` shows the long-address message and no
 * form. A bare page is an ordinary "add a link" form.
 */
export const saveForm = ({ url, title, long }: { url: string; title: string; long: boolean }) =>
  page(
    "Save a link · Aye-AI-AI Links",
    long
      ? longBody
      : `${formBody(url, title)}\n${SAVE_SCRIPT}\n${openedScript("result", "/links/opened")}`,
    { home: true },
  );
