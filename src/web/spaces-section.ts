import type { HomeSpace } from "../core/spaces.js";
import { displayTitle } from "./display-title.js";
import { escapeHtml } from "./page.js";
import { spaceClass } from "./pages.js";
import { spaceHref } from "./space-page.js";

/** The titles of the space's recent links, one per line; the theme hides them on a phone. */
const recent = (s: HomeSpace) =>
  s.recent.length === 0
    ? ""
    : `\n<span class="home-space-recent">${s.recent.map((l) => `<span>${escapeHtml(displayTitle(l))}</span>`).join("")}</span>`;

const card = (s: HomeSpace) =>
  `<a class="home-space${spaceClass(s.color ? { color: s.color } : null)}" href="${escapeHtml(spaceHref(s.key))}">
<span class="home-space-name"><span class="dot" aria-hidden="true"></span>${escapeHtml(s.name)}</span>${recent(s)}
</a>`;

/**
 * "Your spaces" on the home page: each pinned tag as a card in its color, with its name and the
 * titles of its newest links, opening its space page. With nothing pinned, one quiet line says how.
 */
export const spacesSection = (
  spaces: HomeSpace[],
) => `<section class="spaces" aria-labelledby="spaces">
<h2 id="spaces">Your spaces</h2>
${
  spaces.length === 0
    ? '<p class="small">Pin a tag on the <a href="/tags">Tags page</a> and it shows here as a space.</p>'
    : `<div class="home-spaces">\n${spaces.map(card).join("\n")}\n</div>`
}
</section>`;
