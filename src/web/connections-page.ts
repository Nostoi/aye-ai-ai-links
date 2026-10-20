import type { ExportView } from "../core/export-types.js";
import type { KeyInfo } from "../store/key-store.js";
import type { Ask } from "./ask-panel.js";
import { escapeHtml, page, savedOn } from "./page.js";

/** Decimal MB or GB with one decimal, as phones show sizes; under 50,000 bytes would print 0.0 MB (#130). */
const bytesText = (bytes: number) =>
  bytes < 50_000
    ? "under 0.1 MB"
    : bytes >= 999_950_000
      ? `${(bytes / 1e9).toFixed(1)} GB`
      : `${(bytes / 1e6).toFixed(1)} MB`;

const utcText = (at: Date) =>
  `${at
    .toLocaleString("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replaceAll(",", "")} UTC`;

const PREPARE = (label: string, primary: boolean) =>
  `<button${primary ? ' class="primary"' : ""} type="button" data-export="prepare">${label}</button>`;

const exportBody = (view: ExportView): string => {
  switch (view.state) {
    case "idle":
      return `<p class="lead">Download everything you've saved: links, pictures, saved copies and a bookmarks file.</p>
<p>${PREPARE("Prepare export", true)}</p>`;
    case "preparing":
      return `<p role="status">Preparing your export…</p>`;
    case "ready":
      return `<p><a class="button primary" href="/export.zip">Download</a> ${PREPARE("Prepare again", false)}</p>
<p class="small">${bytesText(view.bytes)}, prepared ${utcText(view.exportedAt)}. Kept for 24 hours.</p>`;
    case "failed":
      return `<p>The last export didn't finish.</p>
<p>${PREPARE("Try again", true)}</p>`;
  }
};

/** "Your data": the zip's four states, and the links-only JSON under all of them. */
const yourDataSection = (
  view: ExportView,
) => `<section id="your-data" data-state="${view.state}" aria-labelledby="your-data-heading">
<h2 id="your-data-heading">Your data</h2>
${exportBody(view)}
<p><a class="button" href="/export.json">Links only (.json)</a></p>
<p id="export-error" role="alert"></p>
</section>`;

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
 *
 * Your data (#130) shows the export's state and links to the links-only JSON. Prepare posts
 * `/export/prepare` (no body, `redirect: "manual"`); on 202 or 409 the script reads `/connections`
 * again and swaps in only its `#your-data` (a half-typed key name survives), repeating every 5 s
 * while the state is `preparing`. A redirect, a non-200 answer or a page with no `#your-data` is
 * never swapped in; the owner is told to reload. Clicks are delegated on `main`, so the buttons
 * of a swapped-in section work.
 */
export const connectionsPage = ({
  connections,
  keys,
  now,
  bookmarklet,
  exportView,
  ask,
}: {
  ask?: Ask | undefined;
  connections: ConnectionRow[];
  keys: KeyInfo[];
  now: Date;
  /** The bookmarklet's code (`bookmarkletCode`), for the Save from your browser section. */
  bookmarklet: string;
  exportView: ExportView;
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
<p class="small" id="bookmarklet-status" role="status"></p>
<ul class="phone-steps">
<li><strong>iPhone and iPad (Safari):</strong> bookmark any page; open Bookmarks, tap Edit, edit that bookmark, rename it, and replace its address with the copied code. To save a page, open Bookmarks and tap it.</li>
<li><strong>Android (Chrome):</strong> bookmark any page; edit the bookmark, rename it, and replace its URL with the copied code. To save a page, type the bookmark's name in the address bar and tap the bookmark in the suggestions.</li>
</ul>
</section>
${yourDataSection(exportView)}
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
  const copyStatus = document.getElementById("bookmarklet-status");
  copyCode.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(codeField.textContent);
      copyCode.textContent = "Copied";
      copyStatus.textContent = "";
    } catch {
      copyCode.textContent = "Copy code";
      copyStatus.textContent = "Copy didn't work. The code is selected: press and hold it, then Copy.";
      codeField.focus();
      codeField.select();
      codeField.setSelectionRange(0, codeField.value.length);
    }
  });
}

{
  const STALE = "That did not work. Reload the page and try again.";
  let busy = false;
  let timer = 0;
  const refreshData = async () => {
    clearTimeout(timer);
    const res = await fetch("/connections", { headers: { accept: "text/html" }, redirect: "manual" }).catch(() => null);
    const text = res && res.status === 200 ? await res.text().catch(() => null) : null;
    const next = text === null ? null : new DOMParser().parseFromString(text, "text/html").getElementById("your-data");
    const section = document.getElementById("your-data");
    if (!next) {
      section.querySelector("#export-error").textContent = STALE;
      return false;
    }
    section.innerHTML = next.innerHTML;
    section.dataset.state = next.dataset.state;
    if (section.dataset.state === "preparing") timer = setTimeout(refreshData, 5000);
    return true;
  };
  document.querySelector("main.apps").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-export=prepare]");
    if (!button || busy) return;
    busy = true;
    button.disabled = true;
    const errorText = document.getElementById("export-error");
    errorText.textContent = "";
    const res = await fetch("/export/prepare", { method: "POST", redirect: "manual" }).catch(() => null);
    if (res && (res.status === 202 || res.status === 409)) await refreshData();
    else errorText.textContent = STALE;
    button.disabled = false;
    busy = false;
  });
  if (document.getElementById("your-data").dataset.state === "preparing") timer = setTimeout(refreshData, 5000);
}

addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
</script>`,
    { menu: true, undo: true, ask },
  );
