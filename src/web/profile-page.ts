import { WEB_SAVED_BY } from "../auth/session.js";
import type { FocusEntry, ProfileNote } from "../core/types.js";
import type { Ask } from "./ask-panel.js";
import { escapeHtml, page, savedOn } from "./page.js";

/** Who a note came from. A guess says so; a note the owner wrote here is theirs. */
function sourceLine(n: ProfileNote): string {
  const by = escapeHtml(n.writtenBy);
  if (n.source === "inferred") return `A guess by ${by}`;
  if (n.source === "asked") return `You told ${by} when it asked`;
  return n.writtenBy === WEB_SAVED_BY ? "You confirmed this" : `You said this to ${by}`;
}

function noteItem(n: ProfileNote): string {
  const guess = n.source === "inferred";
  const confirm = guess
    ? `<button class="primary confirm" type="button">That's right</button>`
    : "";
  return `<li class="note${guess ? " guess" : ""}" data-note-id="${escapeHtml(n.id)}" data-updated-at="${n.updatedAt.getTime()}"><p class="note-text">${escapeHtml(n.text)}</p><div class="note-meta"><span class="note-source">${sourceLine(n)}</span>${confirm}<button class="link edit" type="button">Edit</button><button class="link remove" type="button">Remove</button></div></li>`;
}

function focusItem(f: FocusEntry, now: Date): string {
  const by = escapeHtml(f.writtenBy);
  const from = f.source === "inferred" ? `a guess by ${by}` : `from ${by}`;
  return `<li><p class="focus-text">${escapeHtml(f.text)}</p><p class="small">${savedOn(f.createdAt, now)}, ${from}</p></li>`;
}

/**
 * What the AIs know about the owner: the notes, each with who it came from, and a read-only
 * "Working on lately" panel of recent focus.
 *
 * The script reads a note's id and version from its data attributes and its text from the page,
 * never from values written into the script. Each POST counts as done only on 204; it fetches
 * with `redirect: "manual"`, so a redirect to `/login` is a failure. A refusal shows the server's
 * own message.
 * - That's right posts `{id, updatedAt, text}` with the text shown; Edit posts the same with the
 *   owner's text; Add note posts `{text}`. Each reloads on success, so the page shows the new
 *   version.
 * - Remove posts `{id, updatedAt}` at once and takes the card out; Undo posts `{id}` to restore
 *   it and puts the card back.
 * - A page restored from the back-forward cache reloads, so it never sends an old version.
 */
export const profilePage = ({
  notes,
  focus,
  now,
  ask,
}: {
  notes: ProfileNote[];
  focus: FocusEntry[];
  now: Date;
  ask?: Ask | undefined;
}) =>
  page(
    "Profile · Aye-AI-AI Links",
    `<main class="profile">
<h1>What your AIs know about you</h1>
<p class="lead">Every AI you connect reads these notes before it guesses why you saved something. Fix anything that's wrong.</p>
<div class="profile-columns">
<section class="profile-notes" aria-labelledby="notes-heading">
<h2 id="notes-heading">Notes</h2>
${notes.length === 0 ? `<p id="no-notes">No notes yet. Your AIs add them as they learn about you.</p>` : ""}
<ul class="notes" id="notes">
${notes.map(noteItem).join("\n")}
</ul>
<form class="key-form" id="add-note">
<label class="visually-hidden" for="note-text">Add a note</label>
<input id="note-text" name="text" autocomplete="off" required placeholder="Add something your AIs should know">
<button class="primary" type="submit">Add note</button>
</form>
<p id="notes-error" role="alert"></p>
</section>
<section class="focus-panel" aria-labelledby="focus-heading">
<h2 id="focus-heading">Working on lately</h2>
<p class="small">Your AIs add a line when you mention what you're doing. It picks what's worth a look.</p>
${focus.length === 0 ? "<p>Nothing yet.</p>" : `<ol class="focus-list">\n${focus.map((f) => focusItem(f, now)).join("\n")}\n</ol>`}
</section>
</div>
</main>
<script>
const list = document.getElementById("notes");
const error = document.getElementById("notes-error");
const form = document.getElementById("add-note");
const field = document.getElementById("note-text");

const post = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  }).catch(() => null);

/** The server's own message for a refusal, else a generic one. */
const failure = async (res) => {
  const data = res && [400, 404, 409].includes(res.status) ? await res.json().catch(() => null) : null;
  return data && typeof data.message === "string"
    ? data.message
    : "That did not work. Reload the page and try again.";
};

/** Posts, then reloads on success or shows why not. */
const postAndReload = async (button, url, body) => {
  error.textContent = "";
  button.disabled = true;
  const res = await post(url, body);
  if (res && res.status === 204) return location.reload();
  button.disabled = false;
  error.textContent = await failure(res);
};

const version = (card) => ({ id: card.dataset.noteId, updatedAt: Number(card.dataset.updatedAt) });

const startEdit = (card) => {
  if (card.querySelector("form")) return;
  const text = card.querySelector(".note-text");
  const meta = card.querySelector(".note-meta");
  const edit = document.createElement("form");
  edit.className = "note-edit";
  const box = document.createElement("textarea");
  box.setAttribute("aria-label", "Note");
  box.rows = 3;
  box.required = true;
  box.value = text.textContent;
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(save, cancel);
  edit.append(box, actions);
  text.hidden = true;
  meta.hidden = true;
  card.append(edit);
  box.focus();
  cancel.addEventListener("click", () => {
    edit.remove();
    text.hidden = false;
    meta.hidden = false;
  });
  edit.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!save.disabled) postAndReload(save, "/profile/notes/edit", { ...version(card), text: box.value });
  });
};

const remove = async (card, button) => {
  error.textContent = "";
  button.disabled = true;
  const res = await post("/profile/notes/remove", version(card));
  button.disabled = false;
  if (!res || res.status !== 204) {
    error.textContent = await failure(res);
    return;
  }
  const after = card.nextElementSibling;
  card.remove();
  showUndo("Note removed.", async () => {
    const back = await post("/profile/notes/restore", { id: card.dataset.noteId });
    if (back && back.status === 204) list.insertBefore(card, after && after.parentNode === list ? after : null);
    else error.textContent = await failure(back);
  });
};

list.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  const card = button && button.closest("li[data-note-id]");
  if (!card || button.disabled || button.closest("form")) return;
  if (button.classList.contains("confirm")) {
    postAndReload(button, "/profile/notes/confirm", {
      ...version(card),
      text: card.querySelector(".note-text").textContent,
    });
  } else if (button.classList.contains("edit")) {
    startEdit(card);
  } else if (button.classList.contains("remove")) {
    remove(card, button);
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = form.querySelector("button[type=submit]");
  if (!submit.disabled) postAndReload(submit, "/profile/notes/add", { text: field.value });
});

addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
</script>`,
    { menu: true, undo: true, ask },
  );
