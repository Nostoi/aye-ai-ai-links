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
<div class="ask-row"><textarea id="ask-text" rows="2" placeholder="Ask, or paste a link to save"></textarea><button class="primary" type="submit">Send</button></div>
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
    state.entries = [];
    state.history = [];
    state.pending = null;
    messages.replaceChildren();
    save();
  });
  document.getElementById("ask-form").addEventListener("submit", (event) => {
    event.preventDefault();
  });
  document.getElementById("sign-out").addEventListener("click", () => {
    signedOut = true;
    forget();
  });

  window.askPanel = { load, save, state, messages };
  if (state.open) show(true);
})();
</script>`;
