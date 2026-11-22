import { escapeHtml } from "../core/escape-html.js";

/** What the dialog says when an answer could not be fetched; Enter still goes to the full results. */
export const FIND_FAILED = "Couldn't search just now. Press Enter to see the full results.";

/** How long the field waits after the last key before it searches. */
export const FIND_DEBOUNCE_MS = 250;

/** The space page's own space, which every opener of the dialog starts inside (#360). */
export type FindSpace = { key: string; name: string; className: string };

const MAGNIFIER = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>`;
const CROSS = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/**
 * The quick-find dialog (#360), once on every page with the menu, as a body child outside `main`.
 * The field is the combobox of the WAI-ARIA pattern; the answer the script fetches goes into
 * `#find-body`, where its `listbox` is. The form is a plain search form (`/search`, with the space
 * as `tag` while it is kept), so Enter with no row to open still goes to the full results. On a
 * On a space page `space` adds the removable "in <space>" chip, hidden until the script opens the dialog.
 */
export const findDialog = (space?: FindSpace) =>
  `<dialog class="find-dialog" id="find-dialog" aria-label="Find a link"${space ? ` data-space="${escapeHtml(space.key)}"` : ""}>
<form class="find-form" action="/search" method="get" role="search">
<div class="find-bar">
${MAGNIFIER}
${space ? `<span class="find-chip${escapeHtml(space.className)}" hidden><span class="dot" aria-hidden="true"></span>in ${escapeHtml(space.name)}<button type="button" class="find-chip-x" aria-label="Search all your links instead">${CROSS}</button></span>\n<input type="hidden" name="tag" value="${escapeHtml(space.key)}" disabled>\n` : ""}<label class="visually-hidden" for="find-q">Search your links</label>
<input id="find-q" name="q" type="text" role="combobox" aria-expanded="false" aria-controls="find-list" aria-autocomplete="list" autocomplete="off" enterkeyhint="search" placeholder="Search your links">
<kbd class="find-esc" aria-hidden="true">Esc</kbd>
</div>
<button type="button" class="find-cancel">Cancel</button>
</form>
<p class="find-error" role="alert"></p>
<div class="find-body" id="find-body"></div>
</dialog>`;

/**
 * The dialog's script, a block with its own names, written once on every menu page (`page()` adds
 * `openedScript` for `#find-dialog` after it).
 * - An unmodified click on an `a[data-find-open]` (the bar's magnifier, a space page's Search this
 *   space) opens the dialog, and so does the "aye-find-open" event on document (the `/` key, which
 *   sends it where the page has no search field). A modified or middle click follows the link.
 *   Every open starts empty, and on a space page inside that space, shown as a chip; the chip's
 *   cross searches all links. Focus goes back to the opener on close.
 * - The field waits `FIND_DEBOUNCE_MS` after the last key, then asks `/search/quick` with the words
 *   and the space. A turn number rises on every input, chip removal, close and reopen, and an
 *   answer is shown only if its turn is still current. Only a 200 is shown (a sign-out's redirect
 *   or a failure shows `FIND_FAILED`). A blank field shows nothing and asks nothing.
 * - Each answer shown that carries a receipt is reported at once, through `reportSearch`, the one
 *   place that does (#134): the dialog is a results view of its own, so an opening from it sends
 *   its answer's receipt (`openedScript` reads the nearest `[data-receipt]`).
 * - The first row is highlighted. Up and down move the highlight (the pointer too), Enter clicks
 *   the highlighted link, so the opening is recorded, and closes the dialog. With no current
 *   answer to open, Enter goes to the full results (the form, submitted by script).
 * - Cancel, Escape and a click on the backdrop close it; so does opening a row, and Ask AI, whose
 *   panel would sit behind a modal.
 */
const FIND_DIALOG_JS = `{
const dialog = document.getElementById("find-dialog");
if (dialog) {
const input = dialog.querySelector("#find-q");
const body = dialog.querySelector("#find-body");
const failure = dialog.querySelector(".find-error");
const chip = dialog.querySelector(".find-chip");
const tag = dialog.querySelector("input[name=tag]");
const spaceKey = dialog.getAttribute("data-space") || "";
let scoped = false;
let opener = null;
let turn = 0;
let timer = 0;
let current = false;
let downOnBackdrop = false;
const options = () => [...body.querySelectorAll("[role=option]")];
const highlighted = () => options().findIndex((o) => o.getAttribute("aria-selected") === "true");
const highlight = (index) => {
  const all = options();
  all.forEach((o, i) => o.setAttribute("aria-selected", String(i === index)));
  const on = all[index];
  if (on) {
    input.setAttribute("aria-activedescendant", on.id);
    if (on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
  } else input.removeAttribute("aria-activedescendant");
};
const setScoped = (on) => {
  scoped = on && spaceKey !== "";
  if (chip) chip.hidden = !scoped;
  if (tag) tag.disabled = !scoped;
};
const clear = () => {
  body.replaceChildren();
  failure.textContent = "";
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  current = false;
};
// The one place a shown search is reported (#134): as the results page does, the moment it is shown.
const reportSearch = (receipt) => {
  fetch("/search/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receipt }),
    redirect: "manual",
    keepalive: true,
  }).catch(() => {});
};
const show = (html) => {
  clear();
  body.innerHTML = html;
  const found = options().length > 0;
  input.setAttribute("aria-expanded", String(found));
  highlight(found ? 0 : -1);
  current = true;
  const answer = body.querySelector("[data-receipt]");
  if (answer) reportSearch(answer.getAttribute("data-receipt"));
};
const fail = () => {
  clear();
  failure.textContent = ${JSON.stringify(FIND_FAILED)};
};
const ask = async (mine) => {
  const query = new URLSearchParams({ q: input.value });
  if (scoped) query.set("tag", spaceKey);
  let res = null;
  try {
    res = await fetch("/search/quick?" + query, { redirect: "manual" });
  } catch {}
  if (mine !== turn) return;
  const html = res && res.status === 200 ? await res.text().catch(() => null) : null;
  if (mine !== turn) return;
  if (html === null) fail();
  else show(html);
};
const search = (wait) => {
  turn++;
  clearTimeout(timer);
  current = false;
  if (input.value.trim() === "") return clear();
  const mine = turn;
  timer = setTimeout(() => ask(mine), wait);
};
const open = (from) => {
  if (dialog.open) return;
  opener = from;
  turn++;
  clearTimeout(timer);
  input.value = "";
  clear();
  setScoped(true);
  dialog.showModal();
  input.focus();
};
const closeNow = () => {
  if (dialog.open) dialog.close();
};
document.addEventListener("click", (event) => {
  const link = event.target.closest && event.target.closest("a[data-find-open]");
  if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open(link);
});
document.addEventListener("aye-find-open", () => open(document.activeElement));
dialog.addEventListener("close", () => {
  turn++;
  clearTimeout(timer);
  const now = document.activeElement;
  if ((!now || now === document.body || dialog.contains(now)) && opener && opener.isConnected) opener.focus();
});
input.addEventListener("input", () => search(${FIND_DEBOUNCE_MS}));
input.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const all = options();
    if (all.length === 0) return;
    event.preventDefault();
    highlight((highlighted() + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length);
  } else if (event.key === "Enter") {
    const row = options()[highlighted()];
    if (!current || !row || !row.matches("a[data-open]")) return;
    event.preventDefault();
    row.click();
    closeNow();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeNow();
  }
});
body.addEventListener("pointermove", (event) => {
  const row = event.target.closest && event.target.closest("[role=option]");
  if (row) highlight(options().indexOf(row));
});
if (chip) {
  chip.querySelector(".find-chip-x").addEventListener("click", () => {
    setScoped(false);
    input.focus();
    turn++;
    clearTimeout(timer);
    current = false;
    if (input.value.trim() === "") clear();
    else ask(turn);
  });
}
dialog.querySelector(".find-cancel").addEventListener("click", closeNow);
// The form is submitted by script: the saved-copy page's CSP allows no form action.
dialog.querySelector(".find-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = new URLSearchParams({ q: input.value });
  if (scoped) query.set("tag", spaceKey);
  location.href = "/search?" + query;
});
dialog.addEventListener("pointerdown", (event) => {
  downOnBackdrop = event.target === dialog;
});
dialog.addEventListener("click", (event) => {
  const backdrop = event.target === dialog && downOnBackdrop;
  downOnBackdrop = false;
  if (backdrop || (event.target.closest && event.target.closest("a[data-open], [data-find-close]"))) closeNow();
});
}
}`;

/** The dialog's script; `page()` writes it with `openedScript` for `#find-dialog` after it. */
export const findDialogScript = FIND_DIALOG_JS;

/** The dialog's rules, part of the page's one stylesheet. */
export const findCss = `.find-dialog{width:min(640px,calc(100% - 32px));max-height:calc(100dvh - min(120px,12dvh) - 32px);margin:min(120px,12dvh) auto auto;padding:0;border:0;border-radius:22px;background:var(--surface);color:var(--ink);box-shadow:0 24px 64px rgb(0 0 0 / .28);overflow:hidden}
.find-dialog[open]{display:flex;flex-direction:column;animation:save-in var(--motion-fade) var(--ease-out)}
.find-dialog::backdrop{background:rgb(20 20 24 / .38)}
.find-form{display:flex;align-items:center;gap:var(--space-2);margin:0;padding:var(--space-3) var(--space-3) var(--space-2)}
.find-bar{flex:1;min-width:0;display:flex;align-items:center;gap:10px;min-height:54px;padding:6px 10px 6px 18px;border:1.5px solid var(--field);border-radius:var(--radius-pill);background:var(--surface)}
.find-bar>svg{flex:none;fill:none;stroke:var(--soft);stroke-width:2;stroke-linecap:round}
.find-bar input{flex:1;min-width:0;width:auto;margin:0;padding:10px 0;border:0;border-radius:0;background:transparent;font-size:var(--text-6)}
.find-bar input::placeholder{color:var(--soft)}
.find-bar input:focus-visible{outline:none}
.find-bar:has(input:focus-visible){outline:3px solid var(--blue);outline-offset:2px}
.find-esc{flex:none}
.find-chip{flex:none;display:inline-flex;align-items:center;gap:6px;padding:2px 2px 2px 10px;border-radius:var(--radius-pill);background:var(--bg);font-size:var(--text-4);font-weight:600}
.find-chip[hidden]{display:none}
.find-chip .dot{flex:none;width:8px;height:8px;margin:0;background:var(--space,var(--field))}
.find-chip-x{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin:-8px -6px -8px -4px;padding:0;border:0;background:none;color:var(--soft)}
.find-chip-x svg{fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}
.find-cancel{display:none;min-height:44px;padding:0 8px;border:0;background:none}
.find-error{margin:0;padding:var(--space-2) 26px var(--space-4);font-size:var(--text-3)}.find-error:empty{display:none}
.find-body{min-height:0;overflow-y:auto;overscroll-behavior:contain}
.find-list{list-style:none;margin:0;padding:var(--space-1) var(--space-2) var(--space-2)}
.find-row{display:flex;align-items:center;gap:14px;padding:10px 12px;border-radius:14px;color:var(--ink);text-decoration:none}
.find-row[aria-selected=true]{background:color-mix(in srgb,var(--ink) 7%,transparent)}
.find-pic{flex:none;width:48px;height:48px;border-radius:12px;object-fit:cover;background:var(--pic);--icon:34px;--initials:17px}
img.find-pic{display:block}
.find-pic .site-icon{padding:3px;box-shadow:none}
.find-text{flex:1;min-width:0;display:flex;flex-direction:column}
.find-title{font-size:var(--text-5);font-weight:600;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.find-why{font-size:var(--text-4);color:var(--about);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.find-text .card-line{flex-wrap:nowrap;white-space:nowrap;overflow:hidden}
.find-foot{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);padding:10px 22px 14px;border-top:1px solid var(--line)}
.find-all{display:inline-flex;align-items:center;min-height:44px;font-size:var(--text-4);font-weight:600}
.find-keys{font-size:var(--text-2);color:var(--soft)}
.find-nothing{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:14px 26px 24px}
.find-nothing p{margin:0}
.find-nothing-title{font-weight:600}
.find-nothing-hint{margin-bottom:var(--space-2);font-size:var(--text-4);color:var(--about)}
@media (hover:none){.find-esc,.find-keys{display:none}}
@media (max-width:600px){.find-dialog{inset:12px 0 0;width:100%;max-width:100%;height:auto;max-height:none;margin:0;border-radius:22px 22px 0 0}.find-dialog[open]{animation:save-up var(--motion-slide) var(--ease-out)}.find-form{padding:var(--space-3) var(--space-3) var(--space-2) var(--space-4)}.find-bar{min-height:48px;padding:4px 14px}.find-esc,.find-keys{display:none}.find-cancel{display:inline-flex;align-items:center;font-size:var(--text-5);font-weight:600}.find-list{padding:var(--space-1) 6px}.find-row{gap:12px;padding:10px}.find-pic{width:44px;height:44px;--icon:32px;--initials:17px}.find-title{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.find-foot{display:block;padding:var(--space-2) var(--space-4) var(--space-4);border-top:0}.find-all{display:flex;justify-content:center;min-height:48px;border-radius:var(--radius-pill);background:var(--bg)}}`;
