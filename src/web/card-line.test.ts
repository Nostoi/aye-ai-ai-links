import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Space } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { Link } from "../core/types.js";
import { cardLine } from "./card-line.js";
import { copyHref } from "./copy-page.js";

const COPY: CopyInfo = { madeAt: new Date("2026-10-01T00:00:00Z") };
const KITCHEN: Space = { key: "kitchen", name: "Kitchen", color: "clay" };
const link = (url = "https://ex.com/7"): Link => ({
  id: "7",
  url,
  urlKey: "ex.com/7",
  title: "Seven",
  summary: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-10-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});
/** The line's parts as the reader sees them, in order. */
const parts = (html: string) =>
  [...parseHTML(`<div>${html}</div>`).document.querySelectorAll(".card-line > *")].map(
    (e) => e.textContent,
  );

describe("cardLine", () => {
  const WEB = "https://ex.com/7";
  const NOT_WEB = "not a url";
  it.each([
    [true, WEB, true, ["Kitchen", "ex.com", "Saved copy"]],
    [true, WEB, false, ["Kitchen", "ex.com"]],
    [true, NOT_WEB, true, ["Kitchen", "Saved copy"]],
    [true, NOT_WEB, false, ["Kitchen"]],
    [false, WEB, true, ["ex.com", "Saved copy"]],
    [false, WEB, false, ["ex.com"]],
    [false, NOT_WEB, true, ["Saved copy"]],
  ] as const)(
    "space %s, url %s, copy %s: shows only the parts there",
    (inSpace, url, copy, want) => {
      const html = cardLine(link(url), {
        space: inSpace ? KITCHEN : null,
        copy: copy ? COPY : undefined,
      });
      expect(parts(html)).toEqual(want);
      // The dots between parts are the theme's, never text, so a hidden part takes its dot along.
      expect(html).not.toContain("·");
    },
  );

  it("draws nothing when no part is there", () => {
    expect(cardLine(link(NOT_WEB))).toBe("");
  });

  it("puts the space's color dot before its name", () => {
    const d = parseHTML(cardLine(link(), { space: KITCHEN })).document;
    expect(d.querySelector(".card-line > :first-child > .dot")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("links the saved copy in the same tab, marked for Remove saved copy", () => {
    const a = parseHTML(cardLine(link(), { copy: COPY })).document.querySelector(".card-line a");
    expect(a?.getAttribute("href")).toBe(copyHref("7"));
    expect(a?.getAttribute("data-act")).toBe("read-copy");
    expect(a?.getAttribute("class")).toBe("saved-copy");
    expect(a?.hasAttribute("target")).toBe(false);
    expect(a?.hasAttribute("data-open")).toBe(false);
  });

  it("adds when it was saved after the site, capitalized only when it comes first", () => {
    expect(parts(cardLine(link(), { saved: "October 1", copy: COPY }))).toEqual([
      "ex.com",
      "saved October 1",
      "Saved copy",
    ]);
    expect(parts(cardLine(link(NOT_WEB), { saved: "October 1" }))).toEqual(["Saved October 1"]);
  });

  it("keeps a hostile space name and host as text", () => {
    const html = cardLine(link("https://ex.com/7"), {
      space: { ...KITCHEN, name: "<b>K</b>" },
    });
    expect(html).not.toContain("<b>");
    expect(parts(html)).toEqual(["<b>K</b>", "ex.com"]);
  });
});
