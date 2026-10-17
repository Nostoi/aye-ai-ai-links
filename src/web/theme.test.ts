import { describe, expect, it } from "vitest";
import { SPACE_COLORS } from "../core/tag-space.js";
import { themeCss, tokens } from "./theme.js";

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

  it("lays the spaces out in a grid, and on a phone the shelf as one sideways row showing part of the next tile", () => {
    expect(themeCss).toMatch(
      /\.home-spaces\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(200px,1fr\)\)/,
    );
    const phone = /@media \(max-width:600px\)\{(.*)\}$/m.exec(themeCss)?.[1] ?? "";
    const rule = (sel: string) =>
      new RegExp(`${sel.replace(/[.>]/g, "\\$&")}\\{([^}]*)\\}`).exec(phone)?.[1] ?? "";
    expect(rule(".handy-row")).toContain("display:flex");
    expect(rule(".handy-row")).toContain("overflow-x:auto");
    expect(rule(".handy-row>.handy-tile")).toContain("flex:0 0 156px");
  });

  it("puts the tile menu in the top-right corner of every tile, on a translucent circle", () => {
    expect(themeCss).toMatch(/\.tile-menu\{[^}]*top:\d+px;right:\d+px/);
    expect(themeCss).toMatch(
      /\.tile-menu-dot\{[^}]*border-radius:50%;[^}]*background:color-mix\(in srgb,var\(--surface\) \d+%,transparent\)/,
    );
    expect(themeCss).toMatch(
      /\.handy-tile\.photo \.tile-menu-dot\{[^}]*background:rgb\(\d+ \d+ \d+ \/ \.\d+\)/,
    );
  });

  it("holds a tile's absolutely placed text inside the tile, so the sideways row doesn't widen the page", () => {
    expect(themeCss).toMatch(/\.handy-tile\{[^}]*position:relative/);
  });
});

describe("the Handy postcards", () => {
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\})${selector.replace(/[.[\]*>]/g, "\\$&")}\\{([^}]*)\\}`, "m").exec(
      themeCss,
    )?.[1] ?? "";
  const phone = /@media \(max-width:600px\)\{(.*)\}\s*$/m.exec(themeCss)?.[1] ?? "";

  it("makes square 176px cards in a wrapping grid, and 156px ones in a sideways row on a phone", () => {
    expect(rule(".handy-row")).toContain("grid-template-columns:repeat(auto-fill,176px)");
    expect(rule(".handy-tile")).toContain("aspect-ratio:1");
    expect(phone).toMatch(/\.handy-row\{[^}]*overflow-x:auto/);
    expect(phone).toMatch(/\.handy-row>\.handy-tile\{[^}]*flex:0 0 156px/);
  });

  it("stretches the title's link over the card, with the menu and panels above it", () => {
    expect(rule(".handy-tile h3 a::after")).toMatch(/position:absolute;[^}]*inset:0/);
    for (const sel of [".tile-menu", ".handy-tile .ask"]) {
      expect(rule(sel), sel).toMatch(/position:absolute/);
      expect(rule(sel), sel).toMatch(/z-index:[2-9]/);
    }
  });

  it("keeps every panel and menu button at least 44px tall, and the card clip-free for the open menu", () => {
    expect(rule(".handy-tile .small-actions button")).toContain("min-height:44px");
    expect(rule(".tile-menu summary")).toContain("min-height:44px");
    expect(rule(".handy-tile")).toContain("overflow:visible");
  });

  it("on a phone, opens the menu from the card's left edge, above the next card, inside a row that bleeds to the screen edge", () => {
    expect(phone).toMatch(/\.tile-menu-list\{right:auto;left:-106px/);
    expect(phone).toMatch(/\.handy-row\{[^}]*margin:16px -16px 0;padding:4px 16px/);
    expect(themeCss).toContain(".handy-tile:has(.tile-menu[open]){z-index:5}");
  });

  it("styles the menu as a card of full-width 44px rows, not a link", () => {
    expect(rule(".tile-menu-list")).toMatch(/border-radius:14px;[^}]*box-shadow:/);
    const item = rule(".tile-menu-list button");
    for (const part of ["min-height:44px", "width:100%", "background:none", "white-space:nowrap"]) {
      expect(item).toContain(part);
    }
    expect(item).not.toContain("underline");
  });

  it("puts dark text straight on a picture-less card, and a light fade with white text only on a photo", () => {
    expect(rule(".handy-caption")).not.toContain("gradient");
    expect(rule(".handy-caption")).toContain("color:var(--ink)");
    const photo = rule(".handy-tile.photo .handy-caption");
    expect(photo).toContain("color:#fff");
    expect(photo).toContain("text-shadow:");
    const alphas = [...photo.matchAll(/rgb\(0 0 0 \/ (\.\d+)\)/g)].map((m) => Number(m[1]));
    expect(alphas.length).toBeGreaterThan(1);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.62);
    const blurs = [...photo.matchAll(/text-shadow:[^;]*/g)].flatMap((m) =>
      [...m[0].matchAll(/(\d+)px rgb/g)].map((b) => Number(b[1])),
    );
    expect(Math.max(...blurs)).toBeGreaterThanOrEqual(8);
  });

  it("darkens the host line toward ink, so it reads on a space-tinted card", () => {
    expect(rule(".handy-caption .card-site")).toContain(
      "color:color-mix(in srgb,var(--soft) 70%,var(--ink))",
    );
  });

  it("keeps the initials in the card's top half, small enough never to meet a 3-line title", () => {
    const initials = rule(".handy-initials");
    expect(Number(/font-size:(\d+)px/.exec(initials)?.[1])).toBeLessThanOrEqual(36);
    expect(initials).toContain("inset:0 0 auto;height:50%");
    expect(initials).toContain("line-height:1;");
  });

  it("sets the title at 14.5px and the host at 13px on one line with an ellipsis", () => {
    expect(rule(".handy-tile h3")).toContain("font-size:14.5px");
    expect(rule(".handy-tile h3")).toContain("line-height:1.25");
    expect(rule(".handy-tile h3")).toContain("-webkit-line-clamp:3");
    const site = rule(".handy-caption .card-site");
    expect(site).toContain("font-size:13px");
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

  it("keeps a due panel's text and buttons clear of the menu circle, and a suggestion's unpadded", () => {
    expect(rule(".handy-tile.needs-you .ask")).toBe("padding-right:40px");
    const gap = /gap:0 (\d+)px/.exec(rule(".handy-tile.needs-you .small-actions"))?.[1];
    expect(Number(gap)).toBeLessThanOrEqual(10);
    expect(rule(".handy-tile .ask")).toContain("padding:3px 10px 0");
  });
});
