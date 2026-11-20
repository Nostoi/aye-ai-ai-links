import type { DigestLink, DigestReason } from "../core/digest.js";
import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import { linkSpace } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { LinkView } from "../core/tools.js";
import type { Link, Source, Tag } from "../core/types.js";
import { isWebUrl } from "../core/url-key.js";
import type { Ask } from "./ask-panel.js";
import { cardLine } from "./card-line.js";
import { removeCopyScript } from "./copy-menu.js";
import { deleteLinkScript } from "./delete-link.js";
import { ARCHIVE, ARCHIVE_HINT, ARCHIVE_LABEL, archiveLinkScript } from "./done-link.js";
import { editData, editDialog, editLinkScript, editMenu } from "./edit-link.js";
import { SHELF_SCRIPT } from "./handy-shelf.js";
import { CHECK, intentLinkScript, KEEP_HINT } from "./intent.js";
import { whyText } from "./link-rows.js";
import { linkTitle, openedScript, openLink } from "./open-link.js";
import { escapeHtml, page, savedOn } from "./page.js";
import { SEARCH_PLACEHOLDER, spaceClass, tile } from "./pages.js";
import { SKIP_HINT, SKIP_ICON, SKIP_UNDO, SKIP_WORKING } from "./skip.js";
import { slideButton } from "./slide-button.js";
import { SPACES_ID } from "./spaces-section.js";
import { askWhy, CARD_FETCH, tellWhyScript, WHY_LABEL, whyAnswer } from "./tell-why.js";
import { TIDY_SCRIPT } from "./tidy-script.js";
import { type TidyTrayInput, tidyTray } from "./tidy-tray.js";
import { spine } from "./tray-spine.js";

/**
 * What Explore shows: the picks, the image version of each that has one, now, and the owner's
 * tags, which give each card its space (`linkSpace`). For every card shown: what the edit dialog
 * needs about its picture (`pictures`), its saved copy (`copies`), and its Keep handy state and
 * gone check (`views`).
 */
export type WorthCards = {
  links: DigestLink[];
  images: Map<string, ShownPicture>;
  now: Date;
  catalog: Tag[];
  pictures?: Map<string, PictureInfo>;
  copies?: Map<string, CopyInfo>;
  views?: Map<string, LinkView>;
};

/**
 * "mentions X, which you're working on" for the first two matched words, or the guess form for an
 * entry an agent inferred. Plain text: `cardLine` escapes the reason.
 */
function mentions(words: string[], source: Source): string {
  const named = words.slice(0, 2).join(" and ");
  return source === "inferred"
    ? `mentions ${named}, which may be what you're working on (a guess)`
    : `mentions ${named}, which you're working on`;
}

/**
 * Why a card is shown, as the end of its grey line (`cardLine`'s `reason`): a focus entry first.
 * One an agent inferred is a guess, never something the owner said. The plain reason is the saved
 * date, so the line shows it once.
 */
function reason({ link, reasons }: DigestLink, now: Date): string {
  const focus = reasons.find(
    (r): r is Extract<DigestReason, { kind: "focus_words" }> => r.kind === "focus_words",
  );
  if (focus) return mentions(focus.words, focus.focus.source);
  if (reasons.some((r) => r.kind === "not_opened_recently")) return "saved over a month ago";
  return `saved ${savedOn(link.savedAt, now)}`;
}

/**
 * A card's opening tag: its classes and space, its id, and what the edit dialog reads. Every card
 * is To explore, so `showIntent` hides it once the link is not (`data-explore-only`).
 */
function opening(classes: string, link: Link, cards: WorthCards): string {
  const space = spaceClass(linkSpace(link, cards.catalog));
  return `<article class="${classes}${space}" data-id="${escapeHtml(link.id)}" data-explore-only${editData(link, cards.images.get(link.id), cards.pictures?.get(link.id))}>`;
}

/**
 * "Opened. Keep it or archive it?", drawn hidden until the link has been opened, and shown at once
 * by Home's script when the card's link is opened.
 */
const openedLine = (link: Link, className: string) =>
  `<p class="${className}" data-opened${link.lastOpenedAt === null ? " hidden" : ""}><b>Opened.</b> Keep it or archive it?</p>\n`;

/**
 * The featured card: a small picture on the left, the title, the why (or Tell me why, in amber),
 * the grey line ending with the reason and Saved copy, the opened line, then Open it (the page's one
 * filled button), then Keep, Skip and Archive as icon buttons that open to show their label and a
 * small line saying what happens (`slideButton`). The ⋯ is without those three.
 */
function featured(d: DigestLink, cards: WorthCards): string {
  const { link } = d;
  const copy = cards.copies?.get(link.id);
  const open = isWebUrl(link.url)
    ? `<div class="feature-open">${openLink(link, "Open it", "button primary")}</div>\n`
    : "";
  const said = link.why
    ? `<p>${link.why.source === "inferred" ? whyText(link.why) : `<span class="why-label">${WHY_LABEL}</span>${escapeHtml(link.why.text)}`}</p>`
    : `${askWhy(link)}\n${whyAnswer("p", undefined, WHY_LABEL)}`;
  return `${opening(`worth-card worth-feature${link.why ? "" : " needs-you"}`, link, cards)}
<h3 data-card-title>${linkTitle(link)}</h3>
<div class="feature-why">${said}</div>
${cardLine(link, { copy, reason: reason(d, cards.now), from: "/" })}${openedLine(link, "opened")}<div class="feature-buttons">
${open}<div class="feature-quiet">
${slideButton("intent-keep", CHECK, "Keep", KEEP_HINT)}
${slideButton("snooze", SKIP_ICON, "Skip", SKIP_HINT)}
${slideButton("archive", ARCHIVE, ARCHIVE_LABEL, ARCHIVE_HINT)}
</div>
</div>
${editMenu(link, { copy, handy: cards.views?.get(link.id)?.handy, onCard: true })}
${tile(link, cards.images.get(link.id), "feature-pic")}
</article>`;
}

/** A More to explore row: a small picture (hidden on a phone), the title, `line`, and the seven-row ⋯. */
function row(link: Link, cards: WorthCards, line: string): string {
  const copy = cards.copies?.get(link.id);
  const handy = cards.views?.get(link.id)?.handy;
  return `${opening("worth-row", link, cards)}
${tile(link, cards.images.get(link.id), "also-pic")}
<div class="also-body">
<h4 data-card-title>${linkTitle(link)}</h4>
${line}</div>
${editMenu(link, { copy, handy, skip: true })}
</article>`;
}

/**
 * A pick's row says its why, or else its site and when it was saved, then the opened line; it
 * never links the copy.
 */
const pickRow = (link: Link, cards: WorthCards) =>
  row(
    link,
    cards,
    (link.why
      ? `<p class="also-why">${whyText(link.why)}</p>\n`
      : cardLine(link, { saved: savedOn(link.savedAt, cards.now) })) +
      openedLine(link, "also-open"),
  );

function worthSection(cards: WorthCards): string {
  const [first, ...rest] = cards.links;
  const rows = rest.map((d) => pickRow(d.link, cards));
  if (!first && rows.length === 0) return "";
  const also =
    rows.length === 0
      ? ""
      : `${first ? `<h3 class="also-today">More to explore</h3>\n` : ""}<div class="worth-rows">\n${rows.join("\n")}\n</div>\n`;
  return `<section class="worth" aria-labelledby="worth">
${spine("explore")}
<h2 id="worth" class="visually-hidden">Explore</h2>
<p id="home-error" role="alert"></p>
<div id="worth-cards">
${first ? `${featured(first, cards)}\n` : ""}${also}</div>
</section>`;
}

/**
 * Home's own card actions, after the shared ones (`takeOut`, `archiveCard`, `refreshShelf`):
 * - The featured card's Archive is `archiveCard`, as the menu's row is (`archiveLinkScript`), and
 *   its Keep is the menu's Keep it (`intentLinkScript`).
 * - Skip, Keep handy and Not handy anymore post first and change the card only once the server
 *   agrees, so a refusal never brings back a card another action took out. Each runs in
 *   `whileBusy`, so a card takes no other action, Delete link included, until it has finished.
 * - Skip and Keep handy take the card out (`takeOut`); Keep handy also refreshes the Handy
 *   shelf. Not handy anymore swaps the menu's row and refreshes the shelf. Each offers Undo, and
 *   the card stays as it is when Undo is refused.
 * - A page shown again from the back-forward cache reloads.
 */
const HOME_ACTS = `{
const homeError = document.getElementById("home-error");
const worthCards = document.getElementById("worth-cards");
const answerOf = async (res, field) => {
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
// What a button says while its action is slow; a ⋯ menu row has none and only dims the card.
const homeWords = { snooze: ${JSON.stringify(SKIP_WORKING)} };
const homeActs = {
  snooze: async (card, id, answered, ticket) => {
    const res = await post("/home/snooze", { id });
    answered();
    const data = await answerOf(res, "until");
    if (!data) return failure(res);
    const putBack = takeOut(worthCards, card, false);
    const { until, previous } = data;
    showUndo(ticket, ${JSON.stringify(SKIP_UNDO.text)}, async () =>
      undoOr(await post("/home/unsnooze", { id, until, previous }), putBack),
    ${JSON.stringify(SKIP_UNDO.title)});
  },
  keep: async (card, id, answered, ticket) => {
    const res = await post("/tools/keep", { id });
    answered();
    const moved = await answerOf(res, "tool");
    if (!moved) return failure(res);
    const putBack = takeOut(worthCards, card, false);
    await refreshShelf();
    showUndo(ticket, "Kept on your Handy shelf.", async () =>
      undoOr(await post("/tools/undo", { id, tool: moved.tool, previous: moved.previous, intent: moved.intent }), async () => {
        putBack();
        await refreshShelf();
      }),
    );
  },
  "not-handy": async (card, id, answered, ticket) => {
    const res = await post("/tools/not-handy", { id });
    answered();
    const moved = await answerOf(res, "tool");
    if (!moved) return failure(res);
    showHandy(card, false);
    await refreshShelf();
    showUndo(ticket, "Not handy anymore.", async () =>
      undoOr(await post("/tools/undo", { id, tool: moved.tool, previous: moved.previous, intent: moved.intent }), async () => {
        showHandy(card, true);
        await refreshShelf();
      }),
    );
  },
};
if (worthCards) {
  const showOpened = (event) => {
    const link = event.target.closest("a[data-open]");
    if (!link || (event.type === "auxclick" && event.button !== 1)) return;
    for (const el of link.closest("[data-id]").querySelectorAll("[data-opened]")) el.hidden = false;
  };
  worthCards.addEventListener("click", showOpened);
  worthCards.addEventListener("auxclick", showOpened);
  worthCards.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const menu = button.closest("details.card-menu");
    const card = button.closest("[data-id]");
    if (button.dataset.act === "archive" && !menu) return archiveCard(card, undefined, button);
    const act = homeActs[button.dataset.act];
    if (!act) return;
    if (menu) menu.open = false;
    await whileBusy(card, async (answered, ticket) => {
      homeError.textContent = "";
      const refused = await act(card, card.dataset.id, answered, ticket);
      if (refused) homeError.textContent = refused;
    }, { button: menu ? null : button, word: homeWords[button.dataset.act] });
  });
}
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
}`;

/**
 * Home: the big question, the page's one heading, and one search field, then `shelf`, the Handy
 * shelf (#125), then Explore when there is anything to show, then `spaces`, the "Your spaces"
 * section (#96). Opening a card's link is recorded with `/links/opened`, as every opening is, and
 * shows the card's opened line. The cards' Delete link, Remove saved
 * copy, Edit, Archive, gone line and Tell me why are the shared scripts'; the rest is
 * `HOME_ACTS`. With the Ask AI panel, the page's edit dialog is the panel's. The last tray,
 * `tidyTray`, is always drawn (#347); `tidy`, when the route has links to ask about (#198, #332),
 * fills it, and `TIDY_SCRIPT` then works it in place; its opening of a link is recorded like the
 * Handy shelf's.
 */
export const homePage = ({
  worth,
  shelf,
  spaces,
  tidy,
  ask,
}: {
  worth: WorthCards;
  shelf: string;
  spaces: string;
  tidy?: TidyTrayInput | undefined;
  ask?: Ask | undefined;
}) => {
  const section = worthSection(worth);
  const ownEdit = section !== "" && ask === undefined;
  const asking = (tidy?.queue.length ?? 0) > 0;
  return page(
    "Aye-AI-AI Links",
    `<main class="home">
<form class="home-search" action="/search" method="get" role="search">
<h1 class="question"><label for="q">What are you trying to remember?</label></h1>
<div class="search-box">
<input id="q" name="q" type="search" placeholder="${SEARCH_PLACEHOLDER}">
<kbd aria-hidden="true">/</kbd>
<button class="primary" type="submit">Find it</button>
</div>
<p class="small hint">Describe it however you remember it: when, why, what it looked like.</p>
</form>
${shelf}
${section}
${spaces}
${tidyTray(tidy)}</main>
${ownEdit ? `${editDialog()}\n` : ""}<script>
${CARD_FETCH}
${SHELF_SCRIPT}
${tellWhyScript("worth-cards", "home-error")}
${deleteLinkScript("worth-cards", "home-error")}
${archiveLinkScript("worth-cards", "home-error")}
${intentLinkScript("worth-cards", "home-error", true)}
${removeCopyScript("worth-cards", "home-error")}
${ownEdit ? `${editLinkScript("worth-cards", "home-error")}\n` : ""}${HOME_ACTS}
${asking ? TIDY_SCRIPT : ""}
</script>
${openedScript("worth-cards", "/links/opened")}
${openedScript("handy", "/links/opened")}
${openedScript(SPACES_ID, "/links/opened")}${asking ? `\n${openedScript("tidy", "/links/opened")}` : ""}`,
    {
      menu: true,
      here: "home",
      undo: true,
      ask,
      edits: { root: "worth-cards", error: "home-error" },
    },
  );
};
