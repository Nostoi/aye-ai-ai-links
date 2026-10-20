import { MAX_PAGE_IDS } from "../ai/chat-turn.js";
import { escapeHtml } from "../core/escape-html.js";

/** What `page()` needs to add the Ask AI panel (#159): the AI's name, the page's name, and the owner's id. */
export type Ask = { ai: string; place: string; owner: string };

/** The one `sessionStorage` key that holds the conversation; sign out removes it. */
export const ASK_KEY = "aye-ask";

const BUBBLE = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>`;
const CROSS = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/** The menu's Ask AI button; it sits between Apps and keys and Sign out. */
export const ASK_BUTTON = `<button type="button" id="ask-open" aria-pressed="false" aria-controls="ask-panel">${BUBBLE}Ask AI</button>`;

/** The panel, hidden until the script opens it. */
export const askPanel = ({
  ai,
  place,
  owner,
}: Ask) => `<aside id="ask-panel" aria-label="Ask AI" data-owner="${escapeHtml(owner)}" data-place="${escapeHtml(place)}" hidden>
<div class="ask-head">
<button type="button" id="ask-back" class="ask-back">‹ ${escapeHtml(place)}</button>
<div class="ask-title"><h2>Ask AI</h2><p>Using ${escapeHtml(ai)}, on ${escapeHtml(place)}</p></div>
<div class="ask-tools"><button type="button" id="ask-restart" class="ask-restart">Start over</button><button type="button" id="ask-close" class="ask-close" aria-label="Close">${CROSS}</button></div>
</div>
<div id="ask-messages" class="ask-messages"></div>
<form id="ask-form" class="ask-form">
<label class="ask-label" for="ask-text">Message your AI</label>
<div class="ask-row"><textarea id="ask-text" rows="2" maxlength="4000" placeholder="Ask, or paste a link to save"></textarea><button class="primary" type="submit">Send</button></div>
</form>
</aside>`;

/**
 * The panel's script; it relies on no other page script. The conversation lives in
 * `sessionStorage` under `ASK_KEY` as `{v, owner, open, entries, history, pending}`; each entry
 * added carries the `path` and `place` of the page it was made on. State that
 * fails to parse, or whose `v` or `owner` isn't this page's, is discarded; a failed save is
 * ignored and the panel works without memory. `window.askPanel` is what the sending code uses.
 * Sign out removes the key from here, so the menu's own script is the same with the AI off.
 */
export const ASK_SCRIPT = `<script>
(() => {
  const KEY = ${JSON.stringify(ASK_KEY)};
  const panel = document.getElementById("ask-panel");
  const openButton = document.getElementById("ask-open");
  const messages = document.getElementById("ask-messages");
  const text = document.getElementById("ask-text");
  const owner = panel.getAttribute("data-owner");
  const blank = () => ({ v: 1, owner, open: false, entries: [], history: [], pending: null });
  const forget = () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
  };
  const load = () => {
    let raw = null;
    try {
      raw = sessionStorage.getItem(KEY);
    } catch {
      return blank();
    }
    if (raw === null) return blank();
    try {
      const saved = JSON.parse(raw);
      if (
        saved !== null &&
        typeof saved === "object" &&
        saved.v === 1 &&
        saved.owner === owner &&
        Array.isArray(saved.entries) &&
        Array.isArray(saved.history)
      ) {
        return {
          v: 1,
          owner,
          open: saved.open === true,
          entries: saved.entries,
          history: saved.history,
          pending: saved.pending !== null && typeof saved.pending === "object" ? saved.pending : null,
        };
      }
    } catch {}
    forget();
    return blank();
  };
  const state = load();
  const place = (panel.getAttribute("data-place") ?? "").slice(0, 300);
  const path = (location.pathname + location.search).slice(0, 300);
  let signedOut = false;
  // Counts Start overs, so an answer that arrives after one is not drawn into the new conversation.
  let epoch = 0;
  const save = () => {
    if (signedOut) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify(state));
    } catch {}
  };

  const phone = () => typeof matchMedia === "function" && matchMedia("(max-width: 900px)").matches;
  // While the phone sheet covers the page, the page behind it can't be reached. The edit dialog
  // and the Undo bar stay usable above it.
  const behind = () => {
    const sheet = state.open && phone();
    const bar = document.getElementById("undo-bar");
    for (const el of document.body.children) {
      if (el === panel || el.tagName === "SCRIPT" || el.tagName === "DIALOG") continue;
      if (bar && el.contains(bar)) continue;
      if (sheet) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
  };
  const show = (open) => {
    state.open = open;
    panel.hidden = !open;
    openButton.setAttribute("aria-pressed", open ? "true" : "false");
    document.body.classList.toggle("ask-open", open);
    behind();
    save();
  };
  const open = () => {
    show(true);
    text.focus();
  };
  const close = () => {
    clearFade();
    show(false);
    openButton.focus();
  };

  openButton.addEventListener("click", () => (state.open ? close() : open()));
  document.getElementById("ask-close").addEventListener("click", close);
  document.getElementById("ask-back").addEventListener("click", close);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  if (typeof matchMedia === "function") {
    matchMedia("(max-width: 900px)").addEventListener?.("change", behind);
  }
  document.getElementById("ask-restart").addEventListener("click", () => {
    epoch += 1;
    clearFade();
    state.entries = [];
    state.history = [];
    state.pending = null;
    messages.replaceChildren();
    save();
  });

  const MAX_PAGE_IDS = ${MAX_PAGE_IDS};
  // The link ids on the page, in order, once each: not the panel's own cards, nor anything hidden.
  const pageIds = () => {
    const ids = new Set();
    for (const el of document.querySelectorAll("[data-id]")) {
      if (panel.contains(el) || el.closest("[hidden]")) continue;
      const id = el.getAttribute("data-id");
      if (/^[0-9]+$/.test(id)) ids.add(id);
    }
    return [...ids];
  };
  const pageContext = () => {
    const ids = pageIds();
    return { path, place, ids: ids.slice(0, MAX_PAGE_IDS), shown: ids.length };
  };

  // After a reply names cards on this page, the page's other cards dim until the next send, Start
  // over or close. The fade is not stored.
  let fade = null;
  const dimmed = new Set();
  const dimPage = (named) => {
    for (const el of document.querySelectorAll("[data-id]")) {
      if (panel.contains(el) || named.has(el.getAttribute("data-id"))) continue;
      el.classList.add("ask-dim");
      dimmed.add(el);
    }
  };
  const clearFade = () => {
    fade?.disconnect();
    fade = null;
    for (const el of dimmed) el.classList.remove("ask-dim");
    dimmed.clear();
  };
  const startFade = (named) => {
    clearFade();
    dimPage(named);
    // Cards added later, such as by a shelf refresh or Show older, are dimmed as they arrive.
    if (typeof MutationObserver !== "function") return;
    fade = new MutationObserver(() => dimPage(named));
    fade.observe(document.body, { childList: true, subtree: true });
  };

  const MAX_MESSAGES = 40;
  const MAX_BYTES = 400 * 1024;
  const MAX_REPLY = 8000;
  const INTERRUPTED =
    "This message was sent, but you left the page before the answer arrived. Anything it saved or changed is in your links.";
  const FALLBACK = "Something went wrong. Try again.";
  const UNDO_FAILED = "That didn't work. Try again.";
  const EDIT_UNDO_TITLE = "Puts back the title, summary, why and tags.";
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const make = (tag, cls, content) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const scroll = () => {
    messages.scrollTop = messages.scrollHeight;
  };
  const post = async (url, body) => {
    try {
      const init =
        body === undefined
          ? { redirect: "manual" }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              redirect: "manual",
            };
      const res = await fetch(url, init);
      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, body: json };
    } catch {
      return { status: 0, body: null };
    }
  };

  // What the server gets of the conversation: the last 40 messages in whole pairs, each reply cut
  // to 8,000 characters, and the oldest pairs dropped until the body, page included, is under 400 KiB.
  const trimHistory = (history, said, page) => {
    // Pairs are stored together, so a pair is kept only when both halves are right.
    const isSaid = (m, role) =>
      isObj(m) && m.role === role && typeof m.text === "string" && m.text.trim() !== "";
    let list = [];
    for (let i = 0; i + 1 < history.length; i += 2) {
      if (!isSaid(history[i], "user") || !isSaid(history[i + 1], "assistant")) continue;
      list.push(
        { role: "user", text: history[i].text },
        { role: "assistant", text: history[i + 1].text.slice(0, MAX_REPLY) },
      );
    }
    if (list.length > MAX_MESSAGES) {
      const extra = list.length - MAX_MESSAGES;
      list = list.slice(extra + (extra % 2));
    }
    const bytes = () => new TextEncoder().encode(JSON.stringify({ history: list, text: said, page })).length;
    while (list.length > 0 && bytes() > MAX_BYTES) list = list.slice(2);
    return list;
  };

  // One change as the lines the owner reads. Most give one line; a profile change gives one per entry.
  const HANDY = {
    kept: "Kept handy.",
    suggested: "Suggested for your Handy shelf (a guess).",
    declined: "Taken off your Handy shelf.",
  };
  const changeLine = (c) => {
    if (c.kind === "link") {
      const id = c.linkId;
      if (c.created) {
        return [{ text: "Saved.", linkId: id, undo: { kind: "save", url: "/links/delete", body: { id } } }];
      }
      if (typeof c.editId === "string") {
        const body = { id, editId: c.editId };
        const undo = { kind: "edit", url: "/links/edit/undo", body, title: EDIT_UNDO_TITLE };
        return [{ text: "Updated.", linkId: id, undo }];
      }
      return [{ text: "Updated.", linkId: id }];
    }
    if (c.kind === "handy") {
      const { tool, previous } = c.change;
      const text = HANDY[tool.status] ?? "Changed its place on your Handy shelf: " + tool.status + ".";
      const body = { id: c.linkId, tool, previous };
      return [{ text, linkId: c.linkId, undo: { kind: "handy", url: "/tools/undo", body } }];
    }
    if (c.kind === "tag") {
      return [{ text: "Made " + c.name + " a " + c.tagKind + ".", link: { href: "/tags", label: "Tags" } }];
    }
    if (c.kind === "profile") {
      const link = { href: "/profile", label: "Profile" };
      const lines = [];
      for (const [verb, entries] of [["Added", c.added], ["Changed", c.edited], ["Removed", c.removed]]) {
        for (const e of entries) {
          const what = e.entry === "focus" ? "what you're working on: " : "the note ";
          const guess = e.source === "inferred" ? " (a guess)" : "";
          lines.push({ text: verb + " " + what + "'" + e.text + "'" + guess, link });
        }
      }
      return lines;
    }
    if (c.kind === "surfaced") {
      const n = c.linkIds.length;
      return [{ text: "Marked " + n + (n === 1 ? " link" : " links") + " as shown in today's picks." }];
    }
    return [];
  };
  // One line per link: its save's if it was saved, else the edit that has an Undo, else the first.
  const changeLines = (changes) => {
    const rank = (line) => (line.undo?.kind === "save" ? 2 : line.undo?.kind === "edit" ? 1 : 0);
    const lines = [];
    const byLink = new Map();
    for (const change of changes) {
      for (const line of changeLine(change)) {
        if (change.kind !== "link") {
          lines.push(line);
          continue;
        }
        const at = byLink.get(change.linkId);
        if (at === undefined) {
          byLink.set(change.linkId, lines.length);
          lines.push(line);
        } else if (rank(line) > rank(lines[at])) {
          lines[at] = line;
        }
      }
    }
    return lines;
  };

  const parseCard = (html) => {
    const holder = make("div");
    holder.innerHTML = html;
    return holder;
  };
  const cardIdOf = (html) => parseCard(html).firstElementChild?.getAttribute("data-id") ?? null;
  const forCards = (id, fn) => {
    for (const card of [...messages.querySelectorAll(".ask-card")]) {
      if (card.getAttribute("data-id") === id) fn(card);
    }
  };
  const fadeCards = (id) => forCards(id, (card) => card.classList.add("ask-faded"));
  // A link's card, newly read: the drawn ones and the stored HTML, wherever the turn kept it.
  const swapCard = (id, html) => {
    forCards(id, (card) => {
      const fresh = parseCard(html).firstElementChild;
      if (fresh) card.replaceWith(fresh);
    });
    for (const entry of state.entries) {
      if (!isObj(entry)) continue;
      if (Array.isArray(entry.segments)) {
        entry.segments = entry.segments.map((s) =>
          isObj(s) && typeof s.card === "string" && cardIdOf(s.card) === id ? { card: html } : s,
        );
      }
      if (isObj(entry.cards) && typeof entry.cards[id] === "string") entry.cards[id] = html;
    }
  };
  const fadeSaved = () => {
    for (const entry of state.entries) {
      if (!isObj(entry) || !Array.isArray(entry.lines)) continue;
      for (const line of entry.lines) {
        if (isObj(line) && undoable(line.undo) && line.undo.kind === "save" && line.undo.faded === true) {
          fadeCards(line.undo.body.id);
        }
      }
    }
  };

  const undoable = (u) =>
    isObj(u) &&
    ["save", "edit", "handy"].includes(u.kind) &&
    typeof u.url === "string" &&
    isObj(u.body) &&
    typeof u.body.id === "string";
  const OWN_ANSWERS = [400, 404, 409];
  const runUndo = async (u, button, note) => {
    button.disabled = true;
    note.textContent = "";
    const res = await post(u.url, u.body);
    if (res.status < 200 || res.status > 299) {
      const said = isObj(res.body) && typeof res.body.message === "string" ? res.body.message : null;
      note.textContent = OWN_ANSWERS.includes(res.status) && said ? said : UNDO_FAILED;
      button.disabled = false;
      return;
    }
    u.done = true;
    const done = make("span", "ask-undone", "Undone.");
    button.replaceWith(done);
    if (u.kind === "save") {
      u.faded = true;
      fadeCards(u.body.id);
      // The link is deleted: no read still on its way may put its card back, and it can't be edited.
      endReads(u.body.id);
      dropEdits(u.body.id);
    }
    save();
    if (u.kind === "save") return;
    await refreshCard(u.body.id);
  };

  // Edit (#183) opens the page's one edit dialog on a change line's link. The contract with the
  // dialog's script (edit-dialog.ts):
  // - "aye-edit" on document, { card, opener, note }: the panel asks the dialog to open on its
  //   card; focus goes back to opener, and a refusal that comes once the dialog closed goes in note.
  // - "aye-edited" on document, { id }: the dialog saved or undid an edit to that link; the panel
  //   reads its cards for it again.
  // Edit is offered for a link the AI saved or changed whose card the panel shows, and never for a
  // link whose save was undone or that turned out deleted.
  const gone = new Set();
  const deleted = (id) =>
    gone.has(id) ||
    state.entries.some(
      (entry) =>
        isObj(entry) &&
        Array.isArray(entry.lines) &&
        entry.lines.some(
          (l) => isObj(l) && undoable(l.undo) && l.undo.kind === "save" && l.undo.done === true && l.undo.body.id === id,
        ),
    );
  const editable = (line) =>
    typeof line.linkId === "string" &&
    (line.undo === undefined || (undoable(line.undo) && ["save", "edit"].includes(line.undo.kind))) &&
    !deleted(line.linkId);
  // The link's card in the line's own block, else anywhere in the conversation (a cited link's card
  // sits in the reply above).
  const panelCard = (id, block) => {
    const find = (within) =>
      [...within.querySelectorAll(".ask-card")].find(
        (card) => card.getAttribute("data-id") === id && card.hasAttribute("data-title"),
      ) ?? null;
    return find(block) ?? find(messages);
  };
  const dropEdits = (id) => {
    for (const edit of [...messages.querySelectorAll(".ask-edit")]) {
      if (edit.getAttribute("data-id") === id) edit.remove();
    }
  };
  // Reads of one link's card are numbered; only the latest one started is drawn and stored.
  const reads = new Map();
  const bumpRead = (id) => {
    const n = (reads.get(id) ?? 0) + 1;
    reads.set(id, n);
    return n;
  };
  // "ok" once the fresh card is drawn and stored, "stale" when a later read started, "gone" for a
  // deleted link, else "failed".
  const refreshCard = (id) => {
    const n = bumpRead(id);
    const read = (async () => {
      const fresh = await post("/ai/card/" + encodeURIComponent(id));
      if (reads.get(id) !== n) return "stale";
      if (fresh.status === 200 && isObj(fresh.body) && typeof fresh.body.card === "string") {
        swapCard(id, fresh.body.card);
        save();
        return "ok";
      }
      return fresh.status === 404 ? "gone" : "failed";
    })();
    newest.set(id, read);
    return read;
  };
  const newest = new Map();
  const endReads = (id) => {
    bumpRead(id);
    newest.set(id, Promise.resolve("gone"));
  };
  const editNotes = new Map();
  let presses = 0;
  document.addEventListener("aye-editing", () => {
    presses += 1;
  });
  const runEdit = async (id, button, note, block) => {
    const press = ++presses;
    note.textContent = "";
    let read = await refreshCard(id);
    while (read === "stale") read = await newest.get(id);
    if (read === "gone") {
      gone.add(id);
      dropEdits(id);
      note.textContent = "This link was deleted.";
      return;
    }
    if (press !== presses) return;
    if (read === "failed") note.textContent = "Couldn't load this link. Try again.";
    if (read !== "ok" || !button.isConnected) return;
    const card = panelCard(id, block);
    if (!card) return;
    editNotes.set(id, note);
    document.dispatchEvent(new CustomEvent("aye-edit", { detail: { card, opener: button, note } }));
  };
  document.addEventListener("aye-edited", async (event) => {
    const id = isObj(event.detail) ? event.detail.id : null;
    if (typeof id !== "string") return;
    let drawn = false;
    forCards(id, () => {
      drawn = true;
    });
    if (!drawn) return;
    const note = editNotes.get(id);
    if ((await refreshCard(id)) === "failed" && note) {
      note.textContent = "This card couldn't be refreshed. Reload to see the change.";
    }
  });

  const slot = (parent, html) => {
    const holder = parseCard(html);
    while (holder.firstChild) parent.appendChild(holder.firstChild);
  };
  const drawLines = (lines, cards) => {
    const list = make("div", "ask-changes");
    const carded = new Set();
    for (const line of lines) {
      if (!isObj(line) || typeof line.text !== "string") continue;
      const block = make("div", "ask-change");
      const id = line.linkId;
      if (typeof id === "string" && isObj(cards) && typeof cards[id] === "string" && !carded.has(id)) {
        carded.add(id);
        slot(block, cards[id]);
      }
      const row = make("div", "ask-line");
      row.appendChild(make("span", "", line.text));
      const to = isObj(line.link) ? line.link : null;
      if (to && typeof to.href === "string" && typeof to.label === "string" && to.href[0] === "/" && to.href[1] !== "/") {
        const a = make("a", "", to.label);
        a.setAttribute("href", to.href);
        row.appendChild(a);
      }
      const u = line.undo;
      const live = undoable(u) && u.done !== true;
      const edit = editable(line) && panelCard(id, block) !== null;
      // Edit and Undo share the row's one note.
      const note = live || edit ? make("span", "ask-note") : null;
      if (note) note.setAttribute("aria-live", "polite");
      if (edit) {
        const button = make("button", "ask-edit", "Edit");
        button.setAttribute("type", "button");
        button.setAttribute("data-id", id);
        button.setAttribute("title", "Edit title and picture");
        button.addEventListener("click", () => runEdit(id, button, note, block));
        row.appendChild(button);
      }
      if (undoable(u)) {
        if (u.done === true) {
          row.appendChild(make("span", "ask-undone", "Undone."));
        } else {
          const button = make("button", "ask-undo", "Undo");
          button.setAttribute("type", "button");
          if (typeof u.title === "string") button.setAttribute("title", u.title);
          button.addEventListener("click", () => runUndo(u, button, note));
          row.appendChild(button);
        }
      }
      if (note) row.appendChild(note);
      block.appendChild(row);
      list.appendChild(block);
    }
    return list;
  };

  const searchLink = (said) => {
    const a = make("a", "ask-button", 'Search for "' + said + '"');
    a.setAttribute("href", "/search?q=" + encodeURIComponent(said));
    return a;
  };
  const drawAlert = (entry) => {
    const box = make("div", "ask-alert");
    box.setAttribute("role", "alert");
    const head = make("p", "ask-alert-head");
    head.appendChild(make("strong", "", entry.message));
    box.appendChild(head);
    const said = typeof entry.text === "string" ? entry.text : null;
    if (said === null) return box;
    if (entry.changed !== true) {
      const retry = madeHere(entry);
      box.appendChild(
        make(
          "p",
          "ask-alert-more",
          retry
            ? "Nothing was saved or changed. Try again, or search your links the usual way."
            : "Nothing was saved or changed. Search your links the usual way.",
        ),
      );
      const actions = make("div", "ask-actions");
      if (retry) {
        const again = make("button", "ask-button", "Try again");
        again.setAttribute("type", "button");
        again.addEventListener("click", () => {
          if (running) return;
          // The failed alert goes only once the resend gets an answer, so a second failure leaves its Search link.
          send(said, { entry, box });
        });
        actions.appendChild(again);
      }
      actions.appendChild(searchLink(said));
      box.appendChild(actions);
      return box;
    }
    box.appendChild(make("p", "ask-alert-more", "It had already made these changes:"));
    box.appendChild(drawLines(Array.isArray(entry.lines) ? entry.lines : [], entry.cards));
    box.appendChild(
      make("p", "ask-alert-more", "Check them, then try again or search your links the usual way."),
    );
    const actions = make("div", "ask-actions");
    actions.appendChild(searchLink(said));
    box.appendChild(actions);
    return box;
  };

  // Draws one stored entry; anything that isn't a known kind with the right field types draws nothing.
  const drawEntry = (entry) => {
    if (!isObj(entry)) return null;
    if (entry.kind === "me" && typeof entry.text === "string") return make("p", "ask-me", entry.text);
    if (entry.kind === "notice" && typeof entry.text === "string") {
      return make("p", "ask-notice", entry.text);
    }
    if (entry.kind === "reply" && Array.isArray(entry.segments)) {
      const reply = make("div", "ask-reply");
      for (const s of entry.segments) {
        if (!isObj(s)) continue;
        if (typeof s.text === "string") reply.appendChild(make("p", "", s.text));
        else if (typeof s.card === "string") slot(reply, s.card);
      }
      return reply;
    }
    if (entry.kind === "changes" && Array.isArray(entry.lines)) {
      return drawLines(entry.lines, entry.cards);
    }
    if (entry.kind === "alert" && typeof entry.message === "string") return drawAlert(entry);
    return null;
  };
  const add = (entry) => {
    entry.path = path;
    entry.place = place;
    state.entries.push(entry);
    const node = drawEntry(entry);
    if (node) messages.appendChild(node);
    scroll();
    return node;
  };

  // An entry with no address counts as made on this page.
  const madeHere = (entry) => !isObj(entry) || typeof entry.path !== "string" || entry.path === path;
  // The cards an exchange shows, as elements: the reply's, and those kept with its changes.
  const cardsOf = (entries) => {
    const found = [];
    for (const e of entries) {
      const htmls = [];
      if (Array.isArray(e.segments)) {
        for (const s of e.segments) if (isObj(s) && typeof s.card === "string") htmls.push(s.card);
      }
      if (isObj(e.cards)) {
        for (const h of Object.values(e.cards)) if (typeof h === "string") htmls.push(h);
      }
      for (const h of htmls) found.push(...parseCard(h).querySelectorAll("[data-id]"));
    }
    return found;
  };
  const clip = (said) => (said.length > 60 ? said.slice(0, 60) + "…" : said);
  // What the last earlier exchange came to: the links it saved, else what the owner asked.
  const summarize = (group) => {
    const exchange = group.slice(Math.max(0, group.findLastIndex((e) => isObj(e) && e.kind === "me")));
    const entries = exchange.filter(isObj);
    const cards = cardsOf(entries);
    const titles = new Map();
    for (const e of entries) {
      if (!["changes", "alert"].includes(e.kind) || !Array.isArray(e.lines)) continue;
      for (const line of e.lines) {
        if (!isObj(line) || line.text !== "Saved." || typeof line.linkId !== "string") continue;
        if (isObj(line.undo) && line.undo.done === true) continue;
        const card = cards.find((c) => c.getAttribute("data-id") === line.linkId);
        const title = card?.querySelector("h3")?.textContent;
        if (title) titles.set(line.linkId, title);
      }
    }
    if (titles.size > 0) {
      const first = titles.values().next().value;
      return 'saved "' + first + '"' + (titles.size > 1 ? " and " + (titles.size - 1) + " more" : "");
    }
    const asked = entries.find((e) => e.kind === "me" && typeof e.text === "string");
    return asked ? '"' + clip(asked.text) + '"' : "";
  };
  // Entries made on other pages sit behind one line that shows them or hides them again.
  const drawAll = () => {
    let from = state.entries.length;
    while (from > 0 && madeHere(state.entries[from - 1])) from -= 1;
    const group = state.entries.slice(0, from);
    if (group.length > 0) {
      const last = group[group.length - 1];
      const where = isObj(last) && typeof last.place === "string" ? last.place : "";
      const said = summarize(group);
      const toggle = make("button", "ask-earlier", "Earlier, on " + where + (said ? ": " + said : ""));
      toggle.setAttribute("type", "button");
      toggle.setAttribute("aria-expanded", "false");
      const box = make("div", "ask-earlier-entries");
      box.hidden = true;
      toggle.addEventListener("click", () => {
        box.hidden = !box.hidden;
        toggle.setAttribute("aria-expanded", box.hidden ? "false" : "true");
      });
      messages.appendChild(toggle);
      messages.appendChild(box);
      for (const entry of group) {
        const node = drawEntry(entry);
        if (node) box.appendChild(node);
      }
    }
    for (const entry of state.entries.slice(from)) {
      const node = drawEntry(entry);
      if (node) messages.appendChild(node);
    }
  };

  const sendButton = document.querySelector("#ask-form button[type=submit]");
  let running = false;
  const send = async (said, again) => {
    if (said === "") return;
    running = true;
    sendButton.disabled = true;
    clearFade();
    const mine = epoch;
    if (!again) add({ kind: "me", text: said });
    const thinking = make("p", "ask-notice", "Thinking…");
    thinking.setAttribute("role", "status");
    messages.appendChild(thinking);
    scroll();
    state.pending = { text: said, path, place };
    save();
    const page = pageContext();
    const res = await post("/ai/chat", { history: trimHistory(state.history, said, page), text: said, page });
    running = false;
    sendButton.disabled = false;
    thinking.remove();
    if (mine !== epoch) return;
    state.pending = null;
    const answer = res.body;
    if (res.status !== 200 || !isObj(answer) || typeof answer.ok !== "boolean") {
      const told = isObj(answer) && typeof answer.message === "string" ? answer.message : FALLBACK;
      add({ kind: "alert", message: told });
      // The turn may have run, so nothing is resent; the text is back in the box for the owner to decide.
      if (text.value === "") text.value = said;
      save();
      return;
    }
    if (again) {
      state.entries = state.entries.filter((e) => e !== again.entry);
      again.box.remove();
    }
    const changes = Array.isArray(answer.changes) ? answer.changes : [];
    const lines = changeLines(changes);
    const cards = isObj(answer.cards) ? answer.cards : {};
    if (answer.ok) {
      const node = add({ kind: "reply", segments: Array.isArray(answer.segments) ? answer.segments : [] });
      const named = new Set([...node.querySelectorAll(".ask-card[data-id]")].map((c) => c.getAttribute("data-id")));
      if (state.open && pageIds().some((id) => named.has(id))) startFade(named);
      if (lines.length > 0) add({ kind: "changes", lines, cards });
    } else {
      const message = typeof answer.message === "string" ? answer.message : FALLBACK;
      add({ kind: "alert", message, text: said, changed: changes.length > 0, lines, cards });
    }
    if (answer.ok || changes.length > 0) {
      state.history.push({ role: "user", text: said });
      state.history.push({ role: "assistant", text: String(answer.remember ?? "").slice(0, MAX_REPLY) });
    }
    save();
  };

  document.getElementById("ask-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const said = text.value.trim();
    if (said === "" || running) return;
    text.value = "";
    send(said, false);
  });
  document.getElementById("sign-out").addEventListener("click", () => {
    signedOut = true;
    forget();
  });

  window.askPanel = { load, save, state, messages, trimHistory, changeLines };
  if (state.pending !== null) {
    const { text: sent, path: from, place: where } = state.pending;
    state.pending = null;
    if (typeof sent === "string") {
      const same = typeof from === "string" && typeof where === "string";
      state.entries.push({
        kind: "notice",
        text: INTERRUPTED,
        path: same ? from : path,
        place: same ? where : place,
      });
    }
    save();
  }
  drawAll();
  fadeSaved();
  scroll();
  if (state.open) show(true);
})();
</script>`;
