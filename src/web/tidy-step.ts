import type { ShownPicture } from "../core/image-store.js";
import { linkSpace } from "../core/link-space.js";
import type { TidyLink } from "../core/tidy-up.js";
import type { FocusEntry, Link, Tag } from "../core/types.js";
import { isWebUrl } from "../core/url-key.js";
import { cardLine } from "./card-line.js";
import { monthName } from "./link-rows.js";
import { linkTitle, openLink } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { spaceClass, tile } from "./pages.js";

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

const CHOICES = `<div class="tidy-choices">
<button type="button" data-act="keep" aria-keyshortcuts="1"><b>Keep</b><span>Stays where it is.</span><kbd class="key" aria-hidden="true">1</kbd></button>
<button type="button" class="safe" data-act="put-away" aria-keyshortcuts="2"><b>Put it away</b><span>Off Home, All links and your spaces. Comes back when you start something it fits.</span><em>If you're not sure</em><kbd class="key" aria-hidden="true">2</kbd></button>
<button type="button" data-act="stale" aria-keyshortcuts="3"><b>Done with it</b><span>Still findable in search.</span><kbd class="key" aria-hidden="true">3</kbd></button>
</div>`;

/**
 * One step of the session: its bar ("N of M", one dot per link, Stop here) and the link's card.
 * Rendered hidden; the tray's script shows the current one. The step carries the link's `data-id`,
 * which the tray's `openedScript` and the choices read.
 */
export function tidyStep({ link, fit }: TidyLink, at: number, input: TidyTrayInput): string {
  const { queue, hasFocus, images, catalog, now } = input;
  const dots = queue
    .map((_, i) => `<b${i < at ? ' class="done"' : i === at ? ' class="now"' : ""}></b>`)
    .join("");
  const fitLine = fitFact(fit, hasFocus);
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
${fitLine ? `<li>${TARGET}<span class="fit">${fitLine}</span></li>\n` : ""}</ul>
${open}${CHOICES}
</article>
</div>`;
}
