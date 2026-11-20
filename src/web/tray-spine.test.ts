import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { spine } from "./tray-spine.js";

const dom = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document;

describe("a tray's spine", () => {
  it.each([
    ["handy", "Handy"],
    ["explore", "Explore"],
    ["spaces", "Spaces"],
  ] as const)(
    "holds the %s icon and the word %s, both hidden from screen readers",
    (kind, word) => {
      const band = dom(spine(kind)).querySelector(".spine") as Element;
      const icon = band.querySelector("svg");
      const text = band.querySelector(".spine-word");
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.querySelector("path, rect, circle")).not.toBeNull();
      expect(text?.textContent).toBe(word);
      expect(text?.getAttribute("aria-hidden")).toBe("true");
      expect([...band.children]).toEqual([icon, text]);
      expect(band.querySelector("a, button, h1, h2, h3, [tabindex]")).toBeNull();
    },
  );

  it("draws a different icon for each section", () => {
    const icons = (["handy", "explore", "spaces"] as const).map(
      (k) => dom(spine(k)).querySelector("svg")?.innerHTML,
    );
    expect(new Set(icons).size).toBe(3);
  });
});
