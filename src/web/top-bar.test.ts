import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { page } from "./page.js";
import { askCss, themeCss } from "./theme.js";

/** The top bar on its band (#305): places, then actions, then the account. */

const ASK = { ai: "Fake", place: "Home", owner: "owner-a" };
const doc = (html: string) => parseHTML(html).document;

/** Every rule's selector inside any `@media` block, at any depth, by walking the braces. */
const mediaSelectors = (css: string) => {
  const found: string[] = [];
  for (const start of css.matchAll(/@media[^{]*\{/g)) {
    let depth = 1;
    let prelude = "";
    for (let i = (start.index ?? 0) + start[0].length; i < css.length && depth > 0; i++) {
      const c = css[i];
      if (c === "{") {
        depth++;
        const selector = prelude.trim();
        if (!selector.startsWith("@")) found.push(selector);
        prelude = "";
      } else if (c === "}") {
        depth--;
        prelude = "";
      } else prelude += c;
    }
  }
  return found;
};
const bar = (html: string) => doc(html).querySelector("nav.menu") as Element;
const hrefs = (els: Element[]) => els.map((a) => a.getAttribute("href"));

describe("the top bar's places and actions", () => {
  const html = page("t", "<main></main>", { menu: true, here: "all", ask: ASK });

  it("lists only Home, All links and Spaces and tags as places, none of them /save", () => {
    const places = [...bar(html).querySelectorAll(".places a")];
    expect(hrefs(places)).toEqual(["/", "/all", "/tags"]);
  });

  it("has Save as an action link to /save outside the places, before Ask AI", () => {
    const save = bar(html).querySelector('a[href="/save"]') as Element;
    expect(save.closest(".places")).toBeNull();
    expect(save.textContent?.trim()).toBe("Save");
    expect(save.classList.contains("menu-page")).toBe(false);
    expect(save.querySelector("svg")).not.toBeNull();
    expect(save.nextElementSibling?.id).toBe("ask-open");
  });

  it("keeps Save in the phone menu, after the three places", () => {
    const phone = [...doc(html).querySelectorAll("details .menu-phone-only")];
    expect(hrefs(phone)).toEqual(["/", "/all", "/tags", "/save"]);
  });

  it("keeps Home first and current on Home", () => {
    const home = page("t", "<main></main>", { menu: true, here: "home" });
    const first = bar(home).querySelector(".places a") as Element;
    expect(first.getAttribute("href")).toBe("/");
    expect(first.getAttribute("aria-current")).toBe("page");
  });

  it("shows the magnifier off Home and not on Home", () => {
    const off = page("t", "<main></main>", { menu: true, here: "all" });
    const home = page("t", "<main></main>", { menu: true, here: "home" });
    expect(bar(off).querySelector('a[href="/search"]')).not.toBeNull();
    expect(bar(home).querySelector('a[href="/search"]')).toBeNull();
  });

  it("shows Ask AI only when the AI is set up", () => {
    const without = page("t", "<main></main>", { menu: true, here: "all" });
    expect(bar(html).querySelector("#ask-open")).not.toBeNull();
    expect(bar(without).querySelector("#ask-open")).toBeNull();
  });
});

describe("the band", () => {
  it("wraps the logo and the menu only on pages that render the menu", () => {
    const menu = page("t", "<main></main>", { menu: true, here: "all" });
    const band = doc(menu).querySelector("header .bar-band") as Element;
    expect(band.querySelector("a.brand")).not.toBeNull();
    expect(band.querySelector("nav.menu")).not.toBeNull();
    for (const bare of [page("t", "<main></main>"), page("t", "<main></main>", { home: true })]) {
      expect(doc(bare).querySelector(".bar-band")).toBeNull();
    }
  });

  it("sizes its tiers by its own width, above the page's cards", () => {
    expect(rule(".bar-band").join(";")).toMatch(/container:bar\/inline-size/);
    expect(rule(".bar-band").join(";")).toMatch(/position:relative;z-index:var\(--layer-chrome\)/);
    const barParts =
      /\.(bar-band|bar-pill|pill-word|places|menu-page|menu-save|menu-search|menu-phone-only|label-wide|label-phone|icon-wide|icon-phone|brand)\b/;
    const inMedia = mediaSelectors(themeCss + askCss).filter((s) => barParts.test(s));
    expect(inMedia).toEqual([]);
  });

  it("finds a bar part anywhere inside an @media block", () => {
    const css =
      "@media (max-width:600px){.a{x:1}.b,.bar-pill{y:2}}@media (hover:none){@container (x){.c{z:3}}}";
    expect(mediaSelectors(css)).toEqual([".a", ".b,.bar-pill", ".c"]);
  });

  it("drops the name beside the logo when the band is narrower than 880px, keeping the logo's own name", () => {
    expect(themeCss).toMatch(
      /@container bar \(max-width:879px\)\{\.bar-band \.brand>span\{display:none\}/,
    );
    const band = doc(page("t", "<main></main>", { menu: true })).querySelector(".bar-band .brand");
    expect(band?.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("Aye-AI-AI Links");
  });

  it("keeps each pill's word in its own span, so the word can hide while the name stays", () => {
    const html = page("t", "<main></main>", { menu: true, here: "all", ask: ASK });
    for (const [selector, word] of [
      ['a[href="/save"]', "Save"],
      ["#ask-open", "Ask AI"],
    ] as const) {
      const pill = bar(html).querySelector(selector) as Element;
      expect(pill.querySelector(".pill-word")?.textContent).toBe(word);
      expect(pill.textContent?.trim()).toBe(word);
    }
  });

  it("shows the pills as icons only, only with Ask AI there, where their words would wrap the bar", () => {
    for (const range of [
      String.raw`\(min-width:641px\) and \(max-width:780px\)`,
      String.raw`\(max-width:335px\)`,
    ]) {
      const iconOnly = new RegExp(
        String.raw`@container bar ${range}\{\.bar-pill\{[^}]*width:44px[^}]*\}\.pill-word\{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect\(0 0 0 0\)\}`,
      );
      expect(askCss).toMatch(iconOnly);
      expect(themeCss).not.toMatch(iconOnly);
    }
  });
});

const rule = (selector: string) =>
  [...themeCss.matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] as string).split(",").some((s) => s.trim() === selector))
    .map((m) => m[2] as string);

/** `--name:value` pairs of the first `:root{}` after `from`. */
const rootTokens = (from: number) => {
  const start = themeCss.indexOf(":root{", from);
  const body = themeCss.slice(start + 6, themeCss.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):([^;]+);/g)].map((m) => [m[1], m[2]]));
};
const themes = {
  light: rootTokens(0),
  dark: rootTokens(themeCss.indexOf("prefers-color-scheme: dark")),
} as Record<string, Record<string, string>>;

const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const lum = (rgb: number[]) => {
  const [r, g, b] = rgb.map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** A token as red, green, blue; understands a hex and `color-mix(in srgb,var(--a) N%,var(--b))`. */
const resolve = (mode: string, name: string): number[] => {
  const value = themes[mode]?.[name] as string;
  const mix = /^color-mix\(in srgb,var\(--([\w-]+)\) (\d+)%,var\(--([\w-]+)\)\)$/.exec(value);
  if (!mix) return channels(value);
  const [from, to, share] = [
    resolve(mode, mix[1] as string),
    resolve(mode, mix[3] as string),
    Number(mix[2]) / 100,
  ];
  return from.map((c, i) => c * share + (to[i] as number) * (1 - share));
};

describe.each(["light", "dark"])("the %s theme's new tokens", (mode) => {
  it.each(["bg", "surface"])("keeps --detail at 4.5:1 or more on --%s", (ground) => {
    expect(ratio(resolve(mode, "detail"), resolve(mode, ground))).toBeGreaterThanOrEqual(4.5);
  });

  it("gives the band a --tray colour, and --detail a value, in this theme", () => {
    expect(themes[mode]?.tray).toBeDefined();
    expect(themes[mode]?.detail).toBeDefined();
  });

  it("defines the card ring once, from ink, for both themes", () => {
    expect(themes.light?.["card-ring"]).toBe(
      "0 0 0 1px color-mix(in srgb,var(--ink) 7%,transparent)",
    );
  });
});

describe("the spacing scale", () => {
  it("is one 8-based set of tokens", () => {
    const scale = Object.fromEntries(
      Object.entries(themes.light as Record<string, string>).filter(([k]) =>
        k.startsWith("space-"),
      ),
    );
    expect(scale).toEqual({
      "space-1": "4px",
      "space-2": "8px",
      "space-3": "12px",
      "space-4": "16px",
      "space-5": "24px",
      "space-6": "32px",
      "space-7": "48px",
      "space-8": "56px",
    });
  });
});

describe("the card outline", () => {
  const CARDS = [
    ".card",
    ".connections li",
    ".note",
    ".focus-panel",
    ".stat-card",
    ".stat-reading",
    ".result",
    ".worth-feature",
    ".worth-row",
    ".handy-tile",
    ".suggest",
    ".tag",
    ".home-space",
    ".link-rows",
    "[data-view=pictures] .link-row",
    ".copy-article",
    ".tidy",
  ];
  const NOT_CARDS = [
    ".account-list",
    ".card-menu-list",
    ".edit-link",
    ".site-icon",
    ".undo-bar",
    ".search-box",
    ".search-instead",
    ".view-switch",
    ".handy-tile.guess",
  ];
  const shadows = (selector: string) =>
    rule(selector).flatMap((body) => /(?:^|;)box-shadow:([^;]+)/.exec(body)?.[1] ?? []);

  it.each(CARDS)("%s keeps a shadow and adds the ring", (selector) => {
    const found = shadows(selector);
    expect(found.length, selector).toBeGreaterThan(0);
    expect(
      found.some((s) => s.includes("var(--card-ring)")),
      selector,
    ).toBe(true);
  });

  it("keeps a guessed note's soft shadow but no ring around its dashed border", () => {
    const found = shadows(".note.guess");
    expect(found).toHaveLength(1);
    expect(found[0]).not.toContain("var(--card-ring)");
  });

  it.each(NOT_CARDS)("%s has no ring", (selector) => {
    expect(
      shadows(selector).some((s) => s.includes("var(--card-ring)")),
      selector,
    ).toBe(false);
  });
});

describe("the grey detail text", () => {
  it.each([
    ".card-line",
    ".also-why",
    ".also-body .card-line",
    ".card-site",
    ".handy-caption .card-site",
    ".home-space-all",
  ])("%s is 13.5px in --detail", (selector) => {
    const body = rule(selector).join(";");
    expect(body, selector).toMatch(/font-size:13\.5px/);
    expect(body, selector).toMatch(/color:var\(--detail\)/);
  });
});
