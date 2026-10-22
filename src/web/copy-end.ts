import type { HandyView } from "../core/tools.js";
import type { Link } from "../core/types.js";
import type { MenuItem } from "./card-menu.js";
import type { Back } from "./copy-page.js";
import {
  BRING_BACK_ITEM,
  DONE_ITEM,
  doneLinkScript,
  OUT_OF_LISTS,
  outOfListsMarker,
  PUT_AWAY_ITEM,
  PUT_AWAY_MARKER,
  STALE_MARKER,
} from "./done-link.js";
import { KEEP_ITEM, keepHandyScript, NOT_HANDY } from "./keep-handy.js";
import { escapeHtml } from "./page.js";
import { CARD_FETCH } from "./tell-why.js";

const QUESTION = "Finished with this link?";
const ACTIVE_ID = "copy-end-active";
const OUT_ID = "copy-end-out";
const ERROR_ID = "copy-end-error";

/** The frame the end row's buttons act on: the one element carrying the link's `data-id`. */
const FRAME_ID = "copy-frame";

/** The grey Back link to where the owner came from, at the top of the page and again below the row. */
export const backLink = (back: Back) =>
  `<a class="back-link" href="${escapeHtml(back.href)}"><span aria-hidden="true">←</span> Back to ${escapeHtml(back.label)}</a>`;

const button = ({ act, text }: MenuItem, hidden = false) =>
  `<button type="button" data-act="${act}"${hidden ? " hidden" : ""}>${escapeHtml(text)}</button>`;

/**
 * What follows the article: "Finished with this link?" with the menu's actions as buttons, or,
 * for a link out of your lists, that and Bring it back. Both groups are always written and one is
 * hidden, so the page's script only switches them. Its Keep handy control is `keepHandyScript`'s.
 */
export function copyEnd(link: Link, handy: HandyView | null, back: Back): string {
  const out = outOfListsMarker(link);
  const kept = handy?.status === "kept";
  return `<section class="copy-end" id="copy-end" aria-label="${QUESTION}">
<div class="copy-end-acts" id="${ACTIVE_ID}"${out ? " hidden" : ""}>
<span class="copy-end-label" tabindex="-1">${QUESTION}</span>
${button(DONE_ITEM)}
${button(PUT_AWAY_ITEM)}
<span data-handy>${button(KEEP_ITEM, kept)}<span class="handy-on"${kept ? "" : " hidden"}>${button(NOT_HANDY)}</span></span>
</div>
<div class="copy-end-acts" id="${OUT_ID}"${out ? "" : " hidden"}>
<p class="card-line copy-end-line" tabindex="-1"><span>${OUT_OF_LISTS}</span><span>${out ?? PUT_AWAY_MARKER}</span></p>
${button(BRING_BACK_ITEM)}
</div>
<p class="error" id="${ERROR_ID}" role="alert"></p>
${backLink(back)}
</section>`;
}

/**
 * The end row's one script, the same for every link (it holds no link data). The copy page's
 * `takeOut` keeps the frame on the page and shows the row the route's `change.after` describes (an
 * opening, which brings a put-away link back, passes none: active). Its put-back shows
 * `change.before`. Focus goes to the shown group, so the Undo bar's return stays below the article.
 */
export const COPY_END_SCRIPT = `${CARD_FETCH}
const takeOut = (listRoot, card, remove, change) => {
  const active = card.querySelector(${JSON.stringify(`#${ACTIVE_ID}`)});
  const out = card.querySelector(${JSON.stringify(`#${OUT_ID}`)});
  const marker = out.querySelector(".card-line > :last-child");
  const show = (state) => {
    const isOut = !!state && state.state !== "active";
    active.hidden = isOut;
    out.hidden = !isOut;
    if (isOut) marker.textContent = state.putAwayAt ? ${JSON.stringify(PUT_AWAY_MARKER)} : ${JSON.stringify(STALE_MARKER)};
    return isOut ? out.querySelector(".copy-end-line") : active.querySelector(".copy-end-label");
  };
  if (change) show(change.after).focus();
  else show(null);
  return () => {
    if (change) show(change.before).focus();
  };
};
${doneLinkScript(FRAME_ID, ERROR_ID)}
${keepHandyScript(FRAME_ID, ERROR_ID)}
{
const endRoot = document.getElementById("copy-end");
endRoot.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-act]");
  if (button && button.dataset.act in STATE_ACTS) stateCard(button.closest("[data-id]"), button.dataset.act);
});
}`;
