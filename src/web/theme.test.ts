import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { SPACE_COLORS } from "../core/tag-space.js";
import { editDialog } from "./edit-link.js";
import { tile } from "./pages.js";
import { askCss, themeCss, tokens } from "./theme.js";

const channel = (n: number) => {
  const c = n / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
};

describe.each(["light", "dark"] as const)("the %s theme", (mode) => {
  const t = tokens[mode];
  it.each([
    ["ink", "bg"],
    ["ink", "surface"],
    ["soft", "bg"],
    ["soft", "surface"],
    ["ink", "fill"],
    ["amber-ink", "amber-bg"],
  ] as const)("has 4.5:1 contrast for %s on %s", (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it.each([
    ["field", "bg"],
    ["field", "surface"],
  ] as const)("has 3:1 contrast for the %s outline on %s", (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });
});

it("outlines inputs with the field token", () => {
  expect(themeCss).toMatch(/input\{[^}]*border:1\.5px solid var\(--field\)/);
});

it("outlines every textarea with the field token", () => {
  expect(themeCss).toMatch(/(^|\n)textarea\{[^}]*border:1\.5px solid var\(--field\)/);
});

it("keeps the Save page's result buttons at least 44px tall", () => {
  expect(themeCss).toMatch(/(^|\n)\.save-result button\{[^}]*min-height:44px/);
});

it("sizes a desktop image tile like the plain tile, whatever the image's shape, and caps it on a phone", () => {
  const desktop = /^img\.tile\{([^}]*)\}/m.exec(themeCss)?.[1] ?? "";
  expect(desktop).toContain("width:168px");
  expect(desktop).toContain("contain:size");
  expect(desktop).toContain("object-fit:cover");
  const phone = /@media \(max-width:600px\)\{.*img\.tile\{([^}]*)\}/.exec(themeCss)?.[1] ?? "";
  expect(phone).toContain("contain:none");
  expect(phone).toContain("max-height:200px");
});

describe("the theme css", () => {
  const names = Object.keys(tokens.light) as (keyof typeof tokens.light)[];
  const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(
    themeCss,
  )?.[1];

  it("defines every token in light by default", () => {
    for (const name of names) {
      expect(themeCss, name).toContain(`--${name}:${tokens.light[name]}`);
    }
  });

  it("redefines every light token under the dark-mode media query", () => {
    expect(dark).toBeDefined();
    expect(Object.keys(tokens.dark).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(dark, name).toContain(`--${name}:${tokens.dark[name]}`);
    }
  });

  it("gives every space color a class and a light and dark token, and amber is no space color", () => {
    expect(SPACE_COLORS).not.toContain("amber");
    expect(SPACE_COLORS).toHaveLength(6);
    for (const color of SPACE_COLORS) {
      expect(themeCss, color).toContain(`.space-${color}{--space:var(--${color})}`);
      expect(Object.keys(tokens.light), color).toContain(color);
      expect(Object.keys(tokens.dark), color).toContain(color);
    }
    expect(themeCss.match(/\.space-[a-z]+\{/g)).toHaveLength(SPACE_COLORS.length);
  });

  it("respects reduced motion and uses the system rounded font", () => {
    expect(themeCss).toContain("prefers-reduced-motion");
    expect(themeCss).toContain('ui-rounded, "SF Pro Rounded", system-ui, sans-serif');
  });

  it("lays the spaces out in a grid, two across with names only on a phone, and the shelf in one column there", () => {
    expect(themeCss).toMatch(
      /\.home-spaces\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(200px,1fr\)\)/,
    );
    const phone = /@media \(max-width:600px\)\{(.*)\}$/m.exec(themeCss)?.[1] ?? "";
    const rule = (sel: string) =>
      new RegExp(`(?:^|\\})${sel.replace(/[.>]/g, "\\$&")}\\{([^}]*)\\}`).exec(phone)?.[1] ?? "";
    expect(rule(".home-spaces")).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(rule(".home-space-recent")).toBe("display:none");
    expect(rule(".handy-row")).toContain("grid-template-columns:1fr");
    expect(phone).not.toContain("overflow-x:auto");
  });

  it("puts the tile menu in the top-right corner of every tile, on a translucent circle", () => {
    expect(themeCss).toMatch(/\.card-menu\{[^}]*top:\d+px;right:\d+px/);
    expect(themeCss).toMatch(
      /\.card-menu-dot\{[^}]*border-radius:50%;[^}]*background:color-mix\(in srgb,var\(--surface\) \d+%,transparent\)/,
    );
  });

  it("holds a tile's placed text inside the tile, so the row doesn't widen the page", () => {
    expect(themeCss).toMatch(/\.handy-tile\{[^}]*position:relative/);
  });

  it("drops the space mosaic, its tints and the photo postcard (#195)", () => {
    for (const gone of [".mosaic", ".tint-", ".handy-tile.photo"]) {
      expect(themeCss, gone).not.toContain(gone);
    }
  });
});

describe("the Handy tiles", () => {
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\})${selector.replace(/[.[\]*>]/g, "\\$&")}\\{([^}]*)\\}`, "m").exec(
      themeCss,
    )?.[1] ?? "";
  const phone = /@media \(max-width:600px\)\{(.*)\}\s*$/m.exec(themeCss)?.[1] ?? "";
  const phoneRule = (selector: string) =>
    new RegExp(`(?:^|\\})${selector.replace(/[.[\]*>]/g, "\\$&")}\\{([^}]*)\\}`).exec(phone)?.[1] ??
    "";

  it("puts a photo on white, so a transparent logo sits on white, and a picture-less box on the picture shade", () => {
    expect(rule("img.handy-image")).toBe("background:#fff");
    expect(rule(".handy-image.initials-box")).toBe("background:var(--pic)");
  });

  it("makes compact cards: a fixed square picture beside the words, about three across, one column on a phone", () => {
    expect(rule(".handy-row")).toContain(
      "grid-template-columns:repeat(auto-fill,minmax(260px,1fr))",
    );
    expect(rule(".handy-tile")).not.toContain("aspect-ratio");
    expect(rule(".handy-tile")).toContain("grid-template-columns:52px minmax(0,1fr) 44px");
    expect(rule(".handy-image")).toContain("width:52px;height:52px");
    expect(phoneRule(".handy-row")).toContain("grid-template-columns:1fr");
    expect(phoneRule(".handy-tile")).toContain("grid-template-columns:44px minmax(0,1fr) 44px");
    expect(phoneRule(".handy-image")).toContain("width:44px;height:44px");
  });

  it("stretches the title's link over the card, with the menu and the ask above it", () => {
    expect(rule(".handy-tile h3 a::after")).toMatch(/position:absolute;[^}]*inset:0/);
    expect(rule(".card-menu")).toMatch(/position:absolute/);
    for (const sel of [".handy-tile .card-menu", ".handy-tile .ask"]) {
      expect(rule(sel), sel).toMatch(/position:relative/);
      expect(rule(sel), sel).toMatch(/z-index:[2-9]/);
    }
  });

  it("gives the ask its own line across the card, under the picture and words", () => {
    expect(rule(".handy-tile .ask")).toContain("grid-column:1/-1");
  });

  it("keeps every panel and menu button at least 44px tall, and the card clip-free for the open menu", () => {
    expect(rule(".handy-tile .small-actions button")).toContain("min-height:44px");
    expect(rule(".card-menu summary")).toContain("min-height:44px");
    expect(rule(".handy-tile")).toContain("overflow:visible");
  });

  it("opens the menu from the ⋯ at the card's right edge, above the next card", () => {
    expect(phone).not.toContain(".handy-tile .card-menu-list");
    expect(themeCss).toContain(
      ".handy-tile:has(.card-menu[open]),.result:has(.card-menu[open]),.link-row:has(.card-menu[open]){z-index:5}",
    );
  });

  it("styles the menu as a card of full-width 44px rows, not a link", () => {
    expect(rule(".card-menu-list")).toMatch(/border-radius:14px;[^}]*box-shadow:/);
    const item = rule(".card-menu-list button");
    for (const part of ["min-height:44px", "width:100%", "background:none", "white-space:nowrap"]) {
      expect(item).toContain(part);
    }
  });

  it("wraps a card's grey line, and draws a dot only before a part that shows", () => {
    expect(rule(".card-line")).toContain("flex-wrap:wrap");
    expect(rule(".card-line")).toContain("overflow-wrap:anywhere");
    // The dot is the earlier part's, drawn only when a shown part follows later, so a hidden Saved copy
    // takes its dot along and the link itself carries none.
    expect(themeCss).toContain(
      '.card-line>:not([hidden]):has(~ :not([hidden]))::after{content:"·"',
    );
    expect(themeCss).not.toMatch(/\.card-line[^{]*(::before)/);
  });

  it("gives the grey line's Saved copy a 44px tap area without growing the line", () => {
    const link = rule(".card-line .saved-copy");
    expect(link).toContain("min-height:44px");
    expect(link).toMatch(/margin:-1[0-9]px 0/);
  });

  // Saved copy's tap area reaches up into the title above it. A positioned title link paints, and
  // so takes taps, above a static one; a positioned Saved copy would take them back.
  const line = '<p class="card-line"><a class="saved-copy" href="/c">Saved copy</a></p>';
  const ask = (open: boolean) =>
    `<div class="ask"><p class="small">Why did you save this?</p><button class="tell-why" type="button">Tell me why</button><form class="why-form"${open ? "" : " hidden"}><input name="why"><button class="primary" type="submit">Save</button></form></div>`;
  const row = (view: string, above: string) =>
    `<main data-view="${view}"><li class="link-row"><div class="row-body"><h3 data-card-title><a href="/x">T</a></h3>${above}${line}</div></li></main>`;
  const title = '<h3 data-card-title><a href="/x">T</a></h3>';
  it.each([
    [
      "a search result's title",
      `<main><li class="result"><div class="result-body"><h2 data-card-title><a href="/x">T</a></h2>${line}</div></li></main>`,
      "h2 a",
    ],
    ["a list row's title", row("list", ""), "h3 a"],
    ["a Pictures card's title", row("pictures", ""), "h3 a"],
    ["a list row's Tell me why", row("list", ask(false)), ".tell-why"],
    ["a Pictures card's Tell me why", row("pictures", ask(false)), ".tell-why"],
    ["a list row's open why field", row("list", ask(true)), ".why-form input"],
    ["a Pictures card's open why field", row("pictures", ask(true)), ".why-form input"],
    ["a list row's why Save", row("list", ask(true)), ".why-form button"],
    ["a Pictures card's why Save", row("pictures", ask(true)), ".why-form button"],
    ["any card's Tell me why", `<div>${title}${ask(false)}${line}</div>`, ".tell-why"],
    ["any card's open why field", `<div>${title}${ask(true)}${line}</div>`, ".why-form input"],
    ["any card's why Save", `<div>${title}${ask(true)}${line}</div>`, ".why-form button"],
    [
      "Home's featured title",
      `<main><article class="worth-card worth-feature">${title}<div class="feature-why"><p>"x"</p></div>${line}</article></main>`,
      "h3 a",
    ],
    [
      "Home's featured Tell me why",
      `<main><article class="worth-card worth-feature">${title}<div class="feature-why">${ask(false)}</div>${line}</article></main>`,
      ".tell-why",
    ],
    [
      "Home's featured open why field",
      `<main><article class="worth-card worth-feature">${title}<div class="feature-why">${ask(true)}</div>${line}</article></main>`,
      ".why-form input",
    ],
    [
      "Home's featured why Save",
      `<main><article class="worth-card worth-feature">${title}<div class="feature-why">${ask(true)}</div>${line}</article></main>`,
      ".why-form button",
    ],
  ])("lets %s, not Saved copy, take a tap where they overlap", (_, html, pick) => {
    const target = el(html, pick);
    const copy = target.ownerDocument.querySelector(".saved-copy") as Element;
    const shared = (() => {
      let n = target.parentElement;
      while (n && !n.contains(copy)) n = n.parentElement;
      return n;
    })();
    const sideOf = (from: Element, width: "desktop" | "phone") => {
      const out: (string | undefined)[] = [];
      for (let n: Element | null = from; n && n !== shared; n = n.parentElement) {
        out.push(computed(n, "position", width));
      }
      return out;
    };
    for (const width of ["desktop", "phone"] as const) {
      const [own, ...around] = sideOf(target, width);
      expect(own, width).toBe("relative");
      expect(around.filter(Boolean), width).toEqual([]);
      expect(sideOf(copy, width).filter(Boolean), width).toEqual([]);
    }
  });

  it("★ leaves a Handy tile's title link unplaced, so its overlay makes the whole tile the link", () => {
    // [A title rule keyed on data-card-title, or shared with the Worth cards, placing it.]
    const html =
      '<article class="handy-tile"><div class="handy-caption"><h3 data-card-title><a href="/x">T</a></h3></div></article>';
    for (const width of ["desktop", "phone"] as const) {
      expect(computed(el(html, "h3 a"), "position", width), width).toBeUndefined();
    }
  });

  it("gives a Handy tile its own card surface, corners and shadow, shared with no other card", () => {
    const own = rule(".handy-tile");
    for (const part of ["background:var(--surface)", "border-radius:18px", "box-shadow:"]) {
      expect(own).toContain(part);
    }
    expect(themeCss).not.toMatch(/(^|\}|,)[^{}]*\.worth[^{}]*,\.handy-tile[ {,]/m);
    expect(themeCss).not.toMatch(/(^|\}|,)\.handy-tile[^{}]*,[^{}]*\.worth/m);
  });

  it("spaces every dot on the grey line alike: no part puts a gap before its own dot", () => {
    const line = el(
      '<p class="card-line"><span class="line-space"><span class="dot"></span>Kitchen</span><span>ex.com</span><a class="saved-copy">Saved copy</a></p>',
      ".card-line",
    );
    // A dot is its part's ::after, so a part that is a flex box with a gap adds that gap to the
    // dot's own 6px.
    for (const part of line.children) {
      for (const prop of ["gap", "column-gap"]) {
        expect(computed(part, prop, "desktop"), `${part.className} ${prop}`).toBeUndefined();
      }
    }
  });

  it("gives a link in a small-actions row the buttons' 44px height", () => {
    expect(rule(".small-actions button,.small-actions a")).toContain("min-height:44px");
  });

  it("puts the words in ink on the card itself, with no fade, and the host in the soft grey", () => {
    expect(rule(".handy-caption")).not.toContain("gradient");
    expect(rule(".handy-caption")).toContain("color:var(--ink)");
    expect(rule(".handy-caption .card-site")).toContain("color:var(--soft)");
  });

  it("keeps the initials to under half the picture's side, with a tight line height", () => {
    const initials = computed(
      el('<div class="handy-image initials-box"></div>', "div"),
      "--initials",
      "desktop",
    );
    expect(Number.parseInt(initials ?? "", 10)).toBeLessThanOrEqual(26);
    expect(
      computed(el('<span class="pic-initials"></span>', "span"), "line-height", "desktop"),
    ).toBe("1");
  });

  it("sets the title at 16px bold in at most two lines, and the host at 14px on one line with an ellipsis", () => {
    expect(rule(".handy-tile h3")).toContain("font-size:16px");
    expect(rule(".handy-tile h3")).toContain("font-weight:700");
    expect(rule(".handy-tile h3")).toContain("-webkit-line-clamp:2");
    const site = rule(".handy-caption .card-site");
    expect(site).toContain("font-size:14px");
    expect(site).toContain("min-width:0");
    const host = rule(".handy-caption .host");
    for (const part of ["white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis"]) {
      expect(host).toContain(part);
    }
  });

  it("puts Show all and Add beside the heading: a grid in which the swapped shelf's head takes row 1, column 2", () => {
    expect(rule(".handy")).toContain("display:grid;grid-template-columns:1fr auto");
    expect(rule("#handy-shelf")).toBe("display:contents");
    expect(rule(".handy-head")).toContain("grid-row:1;grid-column:2");
    expect(rule(".handy>h2")).toContain("grid-row:1;grid-column:1");
    expect(themeCss).toMatch(/(?:^|\})\.handy-row,\.handy-empty,#handy-error\{grid-column:1\/-1/m);
    expect(themeCss).not.toContain(".handy-foot");
  });

  it("makes Add a tinted 44px pill and Show all a quiet 44px text button", () => {
    const add = rule(".handy-add");
    for (const part of ["min-height:44px", "border-radius:999px", "text-decoration:none"]) {
      expect(add).toContain(part);
    }
    expect(add).toContain("background:color-mix(in srgb,var(--ink) 5%,transparent)");
    const showAll = rule(".handy-show-all");
    for (const part of ["min-height:44px", "color:var(--soft)", "background:none", "border:0"]) {
      expect(showAll).toContain(part);
    }
  });

  it("drops the postcard's squeeze rules for asks laid over a small square", () => {
    // The ask now has its own line, so it no longer dodges the menu or squeezes its buttons.
    expect(themeCss).not.toContain(".handy-tile.needs-you .ask");
    expect(phone).not.toContain(":has([data-act=still-works])");
  });
});

describe("the card menu on every card", () => {
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\})${selector.replace(/[.[\]*>]/g, "\\$&")}\\{([^}]*)\\}`, "m").exec(
      themeCss,
    )?.[1] ?? "";
  const phone = /@media \(max-width:600px\)\{(.*)\}\s*$/m.exec(themeCss)?.[1] ?? "";

  it("is one 44px button holding a 32px dot, 8px in from the card's top-right corner, and the shelf-only styles are gone", () => {
    expect(rule(".card-menu")).toBe("position:absolute;top:2px;right:2px;z-index:3");
    expect(rule(".card-menu-dot")).toContain("width:32px;height:32px");
    expect(rule(".card-menu summary")).toContain("min-height:44px;min-width:44px");
    expect(themeCss).not.toContain("tile-menu");
  });

  it("sets a search card's dot on a light ink tint, since it sits on the card and not on a picture", () => {
    expect(rule(".result .card-menu-dot")).toContain(
      "background:color-mix(in srgb,var(--ink) 7%,transparent)",
    );
    expect(rule(".result .card-menu-dot")).toContain("backdrop-filter:none");
  });

  it("leaves result and link cards unclipped, so the open menu shows, and rounds their pictures instead", () => {
    for (const card of [".result", ".link-row"]) {
      expect(rule(card), card).not.toContain("overflow:hidden");
      expect(rule(card), card).toContain("position:relative");
    }
    expect(rule(".result>.tile")).toBe("border-radius:18px 0 0 18px");
    expect(phone).toContain(".result>.tile{border-radius:18px 18px 0 0}");
    // The list's white card is one box per month; it never clips, so its first and last rows round.
    expect(rule(".link-rows")).not.toContain("overflow:hidden");
    const pic = el(
      '<main data-view="pictures"><ul class="link-rows"><li class="link-row"><img class="row-pic"></li></ul></main>',
      "img",
    );
    expect(computed(pic, "border-radius", "desktop")).toBe("18px 18px 0 0");
  });

  it("wraps a long unbroken title, host or why inside its row, clear of the menu button", () => {
    expect(rule(".result-body")).toContain("position:relative");
    expect(rule(".result-body")).toContain("overflow-wrap:anywhere");
    expect(rule(".result h2")).toContain("padding-right:28px");
    expect(rule(".row-body h3")).toContain("overflow-wrap:anywhere");
    // A flex item keeps its content's width unless told otherwise, so a 135-character host
    // would push the row wider than a 390px phone without min-width:0.
    expect(rule(".row-body")).toContain("overflow-wrap:anywhere");
    expect(rule(".row-body")).toContain("min-width:0");
    expect(rule(".link-row")).toContain("min-width:0");
    expect(rule(".card-line>*")).toContain("min-width:0");
    for (const w of ["desktop", "phone"] as const) {
      const row = el('<main data-view="list"><li class="link-row"></li></main>', "li");
      expect(computed(row, "padding", w), w).toMatch(/^1[24]px (52|60)px 1[24]px 1[26]px$/);
    }
  });

  it("on a phone, opens every card's menu from its own right edge", () => {
    expect(phone).not.toMatch(/\.card-menu-list\{/);
  });
});

describe("the edit dialog's look", () => {
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\})${selector.replace(/[.[\]*>]/g, "\\$&")}\\{([^}]*)\\}`, "m").exec(
      themeCss,
    )?.[1] ?? "";
  const phone = /@media \(max-width:600px\)\{(.*)\}\s*$/m.exec(themeCss)?.[1] ?? "";

  it("on a wide screen: 520px, 22px corners, the canvas's padding, shadow and backdrop", () => {
    for (const part of [
      "width:min(520px,calc(100% - 32px))",
      "padding:8px 24px 20px",
      "border-radius:22px",
      "box-shadow:0 24px 64px rgb(0 0 0 / .28)",
    ]) {
      expect(rule(".edit-link")).toContain(part);
    }
    expect(rule(".edit-link::backdrop")).toBe("background:rgb(20 20 24 / .38)");
    expect(rule(".edit-head h2")).toContain("font-size:20px;font-weight:700");
    expect(rule(".edit-close")).toContain("width:44px;height:44px");
    expect(rule(".edit-title")).toBe("height:46px;padding:0 14px;border-radius:12px");
    expect(rule(".edit-preview")).toContain("width:200px;height:140px;border-radius:14px");
    expect(rule(".edit-chip")).toContain(
      "font-size:12px;font-weight:600;color:#fff;background:rgb(20 20 24 / .62)",
    );
  });

  it("keeps every dialog control at least 44px tall", () => {
    for (const sel of [
      ".edit-use",
      ".edit-choose",
      ".edit-remove",
      ".edit-foot button",
      ".edit-delete",
      ".edit-tag",
      ".edit-tag-remove",
      ".edit-suggest-item",
    ]) {
      expect(rule(sel), sel).toContain("min-height:44px");
    }
    expect(rule(".edit-tag-remove")).toContain("min-width:44px");
    expect(rule(".edit-tag-input")).toContain("height:46px");
  });

  it("outlines the tag field with the field color like the title, and keeps the tag chips neutral", () => {
    expect(rule(".edit-tag-input")).toBe("height:46px;padding:0 14px;border-radius:12px");
    const tagRules = ["edit-tags", "edit-chips", "edit-tag", "edit-tag-guess", "edit-suggest"]
      .map((c) => rule(`.${c}`))
      .join(";");
    expect(tagRules).not.toMatch(/--space|amber|#[0-9a-f]{3,6}/i);
  });

  it("on a phone the sheet scrolls and the tag field is as tall as the title field", () => {
    expect(phone).toContain(".edit-link{overflow-y:auto;overscroll-behavior:contain}");
    expect(phone).toContain(".edit-tag-input{height:48px}");
  });

  it("on a phone: a sheet from 96px with a grabber, Cancel and Save at the top, no close button or paste hint", () => {
    expect(phone).toContain(
      ".edit-link{inset:96px 0 0;width:100%;max-width:100%;max-height:none;height:auto;margin:0;padding:0 16px 24px;border-radius:22px 22px 0 0}",
    );
    expect(phone).toContain(".edit-grabber{display:block;width:40px;height:5px;");
    expect(phone).toContain(".edit-head{display:grid;grid-template-columns:1fr auto 1fr;");
    expect(phone).toContain(".edit-head h2{font-size:17px;text-align:center}");
    expect(phone).toMatch(/\.edit-top\{display:inline-flex;[^}]*min-height:44px/);
    expect(phone).toContain(".edit-top-save{justify-self:end;font-weight:700}");
    expect(phone).toContain(".edit-close,.edit-hint,.edit-foot{display:none}");
    expect(phone).toContain(".edit-hint-phone{display:block;");
    expect(phone).toContain(".edit-title{height:48px}");
    expect(phone).toContain(".edit-preview{width:100%;height:196px}");
    expect(phone).toContain(".edit-choose{min-height:48px;width:100%}");
  });
});

type Rule = { media: string | null; selectors: string[]; decls: Map<string, string> };
function parseCss(css: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (src: string, media: string | null) => {
    let i = 0;
    for (;;) {
      const open = src.indexOf("{", i);
      if (open < 0) return;
      let depth = 1;
      let j = open + 1;
      for (; depth > 0; j++) depth += src[j] === "{" ? 1 : src[j] === "}" ? -1 : 0;
      const prelude = src.slice(i, open).trim();
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) walk(body, prelude.slice(6).trim());
      else if (!prelude.startsWith("@"))
        rules.push({
          media,
          selectors: prelude.split(",").map((s) => s.trim()),
          decls: new Map(
            body
              .split(";")
              .filter((d) => d.includes(":"))
              .map((d) => {
                const k = d.indexOf(":");
                return [d.slice(0, k).trim(), d.slice(k + 1).trim()] as [string, string];
              }),
          ),
        });
      i = j;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""), null);
  return rules;
}
const specificity = (sel: string) => {
  const s = sel.replace(/:(not|is|has)\(/g, "(");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  const types = (s.match(/(^|[\s>+~(])[a-z][\w-]*/g) ?? []).length;
  return ids * 10000 + cls * 100 + types;
};
const AT_REST = /::|:(hover|focus|focus-visible|active)\b/;
/** The winning value of `prop` on `el` at `width`, by specificity and then source order. */
function computed(
  el: Element,
  prop: string,
  width: "desktop" | "phone",
  css = themeCss,
): string | undefined {
  let best: { spec: number; value: string } | undefined;
  for (const rule of parseCss(css)) {
    if (rule.media !== null && !(width === "phone" && rule.media === "(max-width:600px)")) continue;
    const value = rule.decls.get(prop);
    if (value === undefined) continue;
    for (const sel of rule.selectors) {
      if (AT_REST.test(sel) || !el.matches(sel)) continue;
      const spec = specificity(sel);
      if (!best || spec >= best.spec) best = { spec, value };
    }
  }
  return best?.value;
}
const el = (html: string, pick: string) =>
  parseHTML(`<html><body>${html}</body></html>`).document.querySelector(pick) as Element;

describe("a picture-less card in a coloured space (#193)", () => {
  const initials = '<span class="pic-initials">AB</span>';
  // A page with the AI on carries both sheets.
  const css = `${themeCss}\n${askCss}`;
  /** A `var(--token)` value as the token's colour in `mode`; undefined for anything else. */
  const resolve = (value: string | undefined, mode: keyof typeof tokens) => {
    const name = /^var\(--([\w-]+)\)$/.exec(value ?? "")?.[1];
    return name === undefined ? undefined : (tokens[mode] as Record<string, string>)[name];
  };
  /** The box's background stands apart from both the page and a card, in both schemes. */
  const expectNeutralShade = (box: Element, width: "desktop" | "phone") => {
    const value = computed(box, "background", width, css);
    for (const mode of ["light", "dark"] as const) {
      const shade = resolve(value, mode);
      expect(shade, `${mode} ${width}: ${value}`).toBeDefined();
      expect(shade, `${mode} ${width}`).not.toBe(tokens[mode].bg);
      expect(shade, `${mode} ${width}`).not.toBe(tokens[mode].surface);
    }
    return value;
  };
  // Each card as its builder renders it with no picture, in a space: the box the initials sit in.
  const cards: [string, string][] = [
    [
      "a search result",
      `<li class="result space-clay"><div class="tile initials-box">${initials}</div></li>`,
    ],
    [
      "an All links or space row",
      `<li class="link-row space-clay"><div class="row-pic initials-box">${initials}</div></li>`,
    ],
    [
      "Home's featured card",
      `<article class="worth-card worth-feature space-clay"><div class="feature-pic initials-box">${initials}</div></article>`,
    ],
    [
      "an Also today row",
      `<article class="worth-row space-clay"><div class="also-pic initials-box">${initials}</div></article>`,
    ],
    [
      "a Handy tile",
      `<article class="handy-tile space-clay"><div class="handy-image initials-box">${initials}</div></article>`,
    ],
    [
      "an Ask AI card",
      `<article class="ask-card space-clay"><div class="ask-tile initials-box">${initials}</div></article>`,
    ],
    [
      "the edit dialog's preview",
      '<div class="edit-preview space-clay"><span class="edit-initials">AB</span></div>',
    ],
  ];
  const boxOf = (html: string) => el(html, ".initials-box, .edit-preview");

  it.each(cards)(
    "★ %s shows its initials on one neutral shade, apart from the page and the card, untinted",
    (_name, html) => {
      // [A box mixed with the space colour, or one the page's or card's own colour, so it vanishes in dark mode.]
      const text = el(html, ".pic-initials, .edit-initials");
      for (const width of ["desktop", "phone"] as const) {
        expectNeutralShade(boxOf(html), width);
        expect(computed(text, "color", width, css), width).not.toContain("--space");
      }
    },
  );

  it("★ uses the same shade for every card's box", () => {
    // [A second neutral, so picture-less cards show two backgrounds.]
    const shades = new Set(
      cards.map(([, html]) => computed(boxOf(html), "background", "desktop", css)),
    );
    expect(shades.size).toBe(1);
  });

  it("★ keeps the Handy tile itself on the plain card surface, untinted by its space", () => {
    // [A tile tinted with its space colour, or left on the picture shade the postcard used.]
    const card = el('<article class="handy-tile space-clay"></article>', "article");
    for (const width of ["desktop", "phone"] as const) {
      expect(computed(card, "background", width, css), width).toBe("var(--surface)");
    }
  });
});

describe("icons and initials", () => {
  const preview = el('<div class="edit-preview fit-contain"><img class="site-icon"></div>', "img");
  it.each([["edit preview", preview]])(
    "★ shows the %s icon whole at its own size, beating the cover rule",
    (_, img) => {
      for (const w of ["desktop", "phone"] as const) {
        expect(computed(img, "object-fit", w)).toBe("contain");
        expect(computed(img, "width", w)).toBe("var(--icon,72px)");
        expect(computed(img, "height", w)).toBe("var(--icon,72px)");
      }
    },
  );
  it.each(["row-pic", "feature-pic", "tile", "also-pic", "handy-image"])(
    "★ centres a div.%s box with flex on a wide screen",
    (cls) => {
      expect(computed(el(`<div class="${cls} icon-box"></div>`, "div"), "display", "desktop")).toBe(
        "flex",
      );
      expect(
        computed(el(`<div class="${cls} initials-box"></div>`, "div"), "display", "desktop"),
      ).toBe("flex");
    },
  );
  it("★ fits Handy's icon inside its small square", () => {
    // [An icon sized for the old postcard, overflowing a 52px or 44px picture.]
    const d = el('<div class="handy-image icon-box"></div>', "div");
    expect(Number.parseInt(computed(d, "--icon", "desktop") ?? "", 10)).toBeLessThanOrEqual(40);
    expect(Number.parseInt(computed(d, "--icon", "phone") ?? "", 10)).toBeLessThanOrEqual(34);
  });
  it("sizes the icon per box, and 56px in a search tile on a phone", () => {
    const tile = el('<div class="tile icon-box"></div>', "div");
    expect(computed(tile, "--icon", "desktop")).toBe("72px");
    expect(computed(tile, "--icon", "phone")).toBe("56px");
    expect(
      computed(el('<div class="feature-pic icon-box"></div>', "div"), "--icon", "desktop"),
    ).toBe("80px");
  });
  it("puts the icon on the plate token, light in both modes, and drops .handy-initials", () => {
    expect(tokens.light.plate).toBe("#FFFFFF");
    expect(tokens.dark.plate).toBe("#E9E6E0");
    expect(computed(preview, "background", "desktop")).toBe("var(--plate)");
    expect(themeCss).not.toContain("handy-initials");
  });
});

describe("Home's Worth a look cards (#195)", () => {
  const feature = (inner: string, pick: string) =>
    el(`<article class="worth-card worth-feature">${inner}</article>`, pick);
  const row = (inner: string, pick: string) =>
    el(`<div class="worth-rows"><article class="worth-row">${inner}</article></div>`, pick);
  const areas = (width: "desktop" | "phone") =>
    computed(feature("", "article"), "grid-template-areas", width) ?? "";

  it("puts the featured picture at 120px on a wide screen and 64px on a phone", () => {
    const pic = feature('<div class="feature-pic"></div>', ".feature-pic");
    expect(computed(pic, "width", "desktop")).toBe("120px");
    expect(computed(pic, "height", "desktop")).toBe("120px");
    expect(computed(pic, "width", "phone")).toBe("64px");
    expect(computed(pic, "height", "phone")).toBe("64px");
  });

  it("sets Open it beside the quiet pair on a wide screen; on a phone, full width with the ⋯ beside it and the pair below", () => {
    expect(areas("desktop")).toContain('"open quiet');
    expect(areas("desktop")).toMatch(/"reason reason reason menu"/);
    expect(areas("phone")).toContain('"open menu"');
    expect(areas("phone")).toContain('"quiet quiet"');
    const open = feature(
      '<div class="feature-open"><a class="button primary">Open it</a></div>',
      "a",
    );
    expect(computed(open, "width", "phone")).toBe("100%");
    expect(computed(open, "justify-content", "phone")).toBe("center");
  });

  it("keeps It's stale and Not now as quiet text buttons at least 44px tall", () => {
    const quiet = feature(
      '<div class="feature-quiet"><button data-act="archive">It\'s stale</button></div>',
      "button",
    );
    for (const width of ["desktop", "phone"] as const) {
      expect(computed(quiet, "background", width), width).toBe("none");
      expect(computed(quiet, "border", width), width).toBe("0");
      expect(
        Number.parseInt(computed(quiet, "min-height", width) ?? "", 10),
      ).toBeGreaterThanOrEqual(44);
    }
  });

  it.each([
    ["initials", undefined],
    ["a site icon", { version: "v1", fit: "contain" as const }],
    ["a cover picture", { version: "v1", fit: "cover" as const }],
  ])(
    "hides a row's picture of %s on a phone, leaving it in the page for the edit dialog",
    (_, picture) => {
      const link = {
        id: "1",
        url: "https://example.com/a",
        urlKey: "example.com/a",
        title: "Batteries",
        summary: null,
        why: null,
        tags: [],
        savedAt: new Date(0),
        savedBy: "t",
        lastOpenedAt: null,
        putAwayAt: null,
        tidyKeptAt: null,
        lastSurfacedAt: null,
        snoozedUntil: null,
        state: "active" as const,
        snapshot: null,
      };
      const pic = row(tile(link, picture, "also-pic"), "[data-pic]");
      expect(computed(pic, "display", "desktop")).not.toBe("none");
      expect(computed(pic, "display", "phone")).toBe("none");
    },
  );

  it("gives each card's ⋯ its own cell instead of the card's corner", () => {
    const fm = feature('<details class="card-menu"></details>', "details");
    const rm = row('<details class="card-menu"></details>', "details");
    for (const menu of [fm, rm]) expect(computed(menu, "position", "desktop")).toBe("relative");
    expect(computed(fm, "grid-area", "desktop")).toBe("menu");
  });

  it("shows the reason in its space's colour, mixed toward ink, and never amber", () => {
    const reason = feature('<p class="reason"></p>', ".reason");
    const color = computed(reason, "color", "desktop") ?? "";
    expect(color).toContain("var(--space,var(--soft))");
    expect(color).not.toContain("amber");
  });

  it.each([
    ["every card shown", false, [false, false], true],
    ["one row taken out", false, [true, false], true],
    ["every row taken out", false, [true, true], false],
    ["the featured card taken out", true, [false, false], false],
  ])(
    "shows the Also today heading only between a shown featured card and a shown row, with %s",
    (_, featureHidden, hidden, shows) => {
      const feature = `<article class="worth-card worth-feature"${featureHidden ? " hidden" : ""}></article>`;
      const rows = hidden
        .map((h) => `<article class="worth-row"${h ? " hidden" : ""}></article>`)
        .join("");
      for (const w of ["desktop", "phone"] as const) {
        const heading = el(
          `<div id="worth-cards">${feature}<h3 class="also-today">Also today</h3><div class="worth-rows">${rows}</div></div>`,
          "h3",
        );
        expect(computed(heading, "display", w) !== "none", w).toBe(shows);
      }
    },
  );
});

describe("the edit dialog's Delete", () => {
  it("the phone rule does not hide the dialog's Delete", () => {
    const dialog = parseHTML(`<html><body>${editDialog()}</body></html>`).document;
    const button = dialog.querySelector("[data-edit=delete]");
    expect(button).not.toBeNull();
    for (let at = button; at && at.tagName !== "BODY"; at = at.parentElement) {
      for (const width of ["desktop", "phone"] as const) {
        expect(computed(at, "display", width), `${at.className} on ${width}`).not.toBe("none");
      }
    }
  });
});

describe("the quiet list and the Pictures view (#194)", () => {
  /** A row's picture box (or `pick`) on a page in `view`, done (`faded`) or not. */
  const inView = (view: "list" | "pictures", pick = ".row-pic", faded = false) =>
    el(
      `<main data-view="${view}"><ul class="link-rows"><li class="link-row${faded ? " faded" : ""}"><div class="row-pic initials-box"></div><div class="row-body"><p class="row-why"></p></div></li></ul></main>`,
      pick,
    );

  it("draws the list's picture as a small fixed square, and the Pictures view's across the card", () => {
    expect(computed(inView("list"), "width", "desktop")).toBe("44px");
    expect(computed(inView("list"), "height", "desktop")).toBe("44px");
    expect(computed(inView("list"), "width", "phone")).toBe("40px");
    expect(computed(inView("list"), "height", "phone")).toBe("40px");
    for (const w of ["desktop", "phone"] as const) {
      expect(computed(inView("pictures"), "width", w), w).toBe("100%");
      expect(computed(inView("pictures"), "height", w), w).toBe("140px");
    }
  });

  it.each([
    ["none hidden", [false, false, false]],
    ["the first hidden", [true, false, false]],
    ["a middle one hidden", [false, true, false]],
    ["the last hidden", [false, false, true]],
  ])("draws a divider only between two shown rows of a month, with %s", (_, hidden) => {
    const rows = hidden.map((h) => `<li class="link-row"${h ? " hidden" : ""}></li>`).join("");
    for (const w of ["desktop", "phone"] as const) {
      const list = el(`<main data-view="list"><ul class="link-rows">${rows}</ul></main>`, "ul");
      const shown = [...list.children].filter((row) => !row.hasAttribute("hidden"));
      const borders = shown.map((row) => computed(row, "border-top", w) ?? "none");
      expect(borders, w).toEqual(
        shown.map((_, i) =>
          i === 0 ? expect.stringMatching(/^(none|0)$/) : "1px solid var(--line)",
        ),
      );
    }
  });

  it("sizes the icon and initials inside the picture box for each view", () => {
    for (const w of ["desktop", "phone"] as const) {
      expect(computed(inView("list"), "--icon", w), w).toBe("30px");
      expect(computed(inView("list"), "--initials", w), w).toBe("16px");
      expect(computed(inView("pictures"), "--icon", w), w).toBe("80px");
      expect(computed(inView("pictures"), "--initials", w), w).toBe("40px");
    }
  });

  it("fades a done link's picture in both views, and never its words", () => {
    for (const view of ["list", "pictures"] as const) {
      expect(computed(inView(view, ".row-pic", true), "opacity", "desktop"), view).toBe(".4");
      expect(computed(inView(view, ".row-why", true), "opacity", "desktop"), view).toBeUndefined();
      expect(computed(inView(view, ".row-pic", false), "opacity", "desktop"), view).toBeUndefined();
    }
  });

  it("keeps a why to one line on a desktop row, two on a phone, and whole on a picture card", () => {
    expect(computed(inView("list", ".row-why"), "white-space", "desktop")).toBe("nowrap");
    expect(computed(inView("list", ".row-why"), "text-overflow", "desktop")).toBe("ellipsis");
    expect(computed(inView("list", ".row-why"), "-webkit-line-clamp", "phone")).toBe("2");
    expect(computed(inView("pictures", ".row-why"), "white-space", "desktop")).toBe("normal");
  });

  it("lays the rows in one white card per month, and the Pictures view in a grid of cards", () => {
    expect(computed(inView("list", "ul"), "display", "desktop")).toBeUndefined();
    expect(computed(inView("list", "ul"), "background", "desktop")).toBe("var(--surface)");
    expect(computed(inView("pictures", "ul"), "display", "desktop")).toBe("grid");
    expect(computed(inView("pictures", "li"), "background", "desktop")).toBe("var(--surface)");
  });

  it("gives the switch's buttons 44px", () => {
    const b = el('<div class="view-switch"><button aria-pressed="true"></button></div>', "button");
    expect(computed(b, "min-height", "desktop")).toBe("44px");
  });
});

describe("the saved copy's reading look", () => {
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\})${selector.replace(/[.[\]*>+]/g, "\\$&")}\\{([^}]*)\\}`, "m").exec(
      themeCss,
    )?.[1] ?? "";
  const phone =
    /^@media \(max-width:600px\)\{(\.copy-article\{[^\n]*)\}$/m.exec(themeCss)?.[1] ?? "";

  it("sets the article on a white sheet in the reading type", () => {
    const sheet = rule(".copy-article");
    for (const part of [
      "margin-top:28px",
      "padding:44px 48px 48px",
      "background:var(--surface)",
      "border-radius:20px",
      "box-shadow:0 4px 18px #0000000f",
      "font-size:18px",
      "line-height:1.7",
    ]) {
      expect(sheet).toContain(part);
    }
    expect(themeCss).not.toContain(".copy-article>*{max-width:68ch}");
    expect(rule(".copy-article p,.copy-article li")).toBe("max-width:none");
  });

  it("runs a band across the sheet on the page color, and keeps its picture whole", () => {
    expect(rule(".copy-band")).toContain("background:var(--bg)");
    expect(rule(".copy-article>.copy-band")).toBe("margin-left:-48px;margin-right:-48px");
    const img = rule(".copy-band img");
    expect(img).toContain("max-height:60vh");
    expect(img).toContain("max-height:60svh");
    expect(img).toContain("display:block");
    expect(img).not.toContain("object-fit");
  });

  it("keeps a picture in a sentence in the sentence, and no taller than a band's", () => {
    const img = rule(".copy-article img");
    expect(img).toContain("display:inline");
    expect(img).toContain("max-width:100%");
    expect(img).toContain("max-height:60vh");
  });

  it("makes the picture caption and the link line 44px tall and grey", () => {
    const link = rule(".copy-pic-link a,.copy-link-line a");
    expect(link).toContain("min-height:44px");
    expect(link).toContain("color:var(--soft)");
    expect(rule(".copy-pic-note")).toContain("color:var(--soft)");
  });

  it("sets Open on the site in the soft colour at 15px, as the mockup does", () => {
    const open = rule(".copy-open");
    expect(open).toContain("color:var(--soft)");
    expect(open).toContain("font-size:15px");
  });

  it("fills code with the page color and rules a quote with a line", () => {
    expect(rule(".copy-article pre")).toContain("background:var(--bg)");
    expect(rule(".copy-article code")).toContain("background:var(--bg)");
    expect(rule(".copy-article pre code")).toContain("background:none");
    expect(rule(".copy-article blockquote")).toContain("border-left:3px solid var(--line)");
  });

  it("tightens the sheet and its bands on a phone, after the other phone lines", () => {
    for (const part of [
      ".copy-article{padding:24px 20px",
      ".copy-article>.copy-band{margin-left:-20px;margin-right:-20px}",
      ".copy-band-note{padding:18px 20px}",
    ]) {
      expect(phone).toContain(part);
    }
    expect(themeCss.indexOf(phone)).toBeGreaterThan(
      themeCss.indexOf(".tidy-title{font-size:20px}"),
    );
  });
});

describe("the end of the saved copy", () => {
  const block = themeCss.slice(themeCss.indexOf(".copy-end{"));
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)${selector.replace(/[.[\]*>]/g, "\\$&")}\\{([^}]*)\\}`).exec(block)?.[1] ??
    "";

  it("closes the stylesheet, as one block", () => {
    expect(themeCss.indexOf(".copy-end{")).toBeGreaterThan(
      themeCss.indexOf("prefers-reduced-motion"),
    );
    expect(block).toMatch(/\.copy-end \.back-link\{[^}]*\}$/);
  });

  it("makes each button a soft, filled pill at least 44px tall, with theme tokens only", () => {
    const buttons = rule(".copy-end-acts button");
    expect(buttons).toContain("min-height:44px");
    expect(buttons).toContain("background:var(--fill)");
    expect(buttons).toContain("border-radius:999px");
    expect(block).not.toMatch(/#[0-9a-f]{3,6}\b|amber/i);
    expect(rule(".copy-end-line")).toContain("min-height:44px");
  });

  it("lets the row wrap and flattens the Keep handy wrappers into it", () => {
    expect(rule(".copy-end-acts")).toContain("flex-wrap:wrap");
    expect(rule(".copy-end [data-handy],.copy-end .handy-on")).toBe("display:contents");
  });

  it("spaces both Back links' arrow from their words, in the soft colour (#228)", () => {
    const back = rule(".copy-nav .back-link,.copy-end .back-link");
    expect(back).toContain("gap:8px");
    expect(back).toContain("color:var(--soft)");
  });
});
