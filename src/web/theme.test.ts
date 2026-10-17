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
      /\.tile-menu-dot\{[^}]*border-radius:50%;[^}]*background:rgb\(0 0 0 \/ \.\d+\)/,
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

  it("sets the title in white over a dark fade, whatever the theme", () => {
    expect(rule(".handy-caption")).toMatch(/linear-gradient\([^)]*rgb\(0 0 0/);
    expect(rule(".handy-caption")).toContain("color:#fff");
  });

  it("keeps the fade to the caption and the initials above it, small enough never to meet it", () => {
    expect(rule(".handy-caption")).toMatch(/padding:(\d+)px 12px/);
    expect(Number(/padding:(\d+)px/.exec(rule(".handy-caption"))?.[1])).toBeLessThanOrEqual(20);
    const initials = rule(".handy-initials");
    expect(Number(/font-size:(\d+)px/.exec(initials)?.[1])).toBeLessThanOrEqual(40);
    expect(Number(/inset:0 0 (\d+)px/.exec(initials)?.[1])).toBeGreaterThanOrEqual(84);
  });

  it("sets the title at 14.5px and the host at 13px on one line with an ellipsis", () => {
    expect(rule(".handy-tile h3")).toContain("font-size:14.5px");
    expect(rule(".handy-tile h3")).toContain("line-height:1.25");
    const site = rule(".handy-caption .card-site");
    expect(site).toContain("font-size:13px");
    expect(site).toContain("min-width:0");
    const host = rule(".handy-caption .host");
    for (const part of ["white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis"]) {
      expect(host).toContain(part);
    }
  });

  it("keeps a due panel's text and buttons clear of the menu circle, and a suggestion's unpadded", () => {
    expect(Number(/padding:\d+px (\d+)px/.exec(rule(".handy-tile.needs-you .ask"))?.[1])).toBe(52);
    expect(rule(".handy-tile .ask")).not.toMatch(/padding:\d+px 5\d/);
  });
});
