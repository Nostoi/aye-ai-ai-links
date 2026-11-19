/** What each Home tray's spine shows: a line icon and one short word (#306). */
const SPINES = {
  handy: {
    word: "Handy",
    icon: `<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/>`,
  },
  today: {
    word: "Today",
    icon: `<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>`,
  },
  tidy: {
    word: "Tidy",
    icon: `<path d="M19.5 4.5 13 11"/><path d="M11.2 9.8l3 3c.5.5.5 1.2 0 1.7l-.6.6c-1.9 1.9-4.6 2.7-7.2 2.2L4.5 17l-.3-1.9c-.5-2.6.3-5.3 2.2-7.2l.6-.6c.5-.5 1.2-.5 1.7 0z"/><path d="M7.5 17.6l1.6-2.6M10.5 17.2l1.2-2"/>`,
  },
  spaces: {
    word: "Spaces",
    icon: `<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>`,
  },
};

/**
 * The band down the left of a Home tray (a strip across its top on a phone): the section's icon and
 * a short word. Both are decorative: the section's own heading, which the theme hides visually,
 * names it for screen readers. The theme draws the focus ring on the band when that heading has
 * focus (`SHELF_SCRIPT` moves it there).
 */
export const spine = (kind: keyof typeof SPINES): string => {
  const { word, icon } = SPINES[kind];
  return `<div class="spine"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">${icon}</svg><span class="spine-word" aria-hidden="true">${word}</span></div>`;
};
