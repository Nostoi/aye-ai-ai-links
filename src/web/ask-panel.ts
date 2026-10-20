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
}: Ask) => `<aside id="ask-panel" aria-label="Ask AI" data-owner="${escapeHtml(owner)}" hidden>
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
 * `sessionStorage` under `ASK_KEY` as `{v, owner, open, entries, history, pending}`. State that
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
  // While the phone sheet covers the page, the page behind it can't be reached.
  const behind = () => {
    const sheet = state.open && phone();
    for (const el of document.body.children) {
      if (el === panel || el.tagName === "SCRIPT") continue;
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
    state.entries = [];
    state.history = [];
    state.pending = null;
    messages.replaceChildren();
    save();
  });

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
  // to 8,000 characters, and the oldest pairs dropped until the body is under 400 KiB.
  const trimHistory = (history, said) => {
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
    const bytes = () => new TextEncoder().encode(JSON.stringify({ history: list, text: said })).length;
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
      const same = (k) => previous && previous[k] === tool[k];
      if (["status", "source", "since", "answeredAt", "waitDays"].every(same)) return [];
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
    }
    save();
    if (u.kind === "save") return;
    const fresh = await post("/ai/card/" + encodeURIComponent(u.body.id));
    if (fresh.status === 200 && isObj(fresh.body) && typeof fresh.body.card === "string") {
      swapCard(u.body.id, fresh.body.card);
      save();
    }
  };

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
      if (undoable(u)) {
        if (u.done === true) {
          row.appendChild(make("span", "ask-undone", "Undone."));
        } else {
          const button = make("button", "ask-undo", "Undo");
          button.setAttribute("type", "button");
          if (typeof u.title === "string") button.setAttribute("title", u.title);
          const note = make("span", "ask-note");
          note.setAttribute("aria-live", "polite");
          button.addEventListener("click", () => runUndo(u, button, note));
          row.appendChild(button);
          row.appendChild(note);
        }
      }
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
      box.appendChild(
        make("p", "ask-alert-more", "Nothing was saved or changed. Try again, or search your links the usual way."),
      );
      const actions = make("div", "ask-actions");
      const again = make("button", "ask-button", "Try again");
      again.setAttribute("type", "button");
      again.addEventListener("click", () => {
        if (running) return;
        // The failed alert goes only once the resend gets an answer, so a second failure leaves its Search link.
        send(said, { entry, box });
      });
      actions.appendChild(again);
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
    state.entries.push(entry);
    const node = drawEntry(entry);
    if (node) messages.appendChild(node);
    scroll();
    return node;
  };

  const sendButton = document.querySelector("#ask-form button[type=submit]");
  let running = false;
  const send = async (said, again) => {
    if (said === "") return;
    running = true;
    sendButton.disabled = true;
    const mine = epoch;
    if (!again) add({ kind: "me", text: said });
    const thinking = make("p", "ask-notice", "Thinking…");
    thinking.setAttribute("role", "status");
    messages.appendChild(thinking);
    scroll();
    state.pending = { text: said };
    save();
    const res = await post("/ai/chat", { history: trimHistory(state.history, said), text: said });
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
      add({ kind: "reply", segments: Array.isArray(answer.segments) ? answer.segments : [] });
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
    const sent = typeof state.pending.text === "string";
    state.pending = null;
    if (sent) state.entries.push({ kind: "notice", text: INTERRUPTED });
    save();
  }
  for (const entry of state.entries) {
    const node = drawEntry(entry);
    if (node) messages.appendChild(node);
  }
  fadeSaved();
  scroll();
  if (state.open) show(true);
})();
</script>`;
