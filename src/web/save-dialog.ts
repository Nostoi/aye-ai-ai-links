import { SAVE_PATH } from "../auth/login-return.js";
import { escapeHtml } from "../core/escape-html.js";
import { BRING_BACK_WORKING, DONE_MARKER, PUT_AWAY_MARKER } from "./done-link.js";
import { hostOf } from "./host.js";
import { CARD_FETCH, WHY_LABEL } from "./tell-why.js";

/** What the dialog says when Save was sent to sign in (#329, from the approved mockup). */
export const SIGNED_OUT =
  "You were signed out. Sign in in another tab, then press Save again. What you typed is still here.";

/** What the dialog says when the server could not be reached at all. */
export const OFFLINE =
  "Couldn't reach Aye-AI-AI Links. Check your connection, then press Save again. Nothing was saved.";

/** What the Save button says while its answer is more than 300ms away. */
export const SAVING_WORKING = "Saving…";

/** How long the Save button shows its tick before the dialog closes, unless motion is reduced. */
const TICK_MS = 450;

const CLOSE = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const TICK = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>`;

/** The letter the small square at the start of Address shows: the site's first letter. */
const siteLetter = (host: string) =>
  host
    .replace(/^www\./, "")
    .charAt(0)
    .toUpperCase();

/**
 * The Save dialog (#329), once on every page with the menu, as a body child. Its markup is the edit
 * dialog's (`edit-link`, its head, its phone sheet and its foot) with the save form inside. `fill`
 * is the `/save` page's query: it fills Address and Title, escaped into attribute values, and marks
 * the dialog `data-page`, which the script reads to open it at load and to show a save in place.
 * Every busy label is a `<b>`, so `busyLook` can say the working word beside the tick icon.
 */
export const saveDialog = (fill?: { url: string; title: string }) => {
  const url = fill?.url ?? "";
  const host = hostOf(url);
  return `<dialog class="edit-link save-dialog" id="save-dialog" aria-labelledby="save-dialog-title"${fill ? " data-page" : ""}>
<form class="save-form" novalidate>
<div class="edit-grabber" aria-hidden="true"></div>
<div class="edit-head">
<button type="button" class="edit-top" data-save="cancel">Cancel</button>
<h2 id="save-dialog-title">Save a link</h2>
<button type="submit" class="edit-top edit-top-save" data-save="save">${TICK}<b>Save</b></button>
<button type="button" class="edit-close" data-save="cancel">${CLOSE}<span class="visually-hidden">Close</span></button>
</div>
<div class="save-fields" data-save-part="fields">
<label for="save-url">Address</label>
<div class="save-address"><span class="save-letter" aria-hidden="true">${escapeHtml(siteLetter(host))}</span><input id="save-url" name="url" type="url" autocomplete="off" placeholder="Paste a link" value="${escapeHtml(url)}"></div>
<p class="small save-host"${host ? "" : " hidden"}>${host ? `Saving a page from ${escapeHtml(host)}` : ""}</p>
<p class="save-field-error save-url-error" id="url-error" role="alert"></p>
<label for="save-title">Title <span class="save-optional">(optional)</span></label>
<input id="save-title" name="title" autocomplete="off" value="${escapeHtml(fill?.title ?? "")}">
<p class="save-field-error" id="title-error" role="alert"></p>
<label for="save-why">Why are you saving it? <span class="save-optional">(optional)</span></label>
<textarea id="save-why" name="why" rows="3"></textarea>
</div>
<div class="save-found" data-save-part="found" hidden>
<div class="save-found-card"><span class="save-found-pic" aria-hidden="true"></span><div><span class="save-found-title"></span><span class="save-found-line"></span></div></div>
<p class="save-found-why" hidden></p>
<p class="save-kept" hidden></p>
<div class="save-found-acts">
<button type="button" data-save="bring-back" hidden>Bring it back</button>
<a class="button primary" data-save="open">Open it</a>
<button type="button" class="primary" data-save="close" hidden>Close</button>
</div>
</div>
<p class="edit-error" id="save-error" role="alert"></p>
<div class="edit-foot">
<button type="button" data-save="cancel">Cancel</button>
<button type="submit" class="primary" data-save="save">${TICK}<b>Save</b></button>
</div>
</form>
</dialog>`;
};

/**
 * The Save dialog's script, a block with its own `CARD_FETCH`, so its names stay clear of the
 * page's. It needs `showUndo` (`page()` gives every menu page the Undo bar) and `#page-alert`.
 * - A plain click on the bar's Save pill or the phone menu's Save opens the dialog, closing that
 *   menu; a modified or middle click opens `/save` as a link. The cursor goes to Address; on close,
 *   focus goes back to the pill or the menu's summary.
 * - Cancel, Escape and a click on the backdrop close it, except while a Save is out. What was typed
 *   stays until a save or an "already saved" answer, after which it reopens empty.
 * - Save posts `/save` through `whileBusy` (the busy look dims the form and says Saving…). A new
 *   link closes the dialog after its tick, then the Undo bar offers Undo, which posts
 *   `/links/delete`; a failed Undo shows in `#page-alert`. On the `/save` page (`data-page`) the
 *   save shows in place, with Close, which closes the tab or goes Home.
 * - An address already saved shows that link in the dialog: its line, its why, Open it (recorded as
 *   an opening) and, for a link done or put away, Bring it back, which works in place.
 * - A refusal shows under its field; a sign-out, no answer or any other failure in the dialog's
 *   alert. What was typed is kept.
 * - An answer that comes after the dialog was closed (Chrome closes a modal on a second Escape)
 *   still offers a new link's Undo, and a refusal then waits in the alert for the next open.
 */
const SAVE_DIALOG_JS = `{
${CARD_FETCH}
const dialog = document.getElementById("save-dialog");
if (dialog) {
const q = (selector) => dialog.querySelector(selector);
const form = q("form");
const urlField = q("#save-url");
const titleField = q("#save-title");
const whyField = q("#save-why");
const letter = q(".save-letter");
const hostLine = q(".save-host");
const urlError = q("#url-error");
const titleError = q("#title-error");
const saveError = q("#save-error");
const heading = q("#save-dialog-title");
const fields = q("[data-save-part=fields]");
const found = q("[data-save-part=found]");
const foundPic = q(".save-found-pic");
const foundTitle = q(".save-found-title");
const foundLine = q(".save-found-line");
const foundWhy = q(".save-found-why");
const kept = q(".save-kept");
const bringBack = q("[data-save=bring-back]");
const openIt = q("[data-save=open]");
const closeIt = q("[data-save=close]");
const foot = q(".edit-foot");
const topCancel = q(".edit-top[data-save=cancel]");
const topSave = q(".edit-top[data-save=save]");
const primary = q(".edit-foot [data-save=save]");
const saves = [topSave, primary];
const pageAlert = document.getElementById("page-alert");
const onPage = dialog.hasAttribute("data-page");
const HEADING = ${JSON.stringify("Save a link")};
let opener = null;
let saving = false;
// answered: the dialog shows an answer, so it empties when it closes. turn moves on each close, so
// an answer that comes later knows the dialog is no longer its own.
let answered = false;
let turn = 0;
let heldUndo = null;
let downOnBackdrop = false;
let shown = null;
const media = (query) => typeof matchMedia === "function" && matchMedia(query).matches;
const hostName = (value) => {
  const parsed = URL.parse(value.trim());
  return parsed && (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.hostname : "";
};
const showHost = () => {
  const host = hostName(urlField.value);
  hostLine.textContent = host ? "Saving a page from " + host : "";
  hostLine.hidden = host === "";
  letter.textContent = host.replace(/^www\\./, "").charAt(0).toUpperCase();
};
const setLabel = (text) => {
  for (const b of saves) b.querySelector("b").textContent = text;
};
const show = (part) => {
  const asking = part === "fields";
  fields.hidden = !asking;
  found.hidden = asking;
  foot.hidden = !asking;
  topSave.hidden = !asking;
  topCancel.textContent = asking ? "Cancel" : "Close";
};
const reset = () => {
  urlField.value = "";
  titleField.value = "";
  whyField.value = "";
  for (const e of [urlError, titleError, saveError]) e.textContent = "";
  heading.textContent = HEADING;
  dialog.removeAttribute("data-saved");
  setLabel("Save");
  showHost();
  show("fields");
  // Only a shown answer is a link: other scripts read [data-id] and a[target=_blank] as cards.
  found.removeAttribute("data-id");
  for (const name of ["href", "target", "rel", "data-open"]) openIt.removeAttribute(name);
  answered = false;
};
const giveFocusBack = () => {
  if (opener && opener.isConnected) opener.focus();
};
const open = () => {
  dialog.showModal();
  urlField.focus();
};
const closeNow = () => {
  if (!saving && dialog.open) dialog.close();
};
document.addEventListener("click", (event) => {
  const link = event.target.closest && event.target.closest('nav.menu a[href=${JSON.stringify(SAVE_PATH)}]');
  if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const menu = link.closest("details");
  if (menu) menu.removeAttribute("open");
  opener = menu ? menu.querySelector("summary") : link;
  if (!dialog.open) open();
});
dialog.addEventListener("close", () => {
  turn++;
  const now = document.activeElement;
  if (!now || now === document.body || dialog.contains(now)) giveFocusBack();
  if (answered) reset();
  const held = heldUndo;
  heldUndo = null;
  if (held) held();
});
dialog.addEventListener("cancel", (event) => {
  if (saving) event.preventDefault();
});
// A click whose press and release were both on the dialog itself is on the backdrop: the dialog
// has no padding of its own, so its form covers the whole box.
dialog.addEventListener("pointerdown", (event) => {
  downOnBackdrop = event.target === dialog;
});
dialog.addEventListener("click", (event) => {
  const backdrop = event.target === dialog && downOnBackdrop;
  downOnBackdrop = false;
  if (backdrop) closeNow();
});
for (const b of dialog.querySelectorAll("[data-save=cancel]")) b.addEventListener("click", closeNow);
urlField.addEventListener("input", showHost);
const drawLine = (data, marker) => {
  const parts = [data.created ? "" : "Already saved on " + data.savedOn, hostName(data.url), marker];
  foundLine.textContent = parts.filter(Boolean).join(" · ");
};
const showFound = (data, typedWhy) => {
  answered = true;
  shown = data;
  found.setAttribute("data-id", data.id);
  foundPic.textContent = data.initials || "";
  foundTitle.textContent = data.title || data.url;
  const marker = data.state === "archived" ? (data.putAwayAt ? ${JSON.stringify(PUT_AWAY_MARKER)} : ${JSON.stringify(DONE_MARKER)}) : "";
  drawLine(data, marker);
  foundWhy.replaceChildren();
  if (data.why && data.whySource === "inferred") foundWhy.append("Why (a guess): " + data.why);
  else if (data.why) {
    const label = document.createElement("span");
    label.className = "why-label";
    label.textContent = ${JSON.stringify(WHY_LABEL)};
    foundWhy.append(label, data.why);
  }
  foundWhy.hidden = !data.why;
  kept.textContent = data.whyKept ? "" : "It already had a reason, so yours wasn't saved: “" + typedWhy + "”";
  kept.hidden = data.whyKept;
  bringBack.hidden = data.state !== "archived";
  if (!data.created) {
    openIt.setAttribute("href", data.url);
    openIt.setAttribute("target", "_blank");
    openIt.setAttribute("rel", "noopener noreferrer");
    openIt.setAttribute("data-open", "");
  }
  openIt.hidden = data.created;
  closeIt.hidden = !data.created;
  heading.textContent = data.created ? "Saved" : HEADING;
  if (data.created) dialog.setAttribute("data-saved", "");
  show("found");
  if (onPage) history.replaceState(null, "", ${JSON.stringify(SAVE_PATH)});
};
// A new link: the tick, then the dialog closes and the Undo bar offers Undo once focus is back.
const savedNew = async (data, ticket, mine) => {
  const name = data.title || hostName(data.url) || data.url;
  const offer = () =>
    showUndo(ticket, "Saved “" + name + "”.", async () => {
      const res = await post("/links/delete", { id: data.id });
      if ((!res || res.status !== 204) && pageAlert) pageAlert.textContent = await failure(res);
    });
  if (mine !== turn || !dialog.open) {
    if (!dialog.open) reset();
    offer();
    return;
  }
  answered = true;
  setLabel("Saved");
  dialog.setAttribute("data-saved", "");
  heldUndo = offer;
  if (!media("(prefers-reduced-motion: reduce)")) await new Promise((done) => setTimeout(done, ${TICK_MS}));
  if (mine === turn && dialog.open) dialog.close();
};
const refuse = async (res) => {
  if (!res) {
    saveError.textContent = ${JSON.stringify(OFFLINE)};
    return;
  }
  if (res.type === "opaqueredirect" || res.status === 0) {
    saveError.textContent = ${JSON.stringify(SIGNED_OUT)};
    return;
  }
  const refused = res.status === 400 ? await res.json().catch(() => null) : null;
  const where =
    refused && refused.code === "invalid_url" ? urlError : refused && refused.code === "invalid_input" ? titleError : saveError;
  where.textContent = refused && typeof refused.message === "string" ? refused.message : await failure(res);
};
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (fields.hidden) return;
  const button = saves.includes(event.submitter) ? event.submitter : media("(max-width: 600px)") ? topSave : primary;
  whileBusy(
    form,
    async (answer, ticket) => {
      const mine = turn;
      const typedWhy = whyField.value;
      saving = true;
      for (const e of [urlError, titleError, saveError]) e.textContent = "";
      if (pageAlert) pageAlert.textContent = "";
      try {
        const res = await post(${JSON.stringify(SAVE_PATH)}, { url: urlField.value, title: titleField.value, why: typedWhy });
        answer();
        const data = res && res.status === 200 ? await res.json().catch(() => null) : null;
        if (!data || typeof data.id !== "string" || typeof data.created !== "boolean") return await refuse(res);
        if (data.created && !onPage) return await savedNew(data, ticket, mine);
        if (mine === turn) showFound(data, typedWhy);
      } finally {
        saving = false;
      }
    },
    { button, word: ${JSON.stringify(SAVING_WORKING)}, el: form },
  );
});
bringBack.addEventListener("click", () =>
  whileBusy(
    found,
    async (answer) => {
      saveError.textContent = "";
      const res = await post("/home/bring-back", { id: found.dataset.id });
      answer();
      if (res && res.status === 200) {
        heading.textContent = "Brought back";
        bringBack.hidden = true;
        drawLine(shown, "");
      } else saveError.textContent = await failure(res);
    },
    { button: bringBack, word: ${JSON.stringify(BRING_BACK_WORKING)} },
  ),
);
closeIt.addEventListener("click", () => {
  window.close();
  if (window.closed) return;
  location.assign("/");
});
if (onPage) open();
}
}`;

/** The dialog's script; `page()` writes it with `openedScript` for `#save-dialog` after it. */
export const saveDialogScript = SAVE_DIALOG_JS;
