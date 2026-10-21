import type { DigestLink, DigestReason } from "../core/digest.js";
import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import { linkSpace } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { LinkView } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { isWebUrl } from "../core/url-key.js";
import type { Ask } from "./ask-panel.js";
import { cardLine } from "./card-line.js";
import { removeCopyScript } from "./copy-menu.js";
import { copyHref } from "./copy-page.js";
import { deleteLinkScript } from "./delete-link.js";
import { doneLinkScript, STALE_LABEL } from "./done-link.js";
import { editData, editDialog, editLinkScript, editMenu } from "./edit-link.js";
import { goneLine, goneScript } from "./gone-line.js";
import { SHELF_SCRIPT } from "./handy-shelf.js";
import { monthName, whyText } from "./link-rows.js";
import { linkTitle, openedScript, openLink } from "./open-link.js";
import { escapeHtml, page, savedOn } from "./page.js";
import { spaceClass, tile } from "./pages.js";
import { askWhy, CARD_FETCH, tellWhyScript, whyAnswer } from "./tell-why.js";

/**
 * What "Worth a look today" shows: the picks, the image version of each that has one, now, the
 * owner's tags, which give each card its space (`linkSpace`), and the one link that seems gone
 * (#128). For every card shown, the gone one too: what the edit dialog needs about its picture
 * (`pictures`), its saved copy (`copies`), and its Keep handy state and gone check (`views`).
 */
export type WorthCards = {
  links: DigestLink[];
  images: Map<string, ShownPicture>;
  now: Date;
  catalog: Tag[];
  gone: Link | null;
  pictures?: Map<string, PictureInfo>;
  copies?: Map<string, CopyInfo>;
  views?: Map<string, LinkView>;
};

const quoted = (text: string) => `"${escapeHtml(text)}"`;

/**
 * The reason a card is shown, in plain words. A link that came back says when it was put away;
 * then a focus entry comes. One an agent inferred is a guess, never something the owner said.
 */
function reason({ link, reasons }: DigestLink, now: Date): { text: string; plain: boolean } {
  const back = reasons.find(
    (r): r is Extract<DigestReason, { kind: "came_back" }> => r.kind === "came_back",
  );
  if (back) {
    const when = `You put this away in ${monthName(back.putAwayAt, now)}.`;
    return {
      text:
        back.focus.source === "inferred"
          ? `${when} It may fit ${quoted(back.focus.text)} (a guess).`
          : `${when} It fits ${quoted(back.focus.text)}.`,
      plain: false,
    };
  }
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

/** A card's opening tag: its classes and space, its id, and what the edit dialog reads. */
function opening(classes: string, link: Link, cards: WorthCards): string {
  const space = spaceClass(linkSpace(link, cards.catalog));
  return `<article class="${classes}${space}" data-id="${escapeHtml(link.id)}"${editData(link, cards.images.get(link.id), cards.pictures?.get(link.id))}>`;
}

/**
 * The featured card: the reason with its space's dot, the title, the why (or Tell me why, in
 * amber), the grey line with the saved date when the reason doesn't say it and Saved copy, Open it
 * (the page's one filled button), It's stale and Not now, the ⋯ without those two, and a
 * small picture.
 */
function featured(d: DigestLink, cards: WorthCards): string {
  const { link } = d;
  const why = reason(d, cards.now);
  const copy = cards.copies?.get(link.id);
  const open = isWebUrl(link.url)
    ? `<div class="feature-open">${openLink(link, "Open it", "button primary")}</div>\n`
    : "";
  const said = link.why ? `<p>${whyText(link.why)}</p>` : `${askWhy(link)}\n${whyAnswer("p", "")}`;
  const saved = why.plain ? {} : { saved: savedOn(link.savedAt, cards.now) };
  return `${opening(`worth-card worth-feature${link.why ? "" : " needs-you"}`, link, cards)}
<p class="reason"><span class="dot" aria-hidden="true"></span>${why.text}</p>
<h3 data-card-title>${linkTitle(link)}</h3>
<div class="feature-why">${said}</div>
${cardLine(link, { copy, ...saved })}${open}<div class="feature-quiet">
<button type="button" data-act="archive">${STALE_LABEL}</button>
<button type="button" data-act="snooze">Not now</button>
</div>
${editMenu(link, { copy, handy: cards.views?.get(link.id)?.handy, onCard: true })}
${tile(link, cards.images.get(link.id), "feature-pic")}
</article>`;
}

/** An Also today row: a small picture (hidden on a phone), the title, `line`, and the six-row ⋯. */
function row(link: Link, cards: WorthCards, classes: string, line: string): string {
  const copy = cards.copies?.get(link.id);
  const handy = cards.views?.get(link.id)?.handy;
  return `${opening(`worth-row${classes}`, link, cards)}
${tile(link, cards.images.get(link.id), "also-pic")}
<div class="also-body">
<h4 data-card-title>${linkTitle(link)}</h4>
${line}</div>
${editMenu(link, { copy, handy, notNow: true })}
</article>`;
}

/** A pick's row says its why, or else its site and when it was saved; it never links the copy. */
const pickRow = (link: Link, cards: WorthCards) =>
  row(
    link,
    cards,
    "",
    link.why
      ? `<p class="also-why">${whyText(link.why)}</p>\n`
      : cardLine(link, { saved: savedOn(link.savedAt, cards.now) }),
  );

/**
 * The gone link's row: amber while its warning shows (the theme's), with the shared gone line and,
 * when there is a copy, Read the saved copy right after it (owner ruling, #195 comment
 * 6304329071), which the theme hides with the warning once It still works hides it.
 */
function goneRow(link: Link, cards: WorthCards): string {
  const read = cards.copies?.has(link.id)
    ? `\n<a class="gone-copy" href="${copyHref(link.id)}" data-act="read-copy">Read the saved copy</a>`
    : "";
  return row(
    link,
    cards,
    " worth-gone",
    `${goneLine(link, cards.views?.get(link.id)?.gone)}${read}\n`,
  );
}

function worthSection(cards: WorthCards): string {
  const [first, ...rest] = cards.links;
  const rows = rest.map((d) => pickRow(d.link, cards));
  if (cards.gone) rows.push(goneRow(cards.gone, cards));
  if (!first && rows.length === 0) return "";
  const also =
    rows.length === 0
      ? ""
      : `${first ? `<h3 class="also-today">Also today</h3>\n` : ""}<div class="worth-rows">\n${rows.join("\n")}\n</div>\n`;
  return `<section class="worth" aria-labelledby="worth">
<h2 id="worth">Worth a look today</h2>
<p id="home-error" role="alert"></p>
<div id="worth-cards">
${first ? `${featured(first, cards)}\n` : ""}${also}</div>
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
 * Home's own card actions, after the shared ones (`takeOut`, `doneCard`, `refreshShelf`):
 * - The featured card's It's stale is `doneCard`, as the menu's row is (`doneLinkScript`).
 * - Not now, Keep handy and Not handy anymore post first and change the card only once the server
 *   agrees, so a refusal never brings back a card another action took out. Each runs in
 *   `whileBusy`, so a card takes no other action, Delete link included, until it has finished.
 * - Not now and Keep handy take the card out (`takeOut`); Keep handy also refreshes the Handy
 *   shelf. Not handy anymore swaps the menu's row and refreshes the shelf. Each offers Undo, and
 *   the card stays as it is when Undo is refused.
 * - A page shown again from the back-forward cache reloads.
 */
const HOME_ACTS = `{
const homeError = document.getElementById("home-error");
const worthCards = document.getElementById("worth-cards");
const answered = async (res, field) => {
  const data = res && res.status === 200 ? await res.json().catch(() => null) : null;
  return data && data[field] ? data : null;
};
const undoOr = async (back, then) => {
  if (back && back.status === 204) await then();
  else homeError.textContent = await failure(back);
};
const showHandy = (card, kept) => {
  for (const b of card.querySelectorAll(".card-menu button[data-act=keep]")) b.hidden = kept;
  for (const b of card.querySelectorAll(".card-menu button[data-act=not-handy]")) b.hidden = !kept;
};
const homeActs = {
  snooze: async (card, id) => {
    const res = await post("/home/snooze", { id });
    const data = await answered(res, "until");
    if (!data) return failure(res);
    const putBack = takeOut(worthCards, card, false);
    const { until, claimedAt, previousSurfacedAt } = data;
    showUndo("Hidden for two weeks.", async () =>
      undoOr(await post("/home/unsnooze", { id, until, claimedAt, previousSurfacedAt }), putBack),
    );
  },
  keep: async (card, id) => {
    const res = await post("/tools/keep", { id });
    const moved = await answered(res, "tool");
    if (!moved) return failure(res);
    const putBack = takeOut(worthCards, card, false);
    await refreshShelf();
    showUndo("Kept on your Handy shelf.", async () =>
      undoOr(await post("/tools/undo", { id, tool: moved.tool, previous: moved.previous }), async () => {
        putBack();
        await refreshShelf();
      }),
    );
  },
  "not-handy": async (card, id) => {
    const res = await post("/tools/not-handy", { id });
    const moved = await answered(res, "tool");
    if (!moved) return failure(res);
    showHandy(card, false);
    await refreshShelf();
    showUndo("Not handy anymore.", async () =>
      undoOr(await post("/tools/undo", { id, tool: moved.tool, previous: moved.previous }), async () => {
        showHandy(card, true);
        await refreshShelf();
      }),
    );
  },
};
if (worthCards) {
  worthCards.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const menu = button.closest("details.card-menu");
    const card = button.closest("[data-id]");
    if (button.dataset.act === "archive" && !menu) return doneCard(card);
    const act = homeActs[button.dataset.act];
    if (!act) return;
    if (menu) menu.open = false;
    await whileBusy(card, async () => {
      homeError.textContent = "";
      const refused = await act(card, card.dataset.id);
      if (refused) homeError.textContent = refused;
    });
  });
}
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
}`;

/** Tidy up's quiet start line at the bottom of Home (#198); the route decides when to show it. */
const TIDY_START = `<section class="tidy-start" aria-label="Tidy up">
<div>
<p>Clear out a few old links?</p>
<p class="small">Five, one at a time. Nothing gets deleted.</p>
</div>
<a href="/tidy">Start</a>
</section>
`;

/**
 * Home: the big question, the page's one heading, and one search field, then `shelf`, the Handy
 * shelf (#125), then "Worth a look today" when there is anything to show, then `spaces`, the "Your
 * spaces" section (#96). Opening a card's link is recorded with `/home/opened`, which also marks it
 * shown; openings from the shelf are recorded without that. The cards' Delete link, Remove saved
 * copy, Edit, It's stale, gone line and Tell me why are the shared scripts'; the rest is
 * `HOME_ACTS`. With the Ask AI panel, the page's edit dialog is the panel's.
 */
export const homePage = ({
  worth,
  shelf,
  spaces,
  tidy = false,
  ask,
}: {
  worth: WorthCards;
  shelf: string;
  spaces: string;
  tidy?: boolean;
  ask?: Ask | undefined;
}) => {
  const section = worthSection(worth);
  const ownEdit = section !== "" && ask === undefined;
  return page(
    "Aye-AI-AI Links",
    `<main class="home">
<form class="home-search" action="/search" method="get" role="search">
<h1 class="question"><label for="q">What are you trying to remember?</label></h1>
<div class="search-box">
<input id="q" name="q" type="search" placeholder="That article about batteries and the tax credit">
<kbd aria-hidden="true">/</kbd>
<button class="primary" type="submit">Find it</button>
</div>
<p class="small hint">Describe it however you remember it: when, why, what it looked like.</p>
</form>
${shelf}
${section}
${spaces}
${tidy ? TIDY_START : ""}</main>
${ownEdit ? `${editDialog()}\n` : ""}${SLASH_SCRIPT}
<script>
${CARD_FETCH}
${SHELF_SCRIPT}
${tellWhyScript("worth-cards", "home-error")}
${deleteLinkScript("worth-cards", "home-error")}
${doneLinkScript("worth-cards", "home-error")}
${goneScript("worth-cards", "home-error")}
${removeCopyScript("worth-cards", "home-error")}
${ownEdit ? `${editLinkScript("worth-cards", "home-error")}\n` : ""}${HOME_ACTS}
</script>
${openedScript("worth-cards", "/home/opened")}
${openedScript("handy", "/links/opened")}`,
    { menu: true, undo: true, ask, edits: { root: "worth-cards", error: "home-error" } },
  );
};
