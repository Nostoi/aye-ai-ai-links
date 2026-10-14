import type { DigestLink, DigestReason } from "../core/digest.js";
import { linkSpace } from "../core/link-space.js";
import type { Link, Tag } from "../core/types.js";
import { escapeHtml, page, savedOn } from "./page.js";
import { isWebUrl, spaceClass, tile } from "./pages.js";

/**
 * What "Worth a look today" shows: the picks, the image version of each that has one, now, and
 * the owner's tags, which give each card its space (`linkSpace`).
 */
export type WorthCards = {
  links: DigestLink[];
  images: Map<string, string>;
  now: Date;
  catalog: Tag[];
};

const quoted = (text: string) => `"${escapeHtml(text)}"`;

/**
 * The reason a card is shown, in plain words. A focus entry comes first; one an agent inferred is
 * a guess, never something the owner said.
 */
function reason({ link, reasons }: DigestLink, now: Date): { text: string; plain: boolean } {
  const focus = reasons.find(
    (r): r is Extract<DigestReason, { kind: "focus_words" }> => r.kind === "focus_words",
  );
  if (focus) {
    return focus.focus.source === "inferred"
      ? { text: `Maybe you're working on ${quoted(focus.focus.text)} (a guess)`, plain: false }
      : { text: `You said you're working on ${quoted(focus.focus.text)}`, plain: false };
  }
  if (reasons.some((r) => r.kind === "not_opened_recently")) {
    return { text: "You saved this over a month ago", plain: false };
  }
  return { text: `You saved this ${savedOn(link.savedAt, now)}`, plain: true };
}

/** The saved date (left out when the reason already says it) and the why. */
function meta(link: Link, now: Date, withDate: boolean): string {
  const why = link.why
    ? `${quoted(link.why.text)}${link.why.source === "inferred" ? " (a guess)" : ""}`
    : null;
  const parts = [withDate ? `Saved ${savedOn(link.savedAt, now)}` : null, why];
  return `<p class="small meta">${parts.filter((p) => p !== null).join(", ")}</p>`;
}

/** The title, linked to open in a new tab when it is a web link. */
function title(link: Link): string {
  const label = escapeHtml(link.title ?? link.url);
  return isWebUrl(link.url)
    ? `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" data-open>${label}</a>`
    : label;
}

/** The amber "needs you" ask, with the field that opens on Tell me why. */
const ask = (link: Link) =>
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

const BUTTONS = `<button type="button" data-act="snooze">Not now</button>
<button type="button" data-act="archive">I'm done with it</button>`;

function classes(base: string, link: Link, catalog: Tag[]): string {
  return `${base}${link.why ? "" : " needs-you"}${spaceClass(linkSpace(link, catalog))}`;
}

function leadCard(d: DigestLink, cards: WorthCards): string {
  const { link } = d;
  const why = reason(d, cards.now);
  const open = isWebUrl(link.url)
    ? `<a class="button primary" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" data-open>Open it</a>\n`
    : "";
  return `<article class="${classes("worth-card worth-lead", link, cards.catalog)}" data-id="${escapeHtml(link.id)}">
${tile(link, cards.images.get(link.id), "worth-image")}
<div class="worth-body">
<p class="reason">${why.text}</p>
<h3>${title(link)}</h3>
${meta(link, cards.now, !why.plain)}
${ask(link)}
<div class="actions">
${open}${BUTTONS}
</div>
</div>
</article>`;
}

function smallCard({ link }: DigestLink, cards: WorthCards): string {
  return `<article class="${classes("worth-card worth-small", link, cards.catalog)}" data-id="${escapeHtml(link.id)}">
${tile(link, cards.images.get(link.id), "worth-tile")}
<div class="worth-body">
<h3>${title(link)}</h3>
${meta(link, cards.now, true)}
${ask(link)}
<div class="actions small-actions">
${BUTTONS}
</div>
</div>
</article>`;
}

function worthSection(cards: WorthCards): string {
  const [lead, ...rest] = cards.links;
  if (!lead) return "";
  const side = rest.slice(0, 2);
  return `<section class="worth" aria-labelledby="worth">
<h2 id="worth">Worth a look today</h2>
<p id="home-error" role="alert"></p>
<div class="worth-grid" id="worth-cards">
${leadCard(lead, cards)}
${side.length > 0 ? `<div class="worth-side">\n${side.map((d) => smallCard(d, cards)).join("\n")}\n</div>` : ""}
</div>
</section>`;
}

/** Lets `/` jump to the search field unless the owner is typing. */
const SLASH_SCRIPT = `<script>
document.addEventListener("keydown", (event) => {
  if (event.key !== "/") return;
  const active = document.activeElement;
  if (active && (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) return;
  event.preventDefault();
  document.getElementById("q").focus();
});
</script>`;

/**
 * The cards' buttons. Opening a link (a click, or a middle click) records it with a keepalive post
 * and lets the link open. Not now and I'm done hide the card at once and put it back if the server
 * refuses; Undo asks the server to reverse, and the card stays gone if it cannot. Tell me why posts
 * the owner's answer and replaces the question with it.
 */
const CARDS_SCRIPT = `<script>
const homeError = document.getElementById("home-error");
const cards = document.getElementById("worth-cards");
const post = (url, body, extra) =>
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
const opened = (event) => {
  const link = event.target.closest("a[data-open]");
  if (!link || (event.type === "auxclick" && event.button !== 1)) return;
  post("/home/opened", { id: link.closest("[data-id]").dataset.id }, { keepalive: true });
};
const hideFor = async (card, act) => {
  const id = card.dataset.id;
  homeError.textContent = "";
  card.hidden = true;
  const res = await post("/home/" + act, { id });
  let undo = null;
  if (act === "snooze") {
    const data = res && res.status === 200 ? await res.json().catch(() => null) : null;
    if (data && typeof data.until === "string") {
      const { until, claimedAt, previousSurfacedAt } = data;
      undo = ["Hidden for two weeks.", "/home/unsnooze", { id, until, claimedAt, previousSurfacedAt }];
    }
  } else if (res && res.status === 204) {
    undo = ["Moved out of your list.", "/home/unarchive", { id }];
  }
  if (!undo) {
    card.hidden = false;
    homeError.textContent = await failure(res);
    return;
  }
  showUndo(undo[0], async () => {
    const back = await post(undo[1], undo[2]);
    if (back && back.status === 204) card.hidden = false;
    else homeError.textContent = await failure(back);
  });
};
if (cards) {
  cards.addEventListener("click", opened);
  cards.addEventListener("auxclick", opened);
  cards.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const card = button.closest("[data-id]");
    if (button.dataset.act === "why") {
      const form = card.querySelector("form.why-form");
      form.hidden = false;
      form.querySelector("input").focus();
    } else if (!card.hidden) {
      hideFor(card, button.dataset.act);
    }
  });
  cards.addEventListener("submit", async (event) => {
    const form = event.target.closest("form.why-form");
    if (!form) return;
    event.preventDefault();
    const card = form.closest("[data-id]");
    const input = form.querySelector("input");
    const submit = form.querySelector("button");
    homeError.textContent = "";
    if (input.value.trim() === "" || submit.disabled) return;
    submit.disabled = true;
    const res = await post("/home/why", { id: card.dataset.id, text: input.value });
    submit.disabled = false;
    if (!res || res.status !== 204) {
      homeError.textContent = await failure(res);
      return;
    }
    const meta = card.querySelector(".meta");
    meta.textContent = (meta.textContent ? meta.textContent + ", " : "") + '"' + input.value.trim() + '"';
    card.querySelector(".ask").remove();
    card.classList.remove("needs-you");
  });
}
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
</script>`;

/**
 * Home: the big question and one search field, then "Worth a look today" when there is anything
 * to show, then `spaces`, the "Your spaces" section (#96), as HTML.
 */
export const homePage = ({ worth, spaces }: { worth: WorthCards; spaces: string }) =>
  page(
    "Aye-AI-AI Links",
    `<main class="home">
<form class="home-search" action="/search" method="get" role="search">
<label class="question" for="q">What are you trying to remember?</label>
<div class="search-box">
<input id="q" name="q" type="search" placeholder="That article about batteries and the tax credit">
<kbd aria-hidden="true">/</kbd>
<button class="primary" type="submit">Find it</button>
</div>
<p class="small hint">Describe it however you remember it: when, why, what it looked like.</p>
</form>
${worthSection(worth)}
${spaces}
</main>
${SLASH_SCRIPT}
${CARDS_SCRIPT}`,
    { menu: true, undo: true },
  );
