import type { ShownPicture } from "../core/image-store.js";
import { linkSpace } from "../core/link-space.js";
import type { TidyLink } from "../core/tidy-up.js";
import type { FocusEntry, Link, Tag } from "../core/types.js";
import { isWebUrl } from "../core/url-key.js";
import { cardLine } from "./card-line.js";
import { ARCHIVE_TIDY_LINE } from "./done-link.js";
import { GONE_TEXT, STILL_WORKS_TIDY_LINE } from "./gone-line.js";
import { KEEP_TIDY_LINE } from "./intent.js";
import { monthName } from "./link-rows.js";
import { linkTitle, openLink } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { spaceClass, tile } from "./pages.js";
import { SKIP_TIDY_LINE } from "./skip.js";

/** What Home's Tidy up tray shows: the queue, and what each step's card reads about it. */
export type TidyTrayInput = {
  queue: TidyLink[];
  /** Whether the owner has any current focus entry; without one the fit line is left out. */
  hasFocus: boolean;
  images: Map<string, ShownPicture>;
  catalog: Tag[];
  now: Date;
};

const ICON = (inner: string) =>
  `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const CLOCK = ICON(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`);
const TARGET = ICON(`<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>`);
const WARNING = ICON(`<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16v.5"/>`);

/** "Saved in March. You haven't opened it from here." Only the latest opening is stored. */
function savedFact(link: Link, now: Date): string {
  const opened =
    link.lastOpenedAt === null
      ? "You haven't opened it from here."
      : `Last opened in ${monthName(link.lastOpenedAt, now)}.`;
  return `Saved in ${monthName(link.savedAt, now)}. ${opened}`;
}

/** The fit line; an inferred focus is a guess, as on Home. Nothing when there is no current focus. */
function fitFact(fit: FocusEntry | null, hasFocus: boolean): string {
  if (!hasFocus) return "";
  if (fit === null) return "Doesn't fit anything you're working on now.";
  const name = `<b>${escapeHtml(fit.text)}</b>`;
  return fit.source === "inferred"
    ? `Might fit ${name}, which you may be working on (a guess).`
    : `Might fit ${name}, which you're working on.`;
}

/** The card's why: its label says so when an agent inferred it, and the text is the words alone. */
function whySection(why: Link["why"]): string {
  const label = why?.source === "inferred" ? "Why you saved it (a guess)" : "Why you saved it";
  return `<p class="tidy-why"><small>${label}</small>${why ? escapeHtml(why.text) : "No why yet"}</p>`;
}

type Choice = { act: string; title: string; line: string };

/** An explore step's choices, then a gone step's; a choice's key is its place in the list. */
const EXPLORE_CHOICES: Choice[] = [
  { act: "keep", title: "Keep", line: KEEP_TIDY_LINE },
  { act: "skip", title: "Skip", line: SKIP_TIDY_LINE },
  { act: "archive", title: "Archive", line: ARCHIVE_TIDY_LINE },
];
const GONE_CHOICES: Choice[] = [
  { act: "works", title: "It still works", line: STILL_WORKS_TIDY_LINE },
  { act: "archive", title: "Archive", line: ARCHIVE_TIDY_LINE },
];

const choices = (list: Choice[]) =>
  `<div class="tidy-choices">\n${list
    .map(
      (c, i) =>
        `<button type="button" data-act="${c.act}" aria-keyshortcuts="${i + 1}"><b>${c.title}</b><span>${c.line}</span><kbd class="key" aria-hidden="true">${i + 1}</kbd></button>`,
    )
    .join("\n")}\n</div>`;

/**
 * One step of the session: its bar ("N of M", one dot per link, Stop here) and the link's card.
 * Rendered hidden; the tray's script shows the current one. The step carries the link's `data-id`,
 * which the tray's `openedScript` and the choices read.
 */
export function tidyStep({ link, fit, gone }: TidyLink, at: number, input: TidyTrayInput): string {
  const { queue, hasFocus, images, catalog, now } = input;
  const dots = queue
    .map((_, i) => `<b${i < at ? ' class="done"' : i === at ? ' class="now"' : ""}></b>`)
    .join("");
  const fitLine = gone ? "" : fitFact(fit, hasFocus);
  const open = isWebUrl(link.url)
    ? `<p>${openLink(link, "Open it to check", "button tidy-open")}</p>\n`
    : "";
  const space = linkSpace(link, catalog);
  return `<div class="tidy-step" data-id="${escapeHtml(link.id)}" hidden>
<div class="tidy-bar"><span class="count">${at + 1} of ${queue.length}</span><span class="steps" aria-hidden="true">${dots}</span><button type="button" class="leave" data-tidy="stop">Stop here</button></div>
<article class="tidy${spaceClass(space)}">
<div class="tidy-top">
${tile(link, images.get(link.id), "tidy-pic")}
<div>
<h3 class="tidy-title" data-card-title>${linkTitle(link)}</h3>
${cardLine(link, { space })}</div>
</div>
${whySection(link.why)}
<ul class="tidy-facts">
<li>${CLOCK}<span class="soft">${savedFact(link, now)}</span></li>
${gone ? `<li>${WARNING}<span class="soft">${GONE_TEXT}.</span></li>\n` : ""}${fitLine ? `<li>${TARGET}<span class="fit">${fitLine}</span></li>\n` : ""}</ul>
${open}${choices(gone ? GONE_CHOICES : EXPLORE_CHOICES)}
</article>
</div>`;
}
