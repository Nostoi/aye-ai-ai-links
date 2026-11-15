import { escapeHtml } from "../core/escape-html.js";
import type { Link } from "../core/types.js";
import { BAND_COLLAPSE } from "./band-collapse.js";

/** The amber "needs you" ask on a card with no why, with the field that opens on Tell me why. */
export const askWhy = (link: Link) =>
  link.why
    ? ""
    : `<div class="ask">
<p class="small">Why did you save this?</p>
<button class="tell-why" type="button" data-act="why">Tell me why</button>
<form class="why-form" hidden>
<label class="visually-hidden" for="why-${escapeHtml(link.id)}">Why did you save this?</label>
<input id="why-${escapeHtml(link.id)}" name="why" autocomplete="off" required>
<button class="primary" type="submit">Save</button>
</form>
</div>`;

/** The small grey label above a featured card's stated or asked why. */
export const WHY_LABEL = "You saved it for";

/**
 * Where a saved answer is shown as plain text; hidden until then. With a `label`, the answer is
 * that label on its own line above the text.
 */
export const whyAnswer = (tag: "p" | "span", className?: string, label?: string) =>
  `<${tag}${className ? ` class="${className}"` : ""} data-why-answer${label ? ` data-label="${escapeHtml(label)}"` : ""} hidden></${tag}>`;

/** How long an action may stay unanswered before its busy look shows (owner, 2026-11-15, #314). */
const BUSY_LOOK_MS = 300;

/**
 * `post` sends JSON without following a redirect, answering null when the request fails;
 * `failure` is a refusal's own message, or a generic one. `cardBusy` is a card's one busy mark:
 * `whileBusy(card, run, look)` runs `run` and answers what it answers, unless the card is busy,
 * when it runs nothing and answers nothing. The mark is held until `run` has finished, including its
 * page update and Undo, and released whether it returns or throws. Every action on a card that
 * posts goes through it, so a card takes one action at a time. An Undo goes through
 * `whenFree(card, run, look)` instead: it waits for the action in flight, then runs under the mark.
 *
 * The busy look is apart from the mark. `busyLook(el, button, word)` waits 300ms and then sets
 * `data-busy` on `el` (the theme dims it and shows the progress cursor) and, if `button` is still
 * on the page, puts `word` in its label node (an icon button's words, a Tidy choice's `<b>`, or
 * else the button's own text, when it holds no element) and marks it `data-working`; it answers
 * a `clear()` that undoes only that. A faster answer shows nothing. `look` is `{ button, word, el }`:
 * `el` is the busy element, by default the button's nearest `[data-busy-scope]`, else the card.
 * An action with no button (a ⋯ menu row, which closes) passes `{}` and only dims; no `look`
 * shows nothing. `whileBusy` starts the look only once it holds the mark, and clears it first.
 * It also defines `collapseBand` and `resetBand` (`band-collapse.ts`).
 */
export const CARD_FETCH = `const post = (url, body, extra) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    ...extra,
  }).catch(() => null);
const failure = async (res) => {
  const data = res && [400, 404, 409].includes(res.status) ? await res.json().catch(() => null) : null;
  return data && typeof data.message === "string"
    ? data.message
    : "That did not work. Reload the page and try again.";
};
const cardBusy = new WeakSet();
const cardWaiting = new WeakMap();
const busyLook = (el, button, word) => {
  let swapped = null;
  let shown = false;
  const timer = setTimeout(() => {
    shown = true;
    el.setAttribute("data-busy", "");
    if (!button || !button.isConnected) return;
    const node = button.querySelector(".slide-words > span, b") || (button.firstElementChild ? null : button);
    button.setAttribute("data-working", "");
    if (!node) return;
    swapped = { node, was: node.textContent };
    node.textContent = word;
  }, ${BUSY_LOOK_MS});
  return () => {
    clearTimeout(timer);
    if (!shown) return;
    el.removeAttribute("data-busy");
    if (button) button.removeAttribute("data-working");
    if (swapped && swapped.node.textContent === word) swapped.node.textContent = swapped.was;
  };
};
const whileBusy = async (card, run, look) => {
  if (cardBusy.has(card)) return;
  cardBusy.add(card);
  const clear = look
    ? busyLook(look.el || (look.button && look.button.closest("[data-busy-scope]")) || card, look.button, look.word)
    : null;
  try {
    return await run();
  } finally {
    if (clear) clear();
    cardBusy.delete(card);
    for (const wake of cardWaiting.get(card) || []) wake();
    cardWaiting.delete(card);
  }
};
const whenFree = async (card, run, look) => {
  while (cardBusy.has(card))
    await new Promise((wake) => cardWaiting.set(card, [...(cardWaiting.get(card) || []), wake]));
  return whileBusy(card, run, look);
};
${BAND_COLLAPSE}`;

/**
 * Tell me why on the cards inside `#root` (each card has `data-id`): the button opens the field,
 * and a saved answer posts `/home/why`, then replaces the ask with the answer. A refusal is shown
 * in `#error`. Needs `CARD_FETCH`.
 */
export const tellWhyScript = (root: string, error: string) => `{
const whyRoot = document.getElementById(${JSON.stringify(root)});
const whyError = document.getElementById(${JSON.stringify(error)});
if (whyRoot) {
  whyRoot.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act=why]");
    if (!button) return;
    const form = button.closest("[data-id]").querySelector("form.why-form");
    form.hidden = false;
    form.querySelector("input").focus();
  });
  whyRoot.addEventListener("submit", async (event) => {
    const form = event.target.closest("form.why-form");
    if (!form) return;
    event.preventDefault();
    const card = form.closest("[data-id]");
    const input = form.querySelector("input");
    const submit = form.querySelector("button");
    whyError.textContent = "";
    if (input.value.trim() === "" || submit.disabled) return;
    submit.disabled = true;
    const res = await post("/home/why", { id: card.dataset.id, text: input.value });
    submit.disabled = false;
    if (!res || res.status !== 204) {
      whyError.textContent = await failure(res);
      return;
    }
    const answer = card.querySelector("[data-why-answer]");
    const text = input.value.trim();
    if (answer.dataset.label) {
      const label = document.createElement("span");
      label.className = "why-label";
      label.textContent = answer.dataset.label;
      answer.replaceChildren(label, text);
    } else answer.textContent = text;
    answer.hidden = false;
    card.querySelector(".ask").remove();
    card.querySelector(".row-about")?.remove();
    card.classList.remove("needs-you");
  });
}
}`;
