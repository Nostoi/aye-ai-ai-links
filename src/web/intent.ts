import type { Link } from "../core/types.js";
import type { MenuItem } from "./card-menu.js";

export const CHECK = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-4.9"/></svg>`;
const COMPASS = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>`;

/** The words for a link's intent (#339). `explore` is the default, so it has no words on a grey line. */
export const TO_KEEP = "To keep";
export const TO_KEEP_GUESS = "To keep (a guess)";
export const TO_EXPLORE = "To explore";
export const TO_EXPLORE_GUESS = "To explore (a guess)";

/** What Keep says while it waits for the answer (#314). */
export const KEEP_WORKING = "Keeping…";

/** The small line under the featured card's Keep button. */
export const KEEP_HINT = "Not asked again";

/** Keep's line in a Tidy up step. */
export const KEEP_TIDY_LINE = "Moves to To keep. Not asked again.";

/** The card menu's rows: Keep it for a To explore link, Explore it for a To keep one. */
export const KEEP_IT_ITEM: MenuItem = {
  act: "intent-keep",
  icon: CHECK,
  text: "Keep it",
  hint: "Moves to To keep",
};
export const EXPLORE_IT_ITEM: MenuItem = {
  act: "intent-explore",
  icon: COMPASS,
  text: "Explore it",
  hint: "Back on Explore",
};

export const KEEP_IT_UNDO = {
  title: "Kept.",
  text: "Marked To keep. Explore won't show it.",
};
export const EXPLORE_IT_UNDO = {
  title: "Back to explore.",
  text: "Explore may show it again.",
};

/** What a link's intent says on a grey line: a hidden part for explore, so a script can show it. */
export function intentLine(link: Pick<Link, "intent" | "intentSource">): string {
  const keep = link.intent === "keep";
  const text = keep ? (link.intentSource === "inferred" ? TO_KEEP_GUESS : TO_KEEP) : "";
  return `<span data-intent-line${keep ? "" : " hidden"}>${text}</span>`;
}

/**
 * `showIntent(card, intent, source, kept)`, shared by the page scripts that move a card's intent
 * (Keep it, Explore it, their Undo, and Keep handy, which makes a link To keep): it records the
 * pair on the card, shows the menu's Keep it or Explore it (neither once the link is kept handy)
 * and sets the grey line's part, in a guess's words when an agent inferred it. A card marked
 * `data-explore-only` (Explore's) is hidden while the link is not To explore.
 */
export const INTENT_VIEW = `const showIntent = (card, intent, source, kept) => {
  card.dataset.intent = intent;
  card.dataset.intentSource = source || "";
  if (card.hasAttribute("data-explore-only")) card.hidden = intent !== "explore";
  for (const b of card.querySelectorAll(".card-menu button[data-act=intent-keep]")) b.hidden = kept || intent === "keep";
  for (const b of card.querySelectorAll(".card-menu button[data-act=intent-explore]")) b.hidden = kept || intent === "explore";
  for (const part of card.querySelectorAll("[data-intent-line]")) {
    part.hidden = intent !== "keep";
    part.textContent = intent !== "keep" ? "" : source === "inferred" ? ${JSON.stringify(TO_KEEP_GUESS)} : ${JSON.stringify(TO_KEEP)};
  }
};`;

const INTENT_ACTS = {
  "intent-keep": {
    route: "/home/keep",
    undo: KEEP_IT_UNDO,
    word: KEEP_WORKING,
  },
  "intent-explore": {
    route: "/home/explore",
    undo: EXPLORE_IT_UNDO,
  },
};

/**
 * Keep it and Explore it in the ⋯ menus of the cards inside `#root`, including those Show older
 * links appends, and the featured card's Keep button on Home. It posts `/home/keep` or `/home/explore` and, once the answer is the
 * `IntentChange` as JSON, shows `change.after` on the card (`showIntent`), or with `leaves` takes
 * the card out (`takeOut`, as Archive does: Home's Explore cards are the ones that go). Its Undo
 * posts `/home/undo-intent` with that change exactly as received and puts the card back. A card
 * takes no other action while one, or its Undo, is out (`whileBusy`); an Undo clicked meanwhile
 * waits for it (`whenFree`). A refusal, or an Undo that does not succeed, is shown in `#error`.
 * For the page's one script after `CARD_FETCH`, `showUndo` and (with `leaves`) `deleteLinkScript`.
 */
export const intentLinkScript = (root: string, error: string, leaves = false) => `{
${INTENT_VIEW}
const intentActs = ${JSON.stringify(INTENT_ACTS)};
const intentRoot = document.getElementById(${JSON.stringify(root)});
const intentError = document.getElementById(${JSON.stringify(error)});
if (intentRoot) {
  intentRoot.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button || !(button.dataset.act in intentActs)) return;
    const menu = button.closest("details");
    if (menu) menu.open = false;
    const summary = (card) => card.querySelector(".card-menu summary");
    const card = button.closest("[data-id]");
    const { route, undo, word } = intentActs[button.dataset.act];
    whileBusy(card, async (answered, ticket) => {
      const id = card.dataset.id;
      intentError.textContent = "";
      const res = await post(route, { id });
      answered();
      const change = res && res.status === 200 ? await res.json().catch(() => null) : null;
      if (!change || !change.before || !change.after) {
        summary(card).focus();
        intentError.textContent = await failure(res);
        return;
      }
      const putBack = ${leaves ? "takeOut(intentRoot, card, false)" : "null"};
      if (!putBack) {
        showIntent(card, change.after.intent, change.after.intentSource, false);
        summary(card).focus();
      }
      showUndo(ticket, undo.text, () => whenFree(card, async () => {
        const back = await post("/home/undo-intent", { id, change });
        if (!back || back.status !== 204) {
          intentError.textContent = await failure(back);
          return;
        }
        if (putBack) putBack();
        else showIntent(card, change.before.intent, change.before.intentSource, false);
      }), undo.title);
    }, { button: menu ? null : button, word });
  });
}
}`;
