import type { HomeSpace } from "../core/spaces.js";
import { displayTitle } from "./display-title.js";
import { linkTitle } from "./open-link.js";
import { escapeHtml } from "./page.js";
import { faviconSrc, spaceClass } from "./pages.js";
import { spaceHref } from "./space-page.js";

/** The id of the cards' grid, for `openedScript`. */
export const SPACES_ID = "home-spaces";

/**
 * A link's title as a space card shows it: with the name of a pinned space (`names`, the card's
 * own included) and its label break cut from the front, the longest name first and one cut only
 * ("Language Arts 8 — Grammar" is "Grammar"). The break is whitespace, a dash and whitespace, or a
 * colon and whitespace, so "Go-to-market" stays whole in a space called Go. A title with nothing
 * after the break is left as it is. Then a spaced dash shows as " — "; "Go-to-market" and
 * "2020–2021" keep theirs. Display only, like `displayTitle`.
 */
function trimmedTitle(title: string, names: string[]): string {
  const cut = (name: string): string | null => {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped === "") return null;
    const rest = title
      .replace(new RegExp(`^\\s*${escaped}(?:\\s+[—–-]\\s+|:\\s+)`, "iu"), "")
      .trim();
    return rest === "" || rest === title.trim() ? null : rest;
  };
  const longestFirst = [...names].sort((a, b) => b.trim().length - a.trim().length);
  let shown = title;
  for (const name of longestFirst) {
    const rest = cut(name);
    if (rest !== null) {
      shown = rest;
      break;
    }
  }
  return shown.replace(/\s+[—–-]\s+/gu, " — ");
}

/**
 * The site's icon before a title: the stored favicon, else a faint empty square so titles line
 * up. Decorative (empty alt, hidden square); the title link names the row, and a click on the icon
 * falls through to the card's space link like any click on the card.
 */
const favicon = (id: string, versions: Map<string, string>) => {
  const version = versions.get(id);
  return version === undefined
    ? '<span class="home-fav home-fav-none" aria-hidden="true"></span>'
    : `<img class="home-fav" src="${escapeHtml(faviconSrc(id, version))}" alt="" width="18" height="18" loading="lazy" decoding="async">`;
};

/** The titles of the space's recent links, one per line; the theme hides them on a phone. */
const recent = (s: HomeSpace, names: string[], versions: Map<string, string>) =>
  s.recent.length === 0
    ? ""
    : `\n<span class="home-space-recent">${s.recent
        .map(
          (l) =>
            `<span data-id="${escapeHtml(l.id)}">${favicon(l.id, versions)}${linkTitle(l, escapeHtml(trimmedTitle(displayTitle(l), names)))}</span>`,
        )
        .join("")}</span>`;

const card = (names: string[], versions: Map<string, string>) => (s: HomeSpace) => {
  const href = escapeHtml(spaceHref(s.key));
  return `<div class="home-space${spaceClass(s.color ? { color: s.color } : null)}">
<a class="home-space-name" href="${href}"><span class="dot" aria-hidden="true"></span>${escapeHtml(s.name)}</a>${recent(s, names, versions)}
<a class="home-space-all" href="${href}">${s.count === 0 ? "Open" : `See all ${s.count}`}<span class="visually-hidden"> ${escapeHtml(s.name)}</span> →</a>
</div>`;
};

/**
 * "Your spaces" on the home page: each pinned tag as a card in its color, with its name, the
 * titles of its newest links (each opening its link, after its site's favicon from `favicons`, by
 * link id) and "See all N" with its active link count,
 * or "Open" when it has none. The name and that last link open its space page, and so does the rest of the card. With nothing
 * pinned, one quiet line says how.
 */
export const spacesSection = (
  spaces: HomeSpace[],
  favicons: Map<string, string> = new Map(),
) => `<section class="spaces" aria-labelledby="spaces">
<h2 id="spaces">Your spaces</h2>
${
  spaces.length === 0
    ? '<p class="small">Pin a tag on the <a href="/tags">Tags page</a> and it shows here as a space.</p>'
    : `<div class="home-spaces" id="${SPACES_ID}">\n${spaces
        .map(
          card(
            spaces.map((s) => s.name),
            favicons,
          ),
        )
        .join("\n")}\n</div>`
}
</section>`;
