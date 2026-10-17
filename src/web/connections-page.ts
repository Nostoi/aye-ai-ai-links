import type { KeyInfo } from "../store/key-store.js";
import { escapeHtml, page, savedOn } from "./page.js";

export type ConnectionRow = { clientId: string; name: string | null; connectedAt: Date };

function connectionItem(c: ConnectionRow, now: Date): string {
  return `<li><span><strong>${escapeHtml(c.name ?? c.clientId)}</strong><br><span class="small">Connected ${savedOn(c.connectedAt, now)}</span></span><button type="button" data-client-id="${escapeHtml(c.clientId)}">Disconnect</button></li>`;
}

function keyItem(k: KeyInfo, now: Date): string {
  return `<li data-key-id="${k.id}"><span><strong>${escapeHtml(k.name)}</strong><br><span class="small">Made ${savedOn(k.createdAt, now)}</span></span><button type="button">Turn off</button></li>`;
}

/**
 * The owner's connected apps and agent keys; only keys that are on are listed.
 *
 * Each Disconnect button posts `{clientId}` (read from its data attribute, never written into
 * the script) to `/connections/disconnect`, then reloads.
 *
 * The keys script counts an answer as success only when it is the expected status with the
 * expected body; it fetches with `redirect: "manual"`, so a redirect to `/login` is a failure.
 * - Make a key posts `{name}`. The key in the answer is shown once, as text, in the amber panel;
 *   "I copied it" clears it. A page restored from the back-forward cache reloads, so the panel
 *   never comes back.
 * - Turn off posts `{id}` at once and removes the row; Undo posts the same id to turn it back on
 *   and puts the row back. A refused turn-off removes the row (the key is off); a refused undo
 *   leaves it out.
 *
 * Save from your browser offers the bookmarklet to drag, and its code to copy for a phone (#129).
 * The code is element text, never an attribute but the link's href.
 */
export const connectionsPage = ({
  connections,
  keys,
  now,
  bookmarklet,
}: {
  connections: ConnectionRow[];
  keys: KeyInfo[];
  now: Date;
  /** The bookmarklet's code (`bookmarkletCode`), for the Save from your browser section. */
  bookmarklet: string;
}) =>
  page(
    "Apps and keys · Aye-AI-AI Links",
    `<main class="apps">
<h1>Apps and keys</h1>
<section class="group" aria-labelledby="apps-heading">
<h2 id="apps-heading">Connected apps</h2>
<p class="lead">Claude and ChatGPT connect by signing in here. To add one, connect it from the app.</p>
${connections.length === 0 ? "<p>No apps are connected.</p>" : `<ul class="connections">\n${connections.map((c) => connectionItem(c, now)).join("\n")}\n</ul>`}
<p id="error" role="alert"></p>
</section>
<section aria-labelledby="keys-heading">
<h2 id="keys-heading">Agent keys</h2>
<p class="lead">For coding agents like Claude Code and Codex, which use a key instead of signing in. One key per agent, so you can turn one off alone.</p>
<div class="new-key" id="new-key" role="status" hidden>
<p>Copy the key for "<span id="new-key-name"></span>" now. It won't be shown again.</p>
<div class="new-key-row"><code id="new-key-value"></code><button class="primary" type="button" id="copy-key">Copy key</button><button type="button" id="copied-key">I copied it</button></div>
</div>
<ul class="connections" id="keys">
${keys
  .filter((k) => k.revokedAt === null)
  .map((k) => keyItem(k, now))
  .join("\n")}
</ul>
<form class="key-form" id="make-key">
<label class="visually-hidden" for="key-name">Name for the new key</label>
<input id="key-name" name="name" autocomplete="off" required placeholder="Which agent is it for? e.g. Codex on laptop">
<button class="primary" type="submit">Make a key</button>
</form>
<p id="keys-error" role="alert"></p>
</section>
<section class="save-from-browser" aria-labelledby="bookmarklet-heading">
<h2 id="bookmarklet-heading">Save from your browser</h2>
<p class="lead">Save the page you're reading without opening an AI. It opens a Save page with the page's address and title filled in.</p>
<h3>On a computer</h3>
<p><a class="button primary" id="bookmarklet" href="${escapeHtml(bookmarklet)}">Save to Aye-AI-AI Links</a></p>
<p class="small">Drag this to your bookmarks bar. On any page, click it to save that page.</p>
<h3>On a phone</h3>
<label for="bookmarklet-code">The bookmark's code</label>
<textarea class="bookmarklet-code" id="bookmarklet-code" readonly rows="4">${escapeHtml(bookmarklet)}</textarea>
<p><button type="button" id="copy-bookmarklet">Copy code</button></p>
<ul class="phone-steps">
<li><strong>iPhone and iPad (Safari):</strong> bookmark any page; open Bookmarks, tap Edit, edit that bookmark, rename it, and replace its address with the copied code. To save a page, open Bookmarks and tap it.</li>
<li><strong>Android (Chrome):</strong> bookmark any page; edit the bookmark, rename it, and replace its URL with the copied code. To save a page, type the bookmark's name in the address bar and tap the bookmark in the suggestions.</li>
</ul>
</section>
</main>
<script>
const error = document.getElementById("error");
for (const button of document.querySelectorAll("button[data-client-id]")) {
  button.addEventListener("click", async () => {
    error.textContent = "";
    const res = await fetch("/connections/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: button.dataset.clientId }),
    });
    if (res.ok) location.reload();
    else error.textContent = "That did not work. Reload the page and try again.";
  });
}

const keysError = document.getElementById("keys-error");
const list = document.getElementById("keys");
const form = document.getElementById("make-key");
const nameField = document.getElementById("key-name");
const panel = document.getElementById("new-key");
const newName = document.getElementById("new-key-name");
const newKey = document.getElementById("new-key-value");
const copyButton = document.getElementById("copy-key");

const post = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  }).catch(() => null);

/** The server's own message for a refusal, else a generic one. */
const failure = async (res) => {
  const data = res && res.status === 400 ? await res.json().catch(() => null) : null;
  return data && typeof data.message === "string"
    ? data.message
    : "That did not work. Reload the page and try again.";
};

const keyRow = (id, name) => {
  const row = document.createElement("li");
  row.dataset.keyId = String(id);
  const label = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = name;
  const made = document.createElement("span");
  made.className = "small";
  made.textContent = "Made today";
  label.append(strong, document.createElement("br"), made);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Turn off";
  row.append(label, button);
  return row;
};

list.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  const row = button && button.closest("li[data-key-id]");
  if (!row || button.disabled) return;
  const id = Number(row.dataset.keyId);
  const name = row.querySelector("strong").textContent;
  keysError.textContent = "";
  button.disabled = true;
  const res = await post("/connections/keys/turn-off", { id });
  button.disabled = false;
  if (res && res.status === 204) {
    const after = row.nextElementSibling;
    row.remove();
    showUndo("Key for " + name + " turned off.", async () => {
      const back = await post("/connections/keys/turn-on", { id });
      if (back && back.status === 204) list.insertBefore(row, after && after.parentNode === list ? after : null);
      else keysError.textContent = await failure(back);
    });
  } else {
    if (res && res.status === 400) row.remove();
    keysError.textContent = await failure(res);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector("button[type=submit]");
  if (submit.disabled) return;
  keysError.textContent = "";
  submit.disabled = true;
  const res = await post("/connections/keys", { name: nameField.value });
  const data = res && res.status === 200 ? await res.json().catch(() => null) : null;
  if (data && typeof data.key === "string" && /^aak_/.test(data.key) && typeof data.name === "string" && Number.isSafeInteger(data.id)) {
    newName.textContent = data.name;
    newKey.textContent = data.key;
    copyButton.textContent = "Copy key";
    panel.hidden = false;
    list.append(keyRow(data.id, data.name));
    nameField.value = "";
  } else {
    keysError.textContent = await failure(res);
  }
  submit.disabled = false;
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(newKey.textContent);
    copyButton.textContent = "Copied";
  } catch {
    getSelection().selectAllChildren(newKey);
  }
});

document.getElementById("copied-key").addEventListener("click", () => {
  panel.hidden = true;
  newKey.textContent = "";
  newName.textContent = "";
});

{
  const codeField = document.getElementById("bookmarklet-code");
  const copyCode = document.getElementById("copy-bookmarklet");
  copyCode.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(codeField.textContent);
      copyCode.textContent = "Copied";
    } catch {
      codeField.focus();
      codeField.select();
    }
  });
}

addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
</script>`,
    { menu: true, undo: true },
  );
