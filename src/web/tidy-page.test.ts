import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { TidyLink } from "../core/tidy-up.js";
import type { FocusEntry, Link, Source } from "../core/types.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { themeCss } from "./theme.js";
import { tidyPage } from "./tidy-page.js";

const NOW = new Date("2026-10-21T10:00:00Z");

let n = 0;
const link = (over: Partial<Link> = {}): Link => {
  n += 1;
  return {
    id: String(n),
    url: `https://example.com/${n}`,
    urlKey: `example.com/${n}`,
    title: `Title ${n}`,
    summary: null,
    why: { text: "to compare", source: "stated" },
    tags: [],
    savedAt: new Date("2026-03-12T10:00:00Z"),
    savedBy: "claude",
    lastOpenedAt: null,
    putAwayAt: null,
    tidyKeptAt: null,
    lastSurfacedAt: null,
    snoozedUntil: null,
    state: "active",
    snapshot: null,
    ...over,
  };
};
const focus = (text: string, source: Source): FocusEntry => ({
  id: "f",
  text,
  source,
  writtenBy: "agent",
  createdAt: NOW,
});
const queue = (count: number): TidyLink[] =>
  Array.from({ length: count }, () => ({ link: link(), fit: null }));

const render = (q: TidyLink[], hasFocus = true) =>
  tidyPage({ queue: q, hasFocus, images: new Map(), catalog: [], now: NOW });
const doc = (q: TidyLink[], hasFocus = true) => parseHTML(render(q, hasFocus)).document;
const first = (q: TidyLink[], hasFocus = true) =>
  doc(q, hasFocus).querySelector("section[data-id]") as Element;

describe("the Tidy up page", () => {
  it("shows the first of five links and hides the rest", () => {
    const q = queue(5);
    const sections = [...doc(q).querySelectorAll("section[data-id]")];
    expect(sections.map((s) => s.getAttribute("data-id"))).toEqual(q.map((t) => t.link.id));
    expect(sections.map((s) => s.hasAttribute("hidden"))).toEqual([false, true, true, true, true]);
  });

  it("marks each step 'Link N of M' for a screen reader, with one hidden dot per link", () => {
    const sections = [...doc(queue(5)).querySelectorAll("section[data-id]")];
    expect(render(queue(5))).toContain("Link 1 of 5");
    expect(sections[2]?.textContent).toContain("Link 3 of 5");
    const dots = sections[2]?.querySelector(".steps") as Element;
    expect(dots.getAttribute("aria-hidden")).toBe("true");
    expect(dots.querySelectorAll("b")).toHaveLength(5);
  });

  it("links Stop here to Home", () => {
    const stop = [...first(queue(2)).querySelectorAll("a")].find(
      (a) => a.textContent === "Stop here",
    );
    expect(stop?.getAttribute("href")).toBe("/");
  });

  it("shows the title, the why, and the picture box of the card", () => {
    const t = { link: link({ title: "Home batteries" }), fit: null };
    const section = first([t]);
    expect(section.textContent).toContain("Home batteries");
    expect(section.textContent).toContain("Why you saved it");
    expect(section.textContent).toContain('"to compare"');
    expect(section.querySelector("[data-pic]")).not.toBeNull();
  });

  it("marks an inferred why as a guess, and a stated one not", () => {
    const guessed = first([
      { link: link({ why: { text: "maybe", source: "inferred" } }), fit: null },
    ]);
    expect(guessed.textContent).toContain("Why (a guess): maybe");
    expect(first(queue(1)).textContent).not.toContain("(a guess)");
  });

  it("says when it was saved and that it was never opened", () => {
    expect(first(queue(1)).textContent).toContain(
      "Saved in March. You haven't opened it from here.",
    );
  });

  it("says the month of the latest opening, with the year only for another year", () => {
    const t = {
      link: link({
        savedAt: new Date("2024-03-12T10:00:00Z"),
        lastOpenedAt: new Date("2026-05-02T10:00:00Z"),
      }),
      fit: null,
    };
    expect(first([t]).textContent).toContain("Saved in March 2024. Last opened in May.");
  });

  it("opens the link in a new tab, as a recorded opening", () => {
    const a = [...first(queue(1)).querySelectorAll("a")].find(
      (x) => x.textContent === "Open it to check",
    ) as Element;
    expect(a.getAttribute("href")).toMatch(/^https:\/\/example\.com\//);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.hasAttribute("data-open")).toBe(true);
    expect(render(queue(1))).toContain('"/links/opened"');
  });

  it("offers the three choices in order, with their exact lines and the safe marker", () => {
    const buttons = [...first(queue(1)).querySelectorAll("button[data-act]")];
    expect(buttons.map((b) => b.getAttribute("data-act"))).toEqual(["keep", "put-away", "stale"]);
    expect(buttons.every((b) => b.getAttribute("type") === "button")).toBe(true);
    const [keep, away, stale] = buttons;
    expect(keep?.textContent).toContain("Keep");
    expect(keep?.textContent).toContain("Stays in your lists, as it is now.");
    expect(away?.textContent).toContain("Put it away");
    expect(away?.textContent).toContain(
      "Out of your lists. Comes back when you start something it fits.",
    );
    expect(away?.textContent).toContain("If you're not sure");
    expect(away?.className).toContain("safe");
    expect(stale?.textContent).toContain("It's stale");
    expect(stale?.textContent).toContain("Out of sight for good. Search still finds it.");
    expect(keep?.textContent).not.toContain("If you're not sure");
    expect(stale?.textContent).not.toContain("If you're not sure");
    expect(keep?.className).not.toContain("safe");
  });

  describe("the fit line", () => {
    const fits = (f: FocusEntry | null, hasFocus = true) =>
      first([{ link: link(), fit: f }], hasFocus).querySelector(".fit")?.textContent ?? null;

    it("says it might fit a stated or asked focus the owner is working on", () => {
      expect(fits(focus("Solar for the house", "stated"))).toBe(
        "Might fit Solar for the house, which you're working on.",
      );
      expect(fits(focus("Solar for the house", "asked"))).toBe(
        "Might fit Solar for the house, which you're working on.",
      );
    });

    it("marks an inferred focus as a guess", () => {
      expect(fits(focus("Solar for the house", "inferred"))).toBe(
        "Might fit Solar for the house, which you may be working on (a guess).",
      );
    });

    it("bolds the focus text and escapes it", () => {
      const html = first([{ link: link(), fit: focus("<i>x</i>", "stated") }]).innerHTML;
      expect(html).toContain("<b>&lt;i&gt;x&lt;/i&gt;</b>");
    });

    it("says it fits nothing when the owner has focus entries and none match", () => {
      expect(fits(null)).toBe("Doesn't fit anything you're working on now.");
    });

    it("shows no fit line, and no empty box, when there are no current entries", () => {
      expect(fits(null, false)).toBeNull();
    });

    it("still offers Put it away when there is no fit line", () => {
      expect(first(queue(1), false).querySelector("button[data-act=put-away]")).not.toBeNull();
    });
  });

  describe("the finish screen", () => {
    const done = (q: TidyLink[]) => doc(q).querySelector(".tidy-done") as Element;

    it("follows the last link, hidden, and says That's five. Done for now. for a full session", () => {
      const d = done(queue(5));
      expect(d.hasAttribute("hidden")).toBe(true);
      expect(d.querySelector("h2")?.textContent).toBe("That's five. Done for now.");
      expect(d.textContent).toContain(
        "Everything you put away is still saved and still searchable.",
      );
      const back = d.querySelector("a") as Element;
      expect(back.textContent).toBe("Back home");
      expect(back.getAttribute("href")).toBe("/");
    });

    it("says only Done for now. for a shorter session", () => {
      expect(done(queue(3)).querySelector("h2")?.textContent).toBe("Done for now.");
    });

    it("stands alone, shown, for an empty queue", () => {
      expect(doc([]).querySelectorAll("section[data-id]")).toHaveLength(0);
      expect(done([]).hasAttribute("hidden")).toBe(false);
      expect(done([]).querySelector("h2")?.textContent).toBe("Done for now.");
    });
  });

  it("leaves a link without a web address unlinked", () => {
    const t = { link: link({ url: "ftp://example.com/x" }), fit: null };
    expect(first([t]).querySelector("a[data-open]")).toBeNull();
  });

  it("uses no amber and makes no outside request", () => {
    const html = render(queue(5));
    for (const el of parseHTML(html).document.querySelectorAll("[class]")) {
      expect(el.className).not.toMatch(/amber|needs-you/);
    }
    expect(outsideRefs(html)).toEqual([]);
  });

  it("styles the Tidy up rules with theme tokens only, the controls at least 44px tall", () => {
    const rules = [...themeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
      sel: (sel ?? "").trim(),
      body: body ?? "",
    }));
    const tidy = rules.filter((r) => /\.tidy|\.steps|\.leave/.test(r.sel));
    expect(tidy.length).toBeGreaterThan(0);
    for (const r of tidy) {
      expect(r.body, r.sel).not.toMatch(/amber|#[0-9a-fA-F]{3,8}\b/);
    }
    expect(rules.find((r) => r.sel === ".tidy-choices button")?.body).toMatch(
      /min-height:\s*(?:[4-9]\d)px/,
    );
    expect(rules.find((r) => r.sel === ".leave")?.body).toMatch(/min-height:\s*44px/);
  });
});
