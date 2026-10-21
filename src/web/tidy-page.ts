import type { ShownPicture } from "../core/image-store.js";
import { linkSpace } from "../core/link-space.js";
import { TIDY_SESSION, type TidyLink } from "../core/tidy-up.js";
import type { FocusEntry, Link, Tag } from "../core/types.js";
import { isWebUrl } from "../core/url-key.js";
import { cardLine } from "./card-line.js";
import { monthName, whyText } from "./link-rows.js";
import { linkTitle, openedScript, openLink } from "./open-link.js";
import { escapeHtml, page } from "./page.js";
import { spaceClass, tile } from "./pages.js";

export type TidyPageInput = {
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

const CHOICES = `<div class="tidy-choices">
<button type="button" data-act="keep"><b>Keep</b><span>Stays in your lists, as it is now.</span></button>
<button type="button" class="safe" data-act="put-away"><b>Put it away</b><span>Out of your lists. Comes back when you start something it fits.</span><em>If you're not sure</em></button>
<button type="button" data-act="stale"><b>It's stale</b><span>Out of sight for good. Search still finds it.</span></button>
</div>`;

function step({ link, fit }: TidyLink, at: number, input: TidyPageInput): string {
  const { queue, hasFocus, images, catalog, now } = input;
  const dots = queue
    .map((_, i) => `<b${i < at ? ' class="done"' : i === at ? ' class="now"' : ""}></b>`)
    .join("");
  const fitLine = fitFact(fit, hasFocus);
  const open = isWebUrl(link.url)
    ? `<p>${openLink(link, "Open it to check", "tidy-open")}</p>\n`
    : "";
  const space = linkSpace(link, catalog);
  return `<section class="tidy-step" data-id="${escapeHtml(link.id)}"${at === 0 ? "" : " hidden"}>
<div class="tidy-head"><h1>Tidy up</h1><span class="steps" aria-hidden="true">${dots}</span><span class="visually-hidden">Link ${at + 1} of ${queue.length}</span><a class="leave" href="/">Stop here</a></div>
<article class="tidy${spaceClass(space)}">
<div class="tidy-top">
${tile(link, images.get(link.id), "tidy-pic")}
<div>
<h2 class="tidy-title" data-card-title>${linkTitle(link)}</h2>
${cardLine(link, { space })}</div>
</div>
<p class="tidy-why"><small>Why you saved it</small>${link.why ? whyText(link.why) : "No why yet"}</p>
<ul class="tidy-facts">
<li>${CLOCK}<span class="soft">${savedFact(link, now)}</span></li>
${fitLine ? `<li>${TARGET}<span class="fit">${fitLine}</span></li>\n` : ""}</ul>
${open}${CHOICES}
</article>
</section>`;
}

function finish(count: number): string {
  const heading = count === TIDY_SESSION ? `That's five. Done for now.` : "Done for now.";
  return `<section class="tidy-done"${count === 0 ? "" : " hidden"}>
<h2>${heading}</h2>
<p>Everything you put away is still saved and still searchable.</p>
<p><a class="button primary" href="/">Back home</a></p>
</section>`;
}

/**
 * The Tidy up page: a session of old links, one shown at a time. Every link is its own section,
 * all but the first hidden, and the finish screen follows the last (alone, for an empty queue).
 * The session's script (#198, Task 3.3) works the choices; opening a link here is recorded.
 */
export function tidyPage(input: TidyPageInput): string {
  const body = `<main id="tidy">
${input.queue.map((t, i) => step(t, i, input)).join("\n")}
${finish(input.queue.length)}
</main>
${openedScript("tidy", "/links/opened")}`;
  return page("Tidy up · Aye-AI-AI Links", body, { home: true });
}
