import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { SPACE_COLORS } from "../core/tag-space.js";
import { editDialog } from "./edit-link.js";
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
    expect(themeCss).toMatch(/\.card-menu\{[^}]*top:\d+px;right:\d+px/);
    expect(themeCss).toMatch(
      /\.card-menu-dot\{[^}]*border-radius:50%;[^}]*background:color-mix\(in srgb,var\(--surface\) \d+%,transparent\)/,
    );
    expect(themeCss).toMatch(
      /\.handy-tile\.photo \.card-menu-dot\{[^}]*background:rgb\(\d+ \d+ \d+ \/ \.\d+\)/,
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

  it("puts a photo on white, so a transparent logo sits on white, and leaves a picture-less tile its space color", () => {
    expect(rule("img.handy-image")).toBe("background:#fff");
    expect(rule(".handy-image")).not.toContain("background");
    expect(rule(".handy-tile.photo .handy-caption")).toContain("text-shadow:");
  });

  it("makes square 176px cards in a wrapping grid, and 156px ones in a sideways row on a phone", () => {
    expect(rule(".handy-row")).toContain("grid-template-columns:repeat(auto-fill,176px)");
    expect(rule(".handy-tile")).toContain("aspect-ratio:1");
    expect(phone).toMatch(/\.handy-row\{[^}]*overflow-x:auto/);
    expect(phone).toMatch(/\.handy-row>\.handy-tile\{[^}]*flex:0 0 156px/);
  });

  it("stretches the title's link over the card, with the menu and panels above it", () => {
    expect(rule(".handy-tile h3 a::after")).toMatch(/position:absolute;[^}]*inset:0/);
    for (const sel of [".card-menu", ".handy-tile .ask"]) {
      expect(rule(sel), sel).toMatch(/position:absolute/);
      expect(rule(sel), sel).toMatch(/z-index:[2-9]/);
    }
  });

  it("keeps every panel and menu button at least 44px tall, and the card clip-free for the open menu", () => {
    expect(rule(".handy-tile .small-actions button")).toContain("min-height:44px");
    expect(rule(".card-menu summary")).toContain("min-height:44px");
    expect(rule(".handy-tile")).toContain("overflow:visible");
  });

  it("on a phone, opens the menu from the card's left edge, above the next card, inside a row that bleeds to the screen edge", () => {
    expect(phone).toMatch(/\.handy-tile \.card-menu-list\{right:auto;left:-106px/);
    expect(phone).toMatch(/\.handy-row\{[^}]*margin:16px -16px 0;padding:4px 16px/);
    expect(themeCss).toContain(
      ".handy-tile:has(.card-menu[open]),.result:has(.card-menu[open]),.link-card:has(.card-menu[open]){z-index:5}",
    );
  });

  it("styles the menu as a card of full-width 44px rows, not a link", () => {
    expect(rule(".card-menu-list")).toMatch(/border-radius:14px;[^}]*box-shadow:/);
    // A menu row that links (Read saved copy) is an <a> and looks the same.
    const item = rule(".card-menu-list button,.card-menu-list a");
    for (const part of [
      "min-height:44px",
      "width:100%",
      "background:none",
      "white-space:nowrap",
      "text-decoration:none",
    ]) {
      expect(item).toContain(part);
    }
    expect(item).not.toContain("underline");
    expect(themeCss).toContain(".card-menu-list a:hover");
  });

  it("gives a link in a small-actions row the buttons' 44px height", () => {
    expect(rule(".small-actions button,.small-actions a")).toContain("min-height:44px");
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

  it("keeps the initials small enough never to meet a 3-line title, with a tight line height", () => {
    const initials = computed(
      el('<div class="handy-image initials-box"></div>', "div"),
      "--initials",
      "desktop",
    );
    expect(initials).toBe("34px");
    expect(Number.parseInt(initials ?? "", 10)).toBeLessThanOrEqual(36);
    expect(
      computed(el('<span class="pic-initials"></span>', "span"), "line-height", "desktop"),
    ).toBe("1");
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
    for (const card of [".result", ".link-card"]) {
      expect(rule(card), card).not.toContain("overflow:hidden");
      expect(rule(card), card).toContain("position:relative");
    }
    expect(rule(".result>.tile")).toBe("border-radius:18px 0 0 18px");
    expect(phone).toContain(".result>.tile{border-radius:18px 18px 0 0}");
    expect(rule(".card-image")).toContain("border-radius:18px 18px 0 0");
  });

  it("wraps a long unbroken title inside its card, clear of the menu button", () => {
    expect(rule(".result-body")).toContain("position:relative");
    expect(rule(".result-body")).toContain("overflow-wrap:anywhere");
    expect(rule(".result h2")).toContain("padding-right:28px");
    expect(rule(".card-body h3")).toContain("overflow-wrap:anywhere");
    // The rest of a card's text too, such as a space card's long "host, saved <date>" line.
    expect(rule(".card-body")).toContain("overflow-wrap:anywhere");
  });

  it("on a phone, opens only the shelf's menu leftwards; a card's menu opens from its own right edge", () => {
    expect(phone).toMatch(/\.handy-tile \.card-menu-list\{right:auto;left:-106px/);
    expect(phone).not.toMatch(/(^|\})\.card-menu-list\{/);
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
    ]) {
      expect(rule(sel), sel).toContain("min-height:44px");
    }
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
function computed(el: Element, prop: string, width: "desktop" | "phone"): string | undefined {
  let best: { spec: number; value: string } | undefined;
  for (const rule of parseCss(themeCss)) {
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

describe("icons and initials", () => {
  const mosaic = el(
    '<div class="mosaic"><div class="mosaic-icon"><img class="site-icon"></div></div>',
    "img",
  );
  const preview = el('<div class="edit-preview fit-contain"><img class="site-icon"></div>', "img");
  it.each([
    ["mosaic", mosaic],
    ["edit preview", preview],
  ])("★ shows the %s icon whole at its own size, beating the cover rule", (_, img) => {
    for (const w of ["desktop", "phone"] as const) {
      expect(computed(img, "object-fit", w)).toBe("contain");
      expect(computed(img, "width", w)).toBe("var(--icon,72px)");
      expect(computed(img, "height", w)).toBe("var(--icon,72px)");
    }
  });
  it.each(["card-image", "worth-image", "tile", "worth-tile"])(
    "★ centres a div.%s box with flex",
    (cls) => {
      expect(computed(el(`<div class="${cls} icon-box"></div>`, "div"), "display", "desktop")).toBe(
        "flex",
      );
      expect(
        computed(el(`<div class="${cls} initials-box"></div>`, "div"), "display", "desktop"),
      ).toBe("flex");
    },
  );
  it("★ keeps Handy's icon and initials boxes in the tile's top half", () => {
    for (const box of ["icon-box", "initials-box"]) {
      const d = el(
        `<article class="handy-tile"><div class="handy-image ${box}"></div></article>`,
        "div",
      );
      expect(computed(d, "height", "phone")).toBe("50%");
      expect(computed(d, "inset", "phone")).toBe("0 0 auto");
    }
  });
  it("sizes the icon per box, and 56px in a search tile on a phone", () => {
    const tile = el('<div class="tile icon-box"></div>', "div");
    expect(computed(tile, "--icon", "desktop")).toBe("72px");
    expect(computed(tile, "--icon", "phone")).toBe("56px");
    expect(
      computed(el('<div class="worth-image icon-box"></div>', "div"), "--icon", "desktop"),
    ).toBe("112px");
  });
  it("puts the icon on the plate token, light in both modes, and drops .handy-initials", () => {
    expect(tokens.light.plate).toBe("#FFFFFF");
    expect(tokens.dark.plate).toBe("#E9E6E0");
    expect(computed(mosaic, "background", "desktop")).toBe("var(--plate)");
    expect(themeCss).not.toContain("handy-initials");
  });
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
