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

  it("lays the shelf out in the spaces grid, and on a phone as one sideways row showing part of the next tile", () => {
    expect(themeCss).toMatch(
      /\.home-spaces,\.handy-row\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(200px,1fr\)\)/,
    );
    const phone = /@media \(max-width:600px\)\{(.*)\}$/m.exec(themeCss)?.[1] ?? "";
    const rule = (sel: string) =>
      new RegExp(`${sel.replace(/[.>]/g, "\\$&")}\\{([^}]*)\\}`).exec(phone)?.[1] ?? "";
    expect(rule(".handy-row")).toContain("display:flex");
    expect(rule(".handy-row")).toContain("overflow-x:auto");
    expect(rule(".handy-row>.handy-tile")).toContain("flex:0 0 72%");
  });

  it("puts the tile menu in the bottom-right corner of every tile in a row", () => {
    expect(themeCss).toMatch(/\.handy-tile\{[^}]*display:flex;[^}]*flex-direction:column/);
    expect(themeCss).toMatch(/\.tile-menu\{[^}]*margin-top:auto;[^}]*align-self:flex-end/);
    expect(themeCss).toMatch(/\.tile-menu\{[^}]*text-align:right/);
  });

  it("holds a tile's absolutely placed text inside the tile, so the sideways row doesn't widen the page", () => {
    expect(themeCss).toMatch(/\.handy-tile\{[^}]*position:relative/);
  });
});
