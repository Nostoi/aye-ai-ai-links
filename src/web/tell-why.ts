import type { Link } from "../core/types.js";
import { escapeHtml } from "./page.js";

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

/** Where a saved answer is shown, after `prefix`; hidden until then. */
export const whyAnswer = (tag: "p" | "span", prefix: string, className?: string) =>
  `<${tag}${className ? ` class="${className}"` : ""} data-why-answer data-prefix="${escapeHtml(prefix)}" hidden></${tag}>`;

/**
 * `post` sends JSON without following a redirect, answering null when the request fails;
 * `failure` is a refusal's own message, or a generic one.
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
};`;

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
    answer.textContent = answer.dataset.prefix + '"' + input.value.trim() + '"';
    answer.hidden = false;
    card.querySelector(".ask").remove();
    card.classList.remove("needs-you");
  });
}
}`;
