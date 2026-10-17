import type { DigestLink, DigestReason } from "../core/digest.js";
import { linkSpace } from "../core/link-space.js";
import type { Link, Tag } from "../core/types.js";
import { SHELF_SCRIPT } from "./handy-shelf.js";
import { isWebUrl, linkTitle, openedScript, openLink } from "./open-link.js";
import { escapeHtml, page, savedOn } from "./page.js";
import { spaceClass, tile } from "./pages.js";
import { askWhy, CARD_FETCH, tellWhyScript, whyAnswer } from "./tell-why.js";

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

/** The saved date (left out when the reason already says it) and the why, or where it will go. */
function meta(link: Link, now: Date, withDate: boolean): string {
  const date = withDate ? `Saved ${savedOn(link.savedAt, now)}` : null;
  if (!link.why)
    return `<p class="small meta">${date ?? ""}${whyAnswer("span", date ? ", " : "")}</p>`;
  const why = `${quoted(link.why.text)}${link.why.source === "inferred" ? " (a guess)" : ""}`;
  return `<p class="small meta">${[date, why].filter((p) => p !== null).join(", ")}</p>`;
}

const BUTTONS = `<button type="button" data-act="snooze">Not now</button>
<button type="button" data-act="archive">I'm done with it</button>`;

function classes(base: string, link: Link, catalog: Tag[]): string {
  return `${base}${link.why ? "" : " needs-you"}${spaceClass(linkSpace(link, catalog))}`;
}

function leadCard(d: DigestLink, cards: WorthCards): string {
  const { link } = d;
  const why = reason(d, cards.now);
  const open = isWebUrl(link.url) ? `${openLink(link, "Open it", "button primary")}\n` : "";
  return `<article class="${classes("worth-card worth-lead", link, cards.catalog)}" data-id="${escapeHtml(link.id)}">
${tile(link, cards.images.get(link.id), "worth-image")}
<div class="worth-body">
<p class="reason">${why.text}</p>
<h3>${linkTitle(link)}</h3>
${meta(link, cards.now, !why.plain)}
${askWhy(link)}
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
<h3>${linkTitle(link)}</h3>
${meta(link, cards.now, true)}
${askWhy(link)}
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
 * The cards' buttons. Opening a link is recorded by `openedScript` with `/home/opened`, which also
 * marks the link surfaced. Not now and I'm done hide the card at once and put it back if the server
 * refuses; Undo asks the server to reverse, and the card stays gone if it cannot. Tell me why is
 * `tellWhyScript`. The Handy shelf's buttons are `SHELF_SCRIPT`'s.
 */
const CARDS_SCRIPT = `<script>
${CARD_FETCH}
${SHELF_SCRIPT}
${tellWhyScript("worth-cards", "home-error")}
const homeError = document.getElementById("home-error");
const cards = document.getElementById("worth-cards");
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
  cards.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const card = button.closest("[data-id]");
    if (button.dataset.act !== "why" && !card.hidden) hideFor(card, button.dataset.act);
  });
}
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
</script>`;

/**
 * Home: the big question and one search field, then `shelf`, the Handy shelf (#125), then "Worth a
 * look today" when there is anything to show, then `spaces`, the "Your spaces" section (#96).
 * Openings from the shelf are recorded without marking the link shown.
 */
export const homePage = ({
  worth,
  shelf,
  spaces,
}: {
  worth: WorthCards;
  shelf: string;
  spaces: string;
}) =>
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
${shelf}
${worthSection(worth)}
${spaces}
</main>
${SLASH_SCRIPT}
${CARDS_SCRIPT}
${openedScript("worth-cards", "/home/opened")}
${openedScript("handy", "/links/opened")}`,
    { menu: true, undo: true },
  );
