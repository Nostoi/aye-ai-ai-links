import type { HomeSpace } from "../core/spaces.js";
import { escapeHtml } from "./page.js";
import { spaceClass } from "./pages.js";
import { spaceHref } from "./space-page.js";

const CELLS = 3;

/** Three cells: each stored image, newest first and the first one large, then tints. */
const mosaic = (s: HomeSpace) =>
  Array.from({ length: CELLS }, (_, i) => {
    const image = s.mosaic[i];
    return image
      ? `<img src="/images/${encodeURIComponent(image.linkId)}?v=${encodeURIComponent(image.version)}" alt="" loading="lazy">`
      : `<div class="tint-${i + 1}"></div>`;
  }).join("");

const tile = (s: HomeSpace) =>
  `<a class="home-space${spaceClass(s.color ? { color: s.color } : null)}" href="${escapeHtml(spaceHref(s.key))}">
<div class="mosaic" aria-hidden="true">${mosaic(s)}</div>
<div class="home-space-name"><span class="dot" aria-hidden="true"></span>${escapeHtml(s.name)}</div>
</a>`;

/**
 * "Your spaces" on the home page: each pinned tag as a tile in its color, with a mosaic of its
 * links' stored images, opening its space page. With nothing pinned, one quiet line says how.
 */
export const spacesSection = (
  spaces: HomeSpace[],
) => `<section class="spaces" aria-labelledby="spaces">
<h2 id="spaces">Your spaces</h2>
${
  spaces.length === 0
    ? '<p class="small">Pin a tag on the <a href="/tags">Tags page</a> and it shows here as a space.</p>'
    : `<div class="home-spaces">\n${spaces.map(tile).join("\n")}\n</div>`
}
</section>`;
