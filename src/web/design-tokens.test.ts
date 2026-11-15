import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askCss, themeCss } from "./theme.js";

/**
 * Shape, layer, colour, motion (#311) and type (#312) tokens. Each is defined once at `:root` and
 * never again, so every `var()` of it means its root value everywhere. Putting that value back in
 * place of each `var()` gives the stylesheet with the tokens' values written out.
 *
 * `__tokens_expanded__/` is that stylesheet as main had it at a39f302, before the type scale: the
 * pinned baseline. The branch's expansion must equal the baseline with `PICKED_EDITS` applied and
 * nothing else, so any other change of a value fails and the owner's pick is the only visible
 * change. A later change of a stylesheet value on purpose adds its edits to the list; do not
 * regenerate the fixtures to make the comparison pass.
 */
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

  it("themeCss with each token's value put back is the baseline with only the owner's pick applied", () => {
    const [after, count] = editFontSizes(baseline("theme.css"), PICKED_EDITS);
    expect(count).toEqual(PICKED_EDITS.map(() => 1));
    expect(expand(themeCss)).toBe(after);
  });

  it("askCss with each token's value put back is the baseline, unchanged", () => {
    expect(expand(askCss)).toBe(baseline("ask.css"));
  });
});

const PHONE = "@media (max-width:600px)";
type Edit = [at: string, selector: string, from: string, to: string];

/** The owner's pick on #312 (T1, T2, T3, T4, T5b, T6, T7): 29 declarations, each matched once. */
const PICKED_EDITS: Edit[] = [
  ...[
    ".menu",
    ".lead",
    "label",
    "button",
    ".stat-windows a",
    ".undo-bar",
    ".feature-why",
    "a.button",
    ".home-space-name",
    ".done-link,.back-link",
    ".show-older",
    ".search-instead",
    ".orders",
    ".tidy-facts",
  ].map((selector): Edit => ["", selector, "15.5px", "15px"]),
  ...["kbd", ".why-label", ".edit-hint", ".edit-tag-guess", ".tidy-choices em"].map(
    (selector): Edit => ["", selector, "13px", "13.5px"],
  ),
  [PHONE, ".edit-hint-phone", "13px", "13.5px"],
  ["", ".leave", "14.5px", "14px"],
  [PHONE, ".tidy-facts", "14.5px", "14px"],
  ["", ".note-text", "16.5px", "17px"],
  ["", ".tidy-choices b", "16.5px", "17px"],
  ["", ".tidy-why", "17.5px", "17px"],
  ["", ".result h2", "19px", "18px"],
  ["", ".save-link-title", "19px", "18px"],
  ["", ".home-fav-none", "11px", "12px"],
  ["", ".tidy-title", "24px", "22px"],
];

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

const baseline = (name: string) =>
  readFileSync(new URL(`./__tokens_expanded__/${name}`, import.meta.url), "utf8");

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

/** Changes `edits`, each named by at-rule chain, selector and old value; returns how often each matched. */
const editFontSizes = (css: string, edits: Edit[]): [string, number[]] => {
  const count = edits.map(() => 0);
  const out = walk(css, (at, selector, body) =>
    edits.reduce((acc, [eAt, eSelector, from, to], i) => {
      if (at !== eAt || selector !== eSelector || !acc.includes(`font-size:${from}`)) return acc;
      count[i] = (count[i] ?? 0) + 1;
      return acc.replace(`font-size:${from}`, `font-size:${to}`);
    }, body),
  );
  return [out, count];
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

  it("flags a stylesheet that defines the steps but leaves its sizes typed (main's)", () => {
    expect(untyped(baseline("theme.css")).length).toBeGreaterThan(40);
  });

  it("uses all eleven steps", () => {
    const used = new Set(fontSizes(themeCss).map(({ value }) => step.exec(value)?.[1]));
    for (let n = 1; n <= 11; n++) expect(used, `--text-${n}`).toContain(String(n));
  });

  it("leaves askCss's sizes typed", () => {
    expect(fontSizes(askCss).filter(({ value }) => step.test(value))).toEqual([]);
  });
});
