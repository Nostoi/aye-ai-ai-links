import type { PictureInfo } from "../core/image-store.js";
import { MAX_IMAGE_BYTES } from "../core/image-type.js";
import { TITLE_MAX } from "../core/links.js";
import type { Link } from "../core/types.js";
import { cardMenu, type MenuItem } from "./card-menu.js";
import { initialsText } from "./initials.js";
import { escapeHtml } from "./page.js";

export const PENCIL = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>`;

/** The cards' one menu row, which opens the edit dialog. */
export const EDIT_ITEM: MenuItem = { act: "edit", icon: PENCIL, text: "Edit title and picture…" };

/** A card's ⋯ menu on the pages with the edit dialog. */
export const editMenu = (link: Link) => cardMenu(`More for ${link.title ?? link.url}`, [EDIT_ITEM]);

/**
 * What the edit dialog reads from a card, as data attributes: the title ("" for none), the page's
 * own title, the version of the picture that shows, whether it is the owner's, the fetched
 * picture's version, and the initials a picture-less preview shows. The one helper for every
 * card builder.
 */
export function editData(
  link: Link,
  version: string | undefined,
  info: PictureInfo | undefined,
): string {
  const page = link.snapshot?.title ?? "";
  const data: [string, string][] = [
    ["title", link.title ?? ""],
    ["page-title", [...page.trim()].length > TITLE_MAX ? "" : page],
    ["version", version ?? ""],
    ["own", info?.own ? "1" : "0"],
    ["page-version", info?.pageVersion ?? ""],
    ["initials", initialsText(link)],
  ];
  return data.map(([name, value]) => ` data-${name}="${escapeHtml(value)}"`).join("");
}

const CLOSE = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const PICTURE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.75"/><path d="M20.5 16l-5-5-8.5 8.5"/></svg>`;

/**
 * The edit dialog, once per page with the card menu. It is filled from the card it opens on, by
 * `editLinkScript`. On a phone the theme makes it a bottom sheet: Cancel and Save move to the top
 * bar, and the close button and the paste hint are hidden.
 */
export const editDialog =
  () => `<dialog class="edit-link" id="edit-link" aria-labelledby="edit-link-title">
<form class="edit-form" novalidate>
<div class="edit-grabber" aria-hidden="true"></div>
<div class="edit-head">
<button type="button" class="edit-top" data-edit="cancel">Cancel</button>
<h2 id="edit-link-title">Edit link</h2>
<button type="submit" class="edit-top edit-top-save" data-edit="save">Save</button>
<button type="button" class="edit-close" data-edit="cancel">${CLOSE}<span class="visually-hidden">Close</span></button>
</div>
<label for="edit-title">Title</label>
<input id="edit-title" class="edit-title" name="title" autocomplete="off">
<p class="edit-page-title" hidden><span>Page's title: “<span data-page-title></span>”</span><button type="button" class="edit-use" data-edit="use-title">Use it</button></p>
<fieldset class="edit-picture">
<legend>Picture</legend>
<div class="edit-picture-row">
<div class="edit-preview"><span class="edit-chip" hidden></span></div>
<div class="edit-picture-actions">
<button type="button" class="edit-choose" data-edit="choose">${PICTURE}Choose a picture…</button>
<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-edit="file" hidden>
<button type="button" class="edit-remove" data-edit="remove" hidden>Remove picture</button>
<p class="edit-hint">Or paste a screenshot (⌘V), or drop a picture here.</p>
<p class="edit-hint-phone">Opens Photos, Files or the camera.</p>
</div>
</div>
<p class="edit-types">PNG, JPEG, GIF or WebP. Big pictures are shrunk to fit.</p>
</fieldset>
<p class="edit-error" id="edit-error" role="alert"></p>
<div class="edit-foot">
<button type="button" data-edit="cancel">Cancel</button>
<button type="submit" class="primary" data-edit="save">Save</button>
</div>
</form>
</dialog>`;

/** The longest side a picture is sent at, unless it is already a kept type under the cap. */
export const SHRINK_SIDE = 1600;

/**
 * The edit dialog's script, for the cards inside `#root`, including those Show older links
 * appends. A block for the page's one script after `CARD_FETCH` (it needs `post`, `failure` and
 * `showUndo`).
 * - The card's menu opens the dialog, filled from the card's data attributes (`editData`).
 * - A picked, pasted or dropped picture is sent as chosen when it is one of the four types, at most
 *   2 MiB and at most SHRINK_SIDE px on its longest side. Otherwise it is re-encoded as WebP (or
 *   whatever kept type the browser gives) at most SHRINK_SIDE px, stepping down until it fits. The
 *   latest pick wins (`pickTurn`); Save waits while one is prepared.
 * - Save sends only what changed, as a form. The card shows the server's answer, not what was
 *   sent, and Undo shows its own answer. A refusal stays in the dialog; an Undo that does not
 *   succeed (such as a conflict) shows in `#error`, the page's alert, as Keep handy's Undo does.
 *   Save stays off until its answer comes. An answer that comes after the dialog closed or reopened
 *   still updates its own card and offers Undo, but leaves the dialog alone; a refusal that comes then
 *   shows in the page's alert.
 * - Focus goes back to the card's ⋯ when the dialog closes.
 */
export const editLinkScript = (root: string, error: string) => `{
const editRoot = document.getElementById(${JSON.stringify(root)});
const editAlert = document.getElementById(${JSON.stringify(error)});
const dialog = document.getElementById("edit-link");
if (editRoot && dialog) {
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const form = dialog.querySelector("form");
const titleField = dialog.querySelector("#edit-title");
const pageLine = dialog.querySelector(".edit-page-title");
const pageTitle = pageLine.querySelector("[data-page-title]");
const preview = dialog.querySelector(".edit-preview");
const chip = preview.querySelector(".edit-chip");
const chooseButton = dialog.querySelector("[data-edit=choose]");
const fileField = dialog.querySelector("[data-edit=file]");
const removeButton = dialog.querySelector("[data-edit=remove]");
const useTitle = dialog.querySelector("[data-edit=use-title]");
const editError = dialog.querySelector("#edit-error");
const saves = [...dialog.querySelectorAll("[data-edit=save]")];
let card = null;
let opener = null;
let openedTitle = "";
let picture = null;
let pickUrl = null;
let pickTurn = 0;
let dragDepth = 0;
// Save is off while a pick is prepared or a Save is answered. saveTurn moves on each open and
// close, so a Save answered later updates only its own card.
let preparing = false;
let saving = false;
let saveTurn = 0;
const syncBusy = () => {
  for (const b of saves) b.disabled = preparing || saving;
  for (const c of [titleField, chooseButton, removeButton, useTitle]) c.disabled = saving;
};
const imageUrl = (id, version, page) =>
  "/images/" + encodeURIComponent(id) + "?" + (page ? "page=1&" : "") + "v=" + encodeURIComponent(version);
const dropPick = () => {
  pickTurn++;
  preparing = false;
  if (pickUrl) URL.revokeObjectURL(pickUrl);
  pickUrl = null;
};
const render = (note) => {
  const d = card.dataset;
  const own = d.own === "1";
  let src = null;
  if (picture && picture.kind === "file") src = pickUrl;
  else if (picture && picture.kind === "page") src = d.pageVersion ? imageUrl(d.id, d.pageVersion, true) : null;
  else if (d.version) src = imageUrl(d.id, d.version, false);
  for (const old of preview.querySelectorAll("img, .edit-initials")) old.remove();
  if (src) {
    const img = document.createElement("img");
    img.setAttribute("src", src);
    img.setAttribute("alt", "");
    preview.prepend(img);
  } else if (d.initials) {
    const initials = document.createElement("span");
    initials.className = "edit-initials";
    initials.setAttribute("aria-hidden", "true");
    initials.textContent = d.initials;
    preview.prepend(initials);
  }
  const words = note || (picture && picture.kind === "file" ? ${JSON.stringify("New · not saved yet")} : "");
  chip.textContent = words;
  chip.hidden = words === "";
  removeButton.hidden = !((picture && picture.kind === "file") || (!picture && own));
  removeButton.textContent = (own ? d.pageVersion : d.version) ? "Use the page's picture" : "Remove picture";
};
const shrink = async (file) => {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return null;
    const side = Math.max(width, height);
    if (TYPES.includes(file.type) && file.size <= ${MAX_IMAGE_BYTES} && side <= ${SHRINK_SIDE}) return file;
    let scale = Math.min(1, ${SHRINK_SIDE} / side);
    for (let step = 0; step < 8; step++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((done) => canvas.toBlob(done, "image/webp", 0.85));
      if (blob && TYPES.includes(blob.type) && blob.size <= ${MAX_IMAGE_BYTES}) return blob;
      scale *= 0.8;
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
};
const pick = async (file) => {
  if (!file || !card) return;
  const turn = ++pickTurn;
  editError.textContent = "";
  preparing = true;
  syncBusy();
  render(${JSON.stringify("Preparing…")});
  const ready = await shrink(file);
  if (turn !== pickTurn) return;
  preparing = false;
  syncBusy();
  if (!ready) {
    render();
    editError.textContent = ${JSON.stringify("That file can't be opened as a picture. Try a PNG, JPEG, GIF or WebP.")};
    return;
  }
  if (pickUrl) URL.revokeObjectURL(pickUrl);
  pickUrl = URL.createObjectURL(ready);
  picture = { kind: "file", blob: ready };
  render();
};
const showCard = (target, answer) => {
  const d = target.dataset;
  d.title = answer.title === null ? "" : answer.title;
  d.version = answer.version === null ? "" : answer.version;
  d.own = answer.picture.own ? "1" : "0";
  d.pageVersion = answer.picture.pageVersion === null ? "" : answer.picture.pageVersion;
  d.initials = answer.initials;
  const label = answer.title === null ? answer.url : answer.title;
  const heading = target.querySelector(".result-body h2, .card-body h3");
  (heading.querySelector("a") || heading).textContent = label;
  const named = target.querySelector(".card-menu summary .visually-hidden");
  if (named) named.textContent = "More for " + label;
  const tile = target.querySelector(".tile, .card-image");
  const next = document.createElement(answer.version ? "img" : "div");
  next.className = tile.getAttribute("class");
  if (answer.version) {
    next.setAttribute("src", imageUrl(d.id, answer.version, false));
    next.setAttribute("alt", "");
    next.setAttribute("loading", "lazy");
  } else next.setAttribute("aria-hidden", "true");
  tile.replaceWith(next);
};
const giveFocusBack = () => {
  if (opener && opener.isConnected) opener.focus();
};
const finish = () => {
  dropPick();
  dialog.close();
  giveFocusBack();
};
const open = (from, menu) => {
  card = from;
  opener = menu.querySelector("summary");
  saveTurn++;
  saving = false;
  dropPick();
  picture = null;
  dragDepth = 0;
  const d = card.dataset;
  titleField.value = d.title;
  openedTitle = titleField.value;
  const page = d.pageTitle.trim();
  pageTitle.textContent = page;
  pageLine.hidden = page === "" || page === d.title.trim();
  preview.className = ["edit-preview", ...[...card.classList].filter((c) => c.startsWith("space-"))].join(" ");
  editError.textContent = "";
  syncBusy();
  render();
  dialog.showModal();
  titleField.focus();
};
editRoot.addEventListener("click", (event) => {
  const item = event.target.closest(".card-menu button[data-act=edit]");
  if (!item) return;
  const menu = item.closest("details");
  menu.open = false;
  open(item.closest("[data-id]"), menu);
});
// Esc closes the dialog natively; focus goes back to the ⋯ unless something else already took it.
dialog.addEventListener("close", () => {
  saveTurn++;
  saving = false;
  dropPick();
  syncBusy();
  const now = document.activeElement;
  if (!now || now === document.body || dialog.contains(now)) giveFocusBack();
});
for (const b of dialog.querySelectorAll("[data-edit=cancel]")) b.addEventListener("click", finish);
useTitle.addEventListener("click", () => {
  titleField.value = pageTitle.textContent;
  titleField.focus();
});
chooseButton.addEventListener("click", () => fileField.click());
fileField.addEventListener("change", () => {
  const file = fileField.files && fileField.files[0];
  fileField.value = "";
  pick(file);
});
removeButton.addEventListener("click", () => {
  const own = card.dataset.own === "1";
  dropPick();
  syncBusy();
  picture = own ? { kind: "page" } : null;
  editError.textContent = "";
  render();
  chooseButton.focus();
});
dialog.addEventListener("paste", (event) => {
  if (saving) return;
  if (event.target === titleField && [...(event.clipboardData?.types || [])].includes("text/plain")) return;
  const files = event.clipboardData ? [...event.clipboardData.files] : [];
  const file = files.find((f) => f.type.startsWith("image/"));
  if (!file) return;
  event.preventDefault();
  pick(file);
});
const hasFiles = (event) => !!event.dataTransfer && [...event.dataTransfer.types].includes("Files");
dialog.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  preview.classList.add("dropping");
  render(${JSON.stringify("Drop to use this picture")});
});
dialog.addEventListener("dragover", (event) => {
  if (hasFiles(event)) event.preventDefault();
});
dialog.addEventListener("dragleave", (event) => {
  if (!hasFiles(event) || dragDepth === 0) return;
  dragDepth -= 1;
  if (dragDepth > 0) return;
  preview.classList.remove("dropping");
  render();
});
dialog.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  preview.classList.remove("dropping");
  render();
  if (!saving) pick(event.dataTransfer.files[0]);
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saves[0].disabled) return;
  const body = new FormData();
  body.append("id", card.dataset.id);
  let changed = false;
  if (titleField.value !== openedTitle) {
    body.append("title", titleField.value);
    changed = true;
  }
  if (picture) {
    if (picture.kind === "file") body.append("picture", picture.blob, "picture");
    else body.append("picture", "page");
    changed = true;
  }
  if (!changed) return finish();
  editError.textContent = "";
  editAlert.textContent = "";
  const target = card;
  const turn = ++saveTurn;
  saving = true;
  syncBusy();
  const res = await fetch("/links/edit", { method: "POST", body, redirect: "manual" }).catch(() => null);
  const answer = res && res.status === 200 ? await res.json().catch(() => null) : null;
  const refused = answer ? "" : await failure(res);
  // Closed or reopened since: the dialog is no longer this Save's.
  const current = turn === saveTurn;
  if (current) {
    saving = false;
    syncBusy();
  }
  if (!answer) {
    if (current) editError.textContent = refused;
    else editAlert.textContent = refused;
    return;
  }
  showCard(target, answer);
  if (current) finish();
  if (!answer.editId) return;
  showUndo(${JSON.stringify("Link updated")}, async () => {
    const back = await post("/links/edit/undo", { id: target.dataset.id, editId: answer.editId });
    const undone = back && back.status === 200 ? await back.json().catch(() => null) : null;
    if (undone) showCard(target, undone);
    else editAlert.textContent = await failure(back);
  });
});
}
}`;
