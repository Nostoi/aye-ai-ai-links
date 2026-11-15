import { describe, expect, it } from "vitest";
import { askCss, themeCss } from "./theme.js";

/** Token values put back in place of each var(); `__tokens_expanded__/` is reviewed and updated with -u. */
const TOKENS: Record<string, string> = {
  "radius-card": "18px",
  "radius-card-large": "20px",
  "radius-pill": "999px",
  "shadow-card": "0 2px 10px #0000000b",
  "shadow-raised": "0 4px 18px #0000000f",
  "shadow-menu": "0 12px 32px rgb(0 0 0 / .16),0 2px 6px rgb(0 0 0 / .06)",
  "layer-lift": "1",
  "layer-tile-actions": "2",
  "layer-card-menu": "3",
  "layer-open-card": "5",
  "layer-menu": "20",
  "layer-chrome": "30",
  "layer-undo": "31",
  white: "#fff",
  "overlay-chip": "rgb(20 20 24 / .62)",
  "motion-pop": ".12s",
  "motion-hover": ".15s",
  "motion-fade": ".18s",
  "motion-leave": ".25s",
  "motion-slide": ".28s",
  "motion-label-delay": ".06s",
  "ease-standard": "ease",
  "ease-out": "ease-out",
  "text-1": "12px",
  "text-2": "13.5px",
  "text-3": "14px",
  "text-4": "15px",
  "text-5": "16px",
  "text-6": "17px",
  "text-7": "18px",
  "text-8": "20px",
  "text-9": "22px",
  "text-10": "26px",
  "text-11": "30px",
};

/** Applied to the expansion before comparing: the one spelling the token change normalised. */
const INTENDED_DIFFERENCES: [after: string, before: string][] = [
  ["(prefers-reduced-motion:reduce){*{", "(prefers-reduced-motion: reduce){*{"],
];

const occurrences = (text: string, part: string) => text.split(part).length - 1;
const mask = (css: string) => css.replace(/\?v=[0-9a-f]+/g, "?v=VERSION");
const rootStart = themeCss.indexOf(":root{");
const rootBlock = themeCss.slice(rootStart, themeCss.indexOf("}", rootStart));

const expand = (css: string) => {
  let out = mask(css);
  for (const [name, value] of Object.entries(TOKENS)) {
    out = out.replace(`--${name}:${value};`, "").replaceAll(`var(--${name})`, value);
  }
  for (const [after, before] of INTENDED_DIFFERENCES) out = out.replace(after, before);
  return out;
};

describe("design tokens (#311)", () => {
  for (const [name, value] of Object.entries(TOKENS)) {
    it(`--${name} is defined once, as ${value}, and never redefined or given a fallback`, () => {
      const both = `${themeCss}\n${askCss}`;
      expect(occurrences(both, `--${name}:`)).toBe(1);
      expect(rootBlock).toContain(`--${name}:${value};`);
      expect(occurrences(both, `var(--${name},`)).toBe(0);
    });
  }

  it("themeCss with each token's value put back is the stylesheet as it was", async () => {
    await expect(expand(themeCss)).toMatchFileSnapshot("__tokens_expanded__/theme.css");
  });

  it("askCss with each token's value put back is the stylesheet as it was", async () => {
    await expect(expand(askCss)).toMatchFileSnapshot("__tokens_expanded__/ask.css");
  });
});

const PHONE = "@media (max-width:600px)";

/**
 * Typed on purpose (#312): Home's question, "Also today" and the card's detail line, so a change to
 * a step cannot move them; the saved copy's reading sizes; and the initials' figures.
 */
const TYPED: [at: string, selector: string, value: string][] = [
  ["", ".question", "30px"],
  ["", ".also-today", "15px"],
  ["", ".card-site", "13.5px"],
  ["", ".card-line", "13.5px"],
  ["", ".handy-caption .card-site", "13.5px"],
  ["", ".also-why,.also-body .card-line", "13.5px"],
  ["", ".profile-stats .stat-count", "34px"],
  ["", ".edit-initials", "34px"],
  ["", ".pic-initials", "var(--initials,34px)"],
  ["", ".copy-article", "18px"],
  [PHONE, ".copy-article", "17.5px"],
  ["", ".copy-article h2", "24px"],
  [PHONE, ".copy-article h2", "22px"],
  ["", ".copy-article h3", "19px"],
  ["", ".copy-article h4,.copy-article h5,.copy-article h6", "18px"],
  ["", ".copy-article pre", "14.5px"],
  ["", ".copy-article code", ".92em"],
  ["", ".copy-article table", "15.5px"],
];

/** Each `font-size` declaration with its at-rule chain and selector, in source order. */
const fontSizes = (css: string) => {
  const found: { at: string; selector: string; value: string }[] = [];
  walk(css, (at, selector, body) => {
    for (const m of body.matchAll(/font-size:([^;}]+)/g)) {
      found.push({ at, selector, value: (m[1] ?? "").trim() });
    }
    return body;
  });
  return found;
};

/** Visits every rule body with its enclosing at-rules (joined by a space) and selector. */
const walk = (css: string, visit: (at: string, selector: string, body: string) => string) => {
  const chain: string[] = [];
  return css.replace(
    /([^{}]+)\{([^{}]*)\}|([^{}]+)\{|\}/g,
    (all, selector?: string, body?: string, opener?: string) => {
      if (opener !== undefined) {
        chain.push(opener.trim());
        return all;
      }
      if (selector === undefined || body === undefined) {
        chain.pop();
        return all;
      }
      const after = visit(chain.join(" "), selector.trim(), body);
      return after === body ? all : `${selector}{${after}}`;
    },
  );
};

describe("type scale (#312)", () => {
  const step = /^var\(--text-(\d+)\)$/;
  const allowed = new Set(TYPED.map(([at, selector, value]) => `${at}|${selector}|${value}`));
  const untyped = (css: string) =>
    fontSizes(css)
      .filter(({ at, selector, value }) => !allowed.has(`${at}|${selector}|${value}`))
      .filter(({ value }) => !step.test(value));

  it("takes every themeCss font-size from a --text step, apart from the typed list", () => {
    expect(untyped(themeCss)).toEqual([]);
  });

  it("names only steps that are defined", () => {
    for (const { value } of fontSizes(themeCss)) {
      const n = step.exec(value)?.[1];
      if (n) expect(TOKENS, value).toHaveProperty(`text-${n}`);
    }
  });

  it("finds each typed declaration exactly once in the stylesheet", () => {
    const found = fontSizes(themeCss).map((f) => `${f.at}|${f.selector}|${f.value}`);
    for (const [at, selector, value] of TYPED) {
      expect(
        found.filter((f) => f === `${at}|${selector}|${value}`),
        selector,
      ).toHaveLength(1);
    }
  });

  it("flags a stylesheet that defines the steps but leaves its sizes typed", () => {
    const typedAgain = themeCss.replace(
      /font-size:var\(--text-(\d+)\)/g,
      (_, n: string) => `font-size:${TOKENS[`text-${n}`]}`,
    );
    expect(untyped(typedAgain).length).toBeGreaterThan(40);
  });

  const sizedShorthands = (css: string) =>
    [...css.matchAll(/(?<![-\w])font:([^;}]+)/g)]
      .map((m) => (m[1] ?? "").trim())
      .filter((v) => v !== "inherit");

  it("sets no size through a font shorthand: every one in themeCss is inherit", () => {
    expect(sizedShorthands(themeCss)).toEqual([]);
  });

  it("sees a numeric font shorthand", () => {
    expect(sizedShorthands(".x{font:600 19px/1.3 inherit}.y{font:inherit}")).toEqual([
      "600 19px/1.3 inherit",
    ]);
  });

  it("uses all eleven steps", () => {
    const used = new Set(fontSizes(themeCss).map(({ value }) => step.exec(value)?.[1]));
    for (let n = 1; n <= 11; n++) expect(used, `--text-${n}`).toContain(String(n));
  });

  it("leaves askCss's sizes typed", () => {
    expect(fontSizes(askCss).filter(({ value }) => step.test(value))).toEqual([]);
  });
});
