import { escapeHtml } from "./page.js";

/**
 * One row of a card's menu: its `data-act` for the page's script, its stroke icon and its words.
 * A `hidden` row is there for the script to show later.
 */
export type MenuItem = { act: string; icon: string; text: string; href?: string; hidden?: boolean };

/** A thin line between a menu's groups. */
export const DIVIDER = "divider" as const;

const DOTS = `<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>`;

/**
 * A card's ⋯ menu, for the Handy tiles and every card: a 44px button holding a 32px dot at the
 * card's top-right, opening a card of 44px rows. `label` names it for screen readers
 * ("More for <title>"). The page's own script handles each row by its `data-act`; a row with an
 * `href` is a plain link and needs no script. `DIVIDER` draws a line between groups.
 */
export function cardMenu(label: string, items: (MenuItem | typeof DIVIDER)[]): string {
  const rows = items
    .map((i) => {
      if (i === DIVIDER) return "<hr>";
      const attrs = `data-act="${escapeHtml(i.act)}"${i.hidden ? " hidden" : ""}`;
      return i.href === undefined
        ? `<button type="button" ${attrs}>${i.icon}${escapeHtml(i.text)}</button>`
        : `<a href="${escapeHtml(i.href)}" ${attrs}>${i.icon}${escapeHtml(i.text)}</a>`;
    })
    .join("");
  return `<details class="card-menu">
<summary><span class="card-menu-dot" aria-hidden="true">${DOTS}</span><span class="visually-hidden">${escapeHtml(label)}</span></summary>
<div class="card-menu-list">${rows}</div>
</details>`;
}
