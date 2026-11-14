import { describe, expect, it } from "vitest";
import { askCss, themeCss } from "./theme.js";

/**
 * Shape, layer, colour and motion tokens (#311). Each is defined once at `:root` and never again, so
 * every `var()` of it means its root value everywhere. Putting that value back in place of each
 * `var()` must give the stylesheet as it was when the tokens were added, apart from the intended
 * differences below; that equivalence is what "the tokens changed no value" means.
 *
 * `__tokens_expanded__/` is that record. A later change to a stylesheet value on purpose fails the
 * comparison: review the diff, then `npx vitest run src/web/design-tokens.test.ts -u`.
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
  "overlay-scrim": "rgb(20 20 24 / .38)",
  "overlay-chip": "rgb(20 20 24 / .62)",
  "motion-pop": ".12s",
  "motion-hover": ".15s",
  "motion-fade": ".18s",
  "motion-leave": ".25s",
  "motion-slide": ".28s",
  "motion-label-delay": ".06s",
  "ease-standard": "ease",
  "ease-out": "ease-out",
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
