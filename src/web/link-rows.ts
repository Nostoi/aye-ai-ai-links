import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import type { GoneView } from "../core/link-check.js";
import type { Space } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { LinkOrder } from "../core/search.js";
import type { HandyView } from "../core/tools.js";
import type { Link } from "../core/types.js";
import { cardLine } from "./card-line.js";
import { outOfListsMarker } from "./done-link.js";
import { editData, editMenu } from "./edit-link.js";
import { goneLine } from "./gone-line.js";
import { linkTitle } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { spaceClass, tile } from "./pages.js";
import { askWhy, whyAnswer } from "./tell-why.js";

/** How All links and space pages show their links: a quiet list, or the grid of pictures. */
export type View = "list" | "pictures";

/** The cookie the switch writes, per browser, and the server reads to draw the page in that view. */
export const VIEW_COOKIE = "aye_view";

/** The view a cookie asks for: Pictures only when it says exactly so, else the list. */
export const viewOf = (value: string | undefined): View =>
  value === "pictures" ? "pictures" : "list";

/**
 * The why as a row reads it: the owner's words in quotes, an AI's labelled as a guess. Home's
 * Worth a look cards read it the same way.
 */
export const whyText = (why: NonNullable<Link["why"]>) =>
  why.source === "inferred"
    ? `Why (a guess): ${escapeHtml(why.text)}`
    : `"${escapeHtml(why.text)}"`;

/**
 * One link as a row of the list, which the Pictures view draws as a card: `tile()`'s picture, the
 * title, the why when there is one, the grey line and the ⋯ menu. `space` colors the row;
 * `lineSpace` is the space its grey line names (a space page leaves its own out). With `ask`, a
 * link with no why asks Tell me why, with the slot `tellWhyScript` puts the answer in.
 */
export function linkRow(
  link: Link,
  {
    space,
    lineSpace,
    picture,
    info,
    copy,
    handy,
    gone,
    faded = false,
    ask = false,
  }: {
    space: Space | null;
    lineSpace: Space | null;
    picture?: ShownPicture | undefined;
    info?: PictureInfo | undefined;
    copy?: CopyInfo | undefined;
    handy?: HandyView | null | undefined;
    gone?: GoneView | null | undefined;
    faded?: boolean;
    ask?: boolean;
  },
): string {
  const why = link.why
    ? `<p class="row-why">${whyText(link.why)}</p>\n`
    : ask
      ? `${whyAnswer("p", "", "row-why")}\n${askWhy(link)}\n`
      : "";
  return `<li class="link-row${spaceClass(space)}${faded ? " faded" : ""}" data-id="${escapeHtml(link.id)}"${editData(link, picture, info)}>
${tile(link, picture, "row-pic")}
<div class="row-body">
<h3 data-card-title>${linkTitle(link)}</h3>
${why}${cardLine(link, { space: lineSpace, copy, marker: outOfListsMarker(link) })}${goneLine(link, gone)}</div>
${editMenu(link, { copy, handy })}
</li>`;
}

/** The time a row is grouped by: when it was opened in opened order, else when it was saved. */
const groupTime = (link: Link, order: LinkOrder) =>
  order === "opened" && link.lastOpenedAt ? link.lastOpenedAt : link.savedAt;

/** "YYYY-MM" in UTC: the key a later page's first month joins the last one shown by. */
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** "October"; the year is added when it is not the current one. Always read in UTC. */
export const monthName = (d: Date, now: Date) =>
  d.toLocaleDateString("en-US", {
    month: "long",
    ...(d.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });

/**
 * The links grouped into one section per UTC month, in the order given, each drawn by `row`.
 * Show older links joins a later page's first month to the last one shown by its `data-month`.
 */
export function monthSections(
  links: Link[],
  { order, now }: { order: LinkOrder; now: Date },
  row: (link: Link) => string,
): string {
  const groups: { key: string; at: Date; links: Link[] }[] = [];
  for (const link of links) {
    const at = groupTime(link, order);
    const key = monthKey(at);
    const last = groups.at(-1);
    if (last?.key === key) last.links.push(link);
    else groups.push({ key, at, links: [link] });
  }
  return groups
    .map(({ key, at, links }) => {
      const name = monthName(at, now);
      const heading = order === "opened" ? `Opened in ${name}` : name;
      return `<section class="month" data-month="${key}">
<h2>${heading}</h2>
<ul class="link-rows">
${links.map(row).join("\n")}
</ul>
</section>`;
    })
    .join("\n");
}

/** The List / Pictures switch; `viewScript` works it. */
export const viewSwitch = (view: View) =>
  `<div class="view-switch" role="group" aria-label="View">${(["list", "pictures"] as const)
    .map(
      (v) =>
        `<button type="button" data-choice="${v}" aria-pressed="${v === view}">${v === "list" ? "List" : "Pictures"}</button>`,
    )
    .join("")}</div>`;

/**
 * The switch's script, a block for the page's script: a press shows its view at once, through
 * `data-view` on the page's `<main>` (there with or without a list, so rows Show older links
 * appends follow it too), and remembers it in `VIEW_COOKIE` for a year, for this browser only.
 */
export const viewScript = `{
const viewRoot = document.querySelector("main[data-view]");
const choices = [...document.querySelectorAll(".view-switch button[data-choice]")];
for (const choice of choices) {
  choice.addEventListener("click", () => {
    const view = choice.dataset.choice;
    viewRoot.dataset.view = view;
    for (const c of choices) c.setAttribute("aria-pressed", String(c === choice));
    document.cookie = ${JSON.stringify(`${VIEW_COOKIE}=`)} + view + "; path=/; max-age=31536000; samesite=lax" + (location.protocol === "https:" ? "; secure" : "");
  });
}
}`;
