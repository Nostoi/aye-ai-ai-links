import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { DigestLink, DigestReason } from "../core/digest.js";
import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import type { CopyInfo } from "../core/saved-copy.js";
import { SPACE_COLORS } from "../core/tag-space.js";
import type { LinkView } from "../core/tools.js";
import type { FocusEntry, Link, Source, Tag } from "../core/types.js";
import { copyHref } from "./copy-page.js";
import { ARCHIVE_HINT } from "./done-link.js";
import { handyShelf } from "./handy-shelf.js";
import { homePage, type WorthCards } from "./home-page.js";
import { KEEP_HINT } from "./intent.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { SKIP_HINT } from "./skip.js";
import { spacesSection } from "./spaces-section.js";
import { themeCss, WORTH_EMPTY } from "./theme.js";

const NOW = new Date("2026-10-14T10:00:00Z");

let n = 0;
const link = (over: Partial<Link> = {}): Link => {
  n += 1;
  return {
    id: String(n),
    url: `https://example.com/${n}`,
    urlKey: `example.com/${n}`,
    title: `Title ${n}`,
    summary: null,
    summarySource: null,
    why: { text: "to compare", source: "stated" },
    tags: [],
    savedAt: new Date("2026-03-12T10:00:00Z"),
    savedBy: "claude",
    lastOpenedAt: null,
    intent: "explore",
    intentSource: null,
    lastSurfacedAt: null,
    snoozedUntil: null,
    state: "active",
    snapshot: null,
    ...over,
  };
};

const focus = (text: string, source: Source, words = ["Chorequest"]): DigestReason => ({
  kind: "focus_words",
  focus: { id: "f", text, source, writtenBy: "agent", createdAt: NOW } satisfies FocusEntry,
  words,
});
const card = (reasons: DigestReason[], over: Partial<Link> = {}): DigestLink => ({
  link: link(over),
  reasons,
});
const _GONE: LinkView = {
  handy: null,
  gone: { since: new Date("2026-10-01T00:00:00Z"), checkedAt: NOW },
};
const COPY: CopyInfo = { madeAt: new Date("2026-03-12T10:00:00Z") };

type Extra = Partial<Omit<WorthCards, "links">>;
const worth = (links: DigestLink[], extra: Extra = {}): WorthCards => {
  const views = new Map<string, LinkView>(extra.views ?? []);
  return { links, images: new Map(), now: NOW, catalog: [], ...extra, views };
};
const render = (links: DigestLink[], extra: Extra = {}) =>
  homePage({ worth: worth(links, extra), shelf: "", spaces: "" });
const tag = (key: string, over: Partial<Tag> = {}): Tag => ({
  key,
  name: key,
  kind: "topic",
  kindSource: "stated",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
  ...over,
});
const on = (...keys: string[]): Pick<Link, "tags"> => ({
  tags: keys.map((key) => ({
    key,
    name: key,
    source: "stated",
    kind: "topic",
    kindSource: "stated",
  })),
});
const dom = (html: string) => parseHTML(html).document;
/** The featured card's grey line, part by part, as the reader sees it. */
const lineParts = (html: string) =>
  [...dom(html).querySelectorAll(".worth-feature .card-line > *")].map((p) => p.textContent);
/** The reason, which ends the grey line (before Saved copy when there is one). */
const reasonOf = (html: string) => {
  const parts = lineParts(html).filter((t) => t !== "Saved copy");
  return parts[parts.length - 1];
};
/** A card's menu rows, in order, each as its act, marked when hidden for the script to show. */
const menuRows = (el: Element | null) =>
  [...(el?.querySelectorAll("details.card-menu .card-menu-list button") ?? [])].map(
    (b) => `${(b as HTMLElement).dataset.act}${(b as HTMLElement).hidden ? " (hidden)" : ""}`,
  );
/** Buttons a card shows outside its ⋯ menu. */
const shownButtons = (el: Element | null) =>
  [...(el?.querySelectorAll("button") ?? [])]
    .filter((b) => !b.closest("details.card-menu") && !b.closest("form"))
    .map((b) => `${(b as HTMLElement).dataset.act} ${b.textContent}`);

describe("Explore", () => {
  it("is left out when there is nothing to show", () => {
    const html = render([]);
    expect(dom(html).querySelector("section.worth")).toBeNull();
    expect(html).toContain("What are you trying to remember?");
    expect(dom(html).querySelector("#edit-link")).toBeNull();
  });

  it("asks the page's question as its one heading, labelling the search field", () => {
    const d = dom(render([]));
    expect(d.querySelectorAll("h1")).toHaveLength(1);
    const label = d.querySelector("h1 label[for=q]");
    expect(label?.textContent).toBe("What are you trying to remember?");
    expect(d.querySelector("#q")).not.toBeNull();
  });

  it("shows the first pick as the featured card and the others as More to explore rows, in order", () => {
    const cards = [card([]), card([]), card([])];
    const d = dom(render(cards));
    expect(d.querySelectorAll(".worth-feature")).toHaveLength(1);
    expect(d.querySelectorAll(".worth-row")).toHaveLength(2);
    expect(d.querySelector("h3.also-today")?.textContent).toBe("More to explore");
    expect([...d.querySelectorAll("[data-id]")].map((e) => (e as HTMLElement).dataset.id)).toEqual(
      cards.map((c) => c.link.id),
    );
    expect((d.querySelector(".worth-feature") as HTMLElement).dataset.id).toBe(cards[0]?.link.id);
  });

  it("leaves out More to explore when there is only the featured card", () => {
    const d = dom(render([card([])]));
    expect(d.querySelector(".also-today")).toBeNull();
    expect(d.querySelector(".worth-rows")).toBeNull();
  });

  it("gives the featured card Open it, Keep, Skip and Archive, and a row only its ⋯", () => {
    const d = dom(render([card([]), card([])]));
    const feature = d.querySelector(".worth-feature") as HTMLElement;
    const open = feature.querySelector("a.button.primary[data-open]") as HTMLAnchorElement;
    expect(open.textContent).toBe("Open it");
    expect(open.getAttribute("href")).toBe(feature.querySelector("h3 a")?.getAttribute("href"));
    expect(shownButtons(feature)).toEqual([
      `intent-keep Keep${KEEP_HINT}`,
      `snooze Skip${SKIP_HINT}`,
      `archive Archive${ARCHIVE_HINT}`,
    ]);
    const row = d.querySelector(".worth-row");
    expect(shownButtons(row)).toEqual([]);
    expect(row?.querySelector("a.button")).toBeNull();
  });

  it("orders the featured buttons Open it, Keep, Skip, Archive; the last three are icon buttons with label and hint (#298, #340)", () => {
    const feature = dom(render([card([])])).querySelector(".worth-feature") as HTMLElement;
    const controls = [...feature.querySelectorAll("a.button, button.slide")].filter(
      (e) => !e.closest("details.card-menu"),
    );
    expect(controls.map((e) => (e as HTMLElement).dataset.act ?? "open")).toEqual([
      "open",
      "intent-keep",
      "snooze",
      "archive",
    ]);
    const quiet = feature.querySelector(".feature-buttons > .feature-quiet") as Element;
    expect(quiet.className).toBe("feature-quiet");
    expect([...quiet.children].map((e) => e.className)).toEqual(["slide", "slide", "slide"]);
    const slide = (act: string) => feature.querySelector(`button.slide[data-act=${act}]`);
    const hint = (act: string) => slide(act)?.querySelector(".slide-words small")?.textContent;
    const label = (act: string) => slide(act)?.querySelector(".slide-words > span")?.textContent;
    expect(slide("snooze")?.getAttribute("type")).toBe("button");
    expect(hint("intent-keep")).toBe("Not asked again");
    expect(hint("snooze")).toBe("Back in two weeks");
    expect(hint("archive")).toBe("Out of lists, still in search");
    expect([label("intent-keep"), label("snooze"), label("archive")]).toEqual([
      "Keep",
      "Skip",
      "Archive",
    ]);
    // Label and hint stay text in the button, so its accessible name carries both.
    expect(slide("archive")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      `Archive${ARCHIVE_HINT}`,
    );
    // A check in a circle leads Keep, double chevrons Skip and an archive box Archive.
    expect(slide("intent-keep")?.firstElementChild?.querySelector("circle")).not.toBeNull();
    expect(slide("intent-keep")?.firstElementChild?.querySelectorAll("path")).toHaveLength(1);
    expect(slide("snooze")?.firstElementChild?.querySelectorAll("path")).toHaveLength(2);
    expect(slide("archive")?.firstElementChild?.querySelector("rect")).not.toBeNull();
    expect(slide("snooze")?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("gives a row the seven-row menu, Skip first, and the featured card the menu without its visible buttons and the intent rows", () => {
    const [first, second] = [card([]), card([])];
    const copies = new Map([
      [first?.link.id as string, COPY],
      [second?.link.id as string, COPY],
    ]);
    const d = dom(render([first as DigestLink, second as DigestLink], { copies }));
    expect(menuRows(d.querySelector(".worth-row"))).toEqual([
      "snooze",
      "intent-keep",
      "intent-explore (hidden)",
      "archive",
      "keep",
      "not-handy (hidden)",
      "edit",
      "remove-copy",
      "delete-link",
    ]);
    expect(menuRows(d.querySelector(".worth-feature"))).toEqual([
      "keep",
      "not-handy (hidden)",
      "edit",
      "remove-copy",
      "delete-link",
    ]);
    const noCopy = dom(render([card([]), card([])]));
    expect(menuRows(noCopy.querySelector(".worth-row"))).not.toContain("remove-copy");
  });

  it("marks every card explore-only, so a link made To keep leaves Explore", () => {
    const d = dom(render([card([]), card([])]));
    expect(d.querySelectorAll("#worth-cards [data-id][data-explore-only]")).toHaveLength(2);
  });

  it("shows Not handy anymore for a pick that is kept by now, and Keep handy for one declined", () => {
    const [kept, declined] = [card([]), card([])];
    const view = (status: "kept" | "declined"): LinkView => ({
      handy: { status, source: "stated", due: false },
      gone: null,
    });
    const views = new Map([
      [kept?.link.id as string, view("kept")],
      [declined?.link.id as string, view("declined")],
    ]);
    const d = dom(render([kept as DigestLink, declined as DigestLink], { views }));
    expect(menuRows(d.querySelector(".worth-feature"))).toContain("keep (hidden)");
    expect(menuRows(d.querySelector(".worth-feature"))).toContain("not-handy");
    expect(menuRows(d.querySelector(".worth-row"))).toContain("keep");
    expect(menuRows(d.querySelector(".worth-row"))).toContain("not-handy (hidden)");
  });

  it("has one filled button outside the search: Open it, and none for a link it can't open", () => {
    const filled = (html: string) =>
      [...dom(html).querySelectorAll(".primary")].filter(
        (b) => !b.closest("form.home-search") && !b.closest("dialog") && !b.closest("[hidden]"),
      );
    const shown = filled(render([card([], { why: null }), card([]), card([])]));
    expect(shown.map((b) => b.textContent)).toEqual(["Open it"]);
    expect(filled(render([card([], { url: "javascript:alert(1)" }), card([])]))).toEqual([]);
  });

  it("links the featured card's saved copy on its grey line, and never a row's", () => {
    const [first, second] = [card([]), card([])];
    const copies = new Map([
      [first?.link.id as string, COPY],
      [second?.link.id as string, COPY],
    ]);
    const d = dom(render([first as DigestLink, second as DigestLink], { copies }));
    const saved = d.querySelector(".worth-feature .card-line a.saved-copy");
    expect(saved?.getAttribute("href")).toBe(copyHref(first?.link.id as string, "/"));
    expect(saved?.getAttribute("data-act")).toBe("read-copy");
    expect(d.querySelector(".worth-row [data-act=read-copy]")).toBeNull();
    expect(dom(render([card([])])).querySelector("[data-act=read-copy]")).toBeNull();
  });

  it("opens every link in a new tab, and records the opening from the titles and Open it", () => {
    const d = dom(render([card([]), card([])]));
    const anchors = [...d.querySelectorAll("main a[href^='https://']")];
    expect(anchors).toHaveLength(3);
    for (const a of anchors) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.hasAttribute("data-open")).toBe(true);
    }
  });

  it("does not link a stored non-web URL, and offers no Open it for it", () => {
    const html = render([card([], { url: "javascript:alert(1)", title: "Odd" })]);
    expect(html).not.toContain("javascript:");
    expect(dom(html).querySelector(".worth-feature a[data-open]")).toBeNull();
    expect(dom(html).querySelector(".worth-feature h3")?.textContent).toBe("Odd");
  });

  describe("the reason on the featured card", () => {
    it("quotes a focus entry the owner gave as what they said", () => {
      for (const source of ["stated", "asked"] as const) {
        expect(reasonOf(render([card([focus("home batteries", source)])]))).toBe(
          "mentions Chorequest, which you're working on",
        );
      }
    });

    it("never says the old 'fits what you're working on'", () => {
      for (const source of ["stated", "asked", "inferred"] as const) {
        expect(reasonOf(render([card([focus("home batteries", source)])]))).not.toMatch(/fit/);
      }
    });

    it("names the first two matched words, and no more", () => {
      const two = reasonOf(render([card([focus("x", "stated", ["Chorequest", "image"])])]));
      expect(two).toBe("mentions Chorequest and image, which you're working on");
      const three = reasonOf(render([card([focus("x", "stated", ["a1", "b2", "c3"])])]));
      expect(three).toBe("mentions a1 and b2, which you're working on");
    });

    it("escapes a matched word", () => {
      const html = render([card([focus("x", "stated", ["<b>&"])])]);
      expect(html).toContain("mentions &lt;b&gt;&amp;, which");
      expect(html).not.toContain("<b>&,");
    });

    it("never says 'You said' for an inferred focus entry, and calls it a guess", () => {
      const html = render([card([focus("home batteries", "inferred")])]);
      expect(reasonOf(html)).toBe(
        "mentions Chorequest, which may be what you're working on (a guess)",
      );
    });

    it("keeps Open it, Keep, Skip and Archive on the featured card, and takes its space's colour", () => {
      const html = render([card([], on("kitchen"))], {
        catalog: [tag("kitchen", { pinned: true, color: "clay" })],
      });
      const feature = dom(html).querySelector(".worth-feature");
      expect(feature?.classList.contains("space-clay")).toBe(true);
      expect(feature?.querySelector("a.button.primary")?.textContent).toBe("Open it");
      expect(feature?.querySelector("[data-act=archive] .slide-words > span")?.textContent).toBe(
        "Archive",
      );
      expect(feature?.querySelector("[data-act=snooze] .slide-words > span")?.textContent).toBe(
        "Skip",
      );
      expect(
        feature?.querySelector("[data-act=intent-keep] .slide-words > span")?.textContent,
      ).toBe("Keep");
    });

    it("says a link not opened lately was saved over a month ago", () => {
      expect(reasonOf(render([card([{ kind: "not_opened_recently" }])]))).toBe(
        "saved over a month ago",
      );
    });

    it("falls back to the saved date for no why or no reason", () => {
      expect(reasonOf(render([card([{ kind: "no_why" }])]))).toBe("saved March 12");
      expect(reasonOf(render([card([])]))).toBe("saved March 12");
      expect(reasonOf(render([card([], { savedAt: new Date("2025-03-12T10:00:00Z") })]))).toBe(
        "saved March 12, 2025",
      );
    });

    it("prefers focus over the other reasons", () => {
      const html = render([
        card([{ kind: "no_why" }, { kind: "not_opened_recently" }, focus("x", "stated")]),
      ]);
      expect(reasonOf(html)).toBe("mentions Chorequest, which you're working on");
    });

    it("has no separate reason line: the reason ends the grey line, with no dot of its own", () => {
      const d = dom(render([card([focus("x", "stated")])]));
      expect(d.querySelector(".reason")).toBeNull();
      expect(d.querySelector(".worth-feature .dot")).toBeNull();
      expect(lineParts(render([card([focus("x", "stated")])]))).toEqual([
        "example.com",
        "mentions Chorequest, which you're working on",
      ]);
      expect(themeCss).not.toMatch(/\.reason[{,.]/);
    });

    it("starts the grey line with a dot in the space's color only when the card has a space", () => {
      const rule = themeCss
        .match(/([^{}]*)\{[^}]*\}/g)
        ?.find((r) => r.includes(">.card-line::before"));
      expect(rule).toBeDefined();
      const selector = rule?.slice(0, rule.indexOf("{")) ?? "";
      for (const color of SPACE_COLORS) expect(selector).toContain(`.worth-feature.space-${color}`);
      expect(rule).toMatch(/background:var\(--space\)/);
      expect(selector).not.toMatch(/\.worth-feature>/);
    });

    it("shows the saved date once: in the reason when that is the plain one, not again", () => {
      const plain = lineParts(render([card([])])).join("|");
      expect(plain.match(/March 12/g)).toHaveLength(1);
      expect(lineParts(render([card([{ kind: "not_opened_recently" }])]))).toEqual([
        "example.com",
        "saved over a month ago",
      ]);
      for (const reasons of [[focus("x", "stated")], [{ kind: "not_opened_recently" as const }]]) {
        expect(lineParts(render([card(reasons)])).join("|")).not.toContain("March 12");
      }
    });
  });

  it("shows the featured why under a You saved it for label without quotes, as a guess when inferred, with the reason ending the grey line", () => {
    const said = dom(render([card([{ kind: "not_opened_recently" }])]));
    expect(said.querySelector(".feature-why .why-label")?.textContent).toBe("You saved it for");
    expect(said.querySelector(".feature-why")?.textContent).toBe("You saved it forto compare");
    expect(lineParts(said.toString())).toEqual(["example.com", "saved over a month ago"]);
    const plain = dom(render([card([], { why: { text: "maybe solar", source: "inferred" } })]));
    expect(plain.querySelector(".feature-why")?.textContent).toBe("Why (a guess): maybe solar");
    expect(plain.querySelector(".feature-why .why-label")).toBeNull();
    expect(lineParts(plain.toString())).toEqual(["example.com", "saved March 12"]);
  });

  it("shows a row's why, a guess as a guess, and its site and date when it has none", () => {
    const d = dom(
      render([
        card([]),
        card([], { why: { text: "x", source: "inferred" } }),
        card([], { why: { text: "y", source: "stated" } }),
        card([], { why: null }),
      ]),
    );
    const rows = [...d.querySelectorAll(".worth-row")];
    expect(rows[0]?.querySelector(".also-why")?.textContent).toBe("Why (a guess): x");
    expect(rows[1]?.querySelector(".also-why")?.textContent).toBe("y");
    expect(rows[2]?.querySelector(".also-why")).toBeNull();
    expect(
      [...(rows[2]?.querySelectorAll(".card-line > *") ?? [])].map((p) => p.textContent),
    ).toEqual(["example.com", "saved March 12"]);
  });

  it("keeps each row's why to one line, cut with an ellipsis (#286)", () => {
    const rule = themeCss.match(/\.also-why\{([^}]*)\}/);
    for (const decl of ["white-space:nowrap", "overflow:hidden", "text-overflow:ellipsis"]) {
      expect(rule?.[1]).toContain(decl);
    }
  });

  it("asks why, in amber, on the featured card only", () => {
    const html = render([card([], { why: null }), card([], { why: null })]);
    const d = dom(html);
    const needy = [...d.querySelectorAll(".needs-you")];
    expect(needy).toHaveLength(1);
    expect(needy[0]?.classList.contains("worth-feature")).toBe(true);
    expect(needy[0]?.querySelector(".ask")?.textContent).toContain("Why did you save this?");
    expect(needy[0]?.querySelector("button[data-act=why]")?.textContent).toBe("Tell me why");
    expect(needy[0]?.querySelector(".feature-why [data-why-answer]")).not.toBeNull();
    expect(d.querySelectorAll("button[data-act=why]")).toHaveLength(1);
    expect(d.querySelector(".worth-row .ask")).toBeNull();
  });

  it("uses amber only for what needs you and its Tell me why, never a reason or a picture", () => {
    const rules = [...themeCss.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel = "", body = ""]) => ({
      sel: sel.trim(),
      body,
    }));
    const amber = rules.filter((r) => /amber/.test(r.body)).map((r) => r.sel);
    for (const sel of amber) expect(sel, sel).not.toMatch(/reason|tile|image|-pic/);
    expect(amber).toEqual(expect.arrayContaining([".tell-why"]));
    expect(amber.some((s) => s.split(",").includes(".needs-you"))).toBe(true);
    const html = render([card([{ kind: "no_why" }], { why: null })]);
    for (const el of dom(html).querySelectorAll(".worth-feature .card-line, [data-pic]")) {
      expect(el.className).not.toMatch(/amber|needs-you|tell-why/);
    }
  });

  it("colors each card by its link's first colored pinned tag, and leaves the rest neutral", () => {
    const catalog = [
      tag("loose", { color: "teal", pinned: false }),
      tag("plain", { pinned: true }),
      tag("needy", { color: "amber", pinned: true }),
      tag("kitchen", { color: "clay", pinned: true }),
      tag("garden", { color: "green", pinned: true }),
    ];
    const cards = [
      card([], { ...on("loose", "plain", "needy", "kitchen", "garden"), why: null }),
      card([], on("loose")),
      card([], on("plain", "needy")),
    ];
    const d = dom(render(cards, { catalog }));
    const classOf = (i: number) =>
      (d.querySelector(`[data-id="${cards[i]?.link.id}"]`) as HTMLElement).className;
    expect(
      classOf(0)
        .split(" ")
        .filter((c) => c.startsWith("space-")),
    ).toEqual(["space-clay"]);
    expect(classOf(1)).not.toMatch(/space-/);
    expect(classOf(2)).not.toMatch(/space-/);
    for (const el of d.querySelectorAll("[class]")) expect(el.className).not.toMatch(/amber/);
  });

  it("shows the stored image from this site, never the page's own image URL", () => {
    const remote = {
      status: "ok" as const,
      fetchedAt: NOW,
      title: null,
      description: null,
      imageUrl: "https://images.example/x.png",
    };
    const withImage = card([], { snapshot: remote });
    const without = card([], { snapshot: remote });
    const html = render([withImage, without], {
      images: new Map([[withImage.link.id, { version: "v1", fit: "cover" }]]),
    });
    expect(outsideRefs(html)).toEqual([]);
    expect(html).not.toContain("images.example");
    const d = dom(html);
    expect(d.querySelector(".worth-feature img")?.getAttribute("src")).toBe(
      `/images/${withImage.link.id}?v=v1`,
    );
    expect(d.querySelector(".worth-row img")).toBeNull();
  });

  it("gives every card the edit dialog's data, one title marker and one picture", () => {
    const first = card([]);
    const pictures = new Map<string, PictureInfo>([
      [first.link.id, { own: true, pageVersion: "page-v1", pageFit: "cover" }],
    ]);
    const images = new Map<string, ShownPicture>([
      [first.link.id, { version: "own-v1", fit: "cover" }],
    ]);
    const d = dom(render([first, card([])], { pictures, images }));
    const cards = [...d.querySelectorAll("#worth-cards [data-id]")] as HTMLElement[];
    expect(cards).toHaveLength(2);
    for (const c of cards) {
      expect(c.hasAttribute("data-title"), c.className).toBe(true);
      expect(c.querySelectorAll("[data-card-title]"), c.className).toHaveLength(1);
      expect(c.querySelectorAll("[data-pic]"), c.className).toHaveLength(1);
    }
    const feature = d.querySelector(".worth-feature") as HTMLElement;
    expect(feature.dataset.own).toBe("1");
    expect(feature.dataset.pageVersion).toBe("page-v1");
    expect(feature.dataset.version).toBe("own-v1");
  });

  it("puts the edit dialog on the page once there are cards", () => {
    expect(dom(render([card([])])).querySelectorAll("dialog#edit-link")).toHaveLength(1);
  });

  it("renders hostile titles, whys and focus text as inert text", () => {
    const evil = `"><img src=https://evil.example/x onerror=alert(1)><script>alert(2)</script>`;
    const html = render([
      card([focus(evil, "stated")], { title: evil, why: { text: evil, source: "stated" } }),
      card([], { title: evil, why: { text: evil, source: "inferred" } }),
    ]);
    const d = dom(html);
    expect(d.querySelectorAll("main img")).toHaveLength(0);
    expect(d.querySelectorAll("main script")).toHaveLength(0);
    expect(outsideRefs(html)).toEqual([]);
    expect(d.querySelector(".worth-feature h3")?.textContent).toBe(evil);
    expect(d.querySelector(".worth-row h4")?.textContent).toBe(evil);
  });
});

it("starts Explore with an Explore spine and keeps its heading visually hidden (#306)", () => {
  const html = homePage({ worth: worth([card([])]), shelf: "", spaces: "" });
  const section = dom(html).querySelector("section.worth") as Element;
  expect(section.firstElementChild?.className).toBe("spine");
  expect(section.querySelector(".spine-word")?.textContent).toBe("Explore");
  const h2 = section.querySelector("h2");
  expect([h2?.id, h2?.className, h2?.textContent]).toEqual(["worth", "visually-hidden", "Explore"]);
});

it("orders home: the search, the Handy shelf, Explore, Your spaces, Tidy up", () => {
  const html = homePage({
    worth: worth([card([])]),
    shelf: handyShelf({ items: [], suggestions: [], catalog: [], images: new Map() }),
    spaces: spacesSection([]),
  });
  const main = dom(html).querySelector("main.home") as HTMLElement;
  expect([...main.children].map((c) => c.className)).toEqual([
    "home-search",
    "handy",
    "worth",
    "spaces",
    "tidy-tray",
  ]);
});

const SNOOZE = { until: "2026-10-28T10:00:00.000Z", previous: "2099-01-01T00:00:00.000Z" };
const CHANGE = {
  before: { state: "active", snoozedUntil: null },
  after: { state: "archived" },
};
/** What nothing wrong answers: Archive the change as JSON, anything else 204. */
const fine = (s: Post): Answer =>
  s.url === "/home/archive" ? { status: 200, body: CHANGE } : { status: 204 };
const KEEP_CHANGE = {
  before: { intent: "explore", intentSource: null },
  after: { intent: "keep", intentSource: "stated" },
  at: "2026-10-14T10:00:00.000Z",
};
const REDIRECT: Answer = { status: 0, type: "opaqueredirect" };
const ROW = {
  status: "kept",
  source: "stated",
  since: "2026-10-14T10:00:00.000Z",
  answeredAt: null,
  waitDays: 30,
};

/** Home with the Handy shelf (empty unless given), run with its scripts. */
const home = (links: DigestLink[], answer: (s: Post) => Answer = fine, extra: Extra = {}) =>
  runPage(
    homePage({
      worth: worth(links, extra),
      shelf: handyShelf({ items: [], suggestions: [], catalog: [], images: new Map() }),
      spaces: "",
    }),
    answer,
  );
const urls = (p: ReturnType<typeof runPage>) => p.sent.map((s) => s.url);
/** Whether the Worth a look card is hidden; the Handy shelf may hold a tile with the same id. */
const hidden = (p: ReturnType<typeof runPage>, id: string) =>
  (p.$(`#worth-cards [data-id="${id}"]`) as HTMLElement).hidden;
/** Clicks a card's menu row, as the owner opens the ⋯ and picks it. */
const pick = (p: ReturnType<typeof runPage>, id: string, act: string) => {
  const menu = p.$(`[data-id="${id}"] details.card-menu`) as HTMLDetailsElement;
  menu.open = true;
  p.dispatch(p.$(`[data-id="${id}"] .card-menu button[data-act=${act}]`), "click");
  return menu;
};
const two = () => [card([]), card([])];

describe("the home page's script", () => {
  it("records an opening from Open it or a row's title with /links/opened, without stopping the link", async () => {
    const cards = two();
    const p = home(cards);
    const first = p.dispatch(p.$(".worth-feature a.button"), "click");
    p.dispatch(p.$(".worth-row h4 a"), "click");
    await p.settle();
    expect(first.defaultPrevented).toBe(false);
    expect(p.sent).toEqual([
      {
        url: "/links/opened",
        body: { id: cards[0]?.link.id },
        redirect: "manual",
        keepalive: true,
      },
      {
        url: "/links/opened",
        body: { id: cards[1]?.link.id },
        redirect: "manual",
        keepalive: true,
      },
    ]);
  });

  it("records an opening from a title on a space card with /links/opened, without stopping the link", async () => {
    const titled = link({ title: "Bread" });
    const p = runPage(
      homePage({
        worth: worth([card([])]),
        shelf: handyShelf({ items: [], suggestions: [], catalog: [], images: new Map() }),
        spaces: spacesSection([
          { key: "kitchen", name: "Kitchen", color: null, count: 1, recent: [titled] },
        ]),
      }),
      fine,
    );
    const click = p.dispatch(p.$(".home-space-recent a[data-open]"), "click");
    await p.settle();
    expect(click.defaultPrevented).toBe(false);
    expect(p.sent).toEqual([
      { url: "/links/opened", body: { id: titled.id }, redirect: "manual", keepalive: true },
    ]);
  });

  it("Skip on the featured card hides it once put off, and Undo sends back the snooze and shows it", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const p = home(cards, (s) =>
      s.url === "/home/snooze" ? { status: 200, body: SNOOZE } : { status: 204 },
    );
    p.dispatch(p.$(".feature-quiet button[data-act=snooze]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/home/snooze", body: { id }, redirect: "manual" });
    expect(hidden(p, id)).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe("Skipped. Back in two weeks.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({ url: "/home/unsnooze" });
    expect(p.sent[1]?.body).toEqual({ id, ...SNOOZE });
    expect(hidden(p, id)).toBe(false);
  });

  it("Skip in a row's menu closes the menu, posts once and hides the row", async () => {
    const cards = two();
    const id = cards[1]?.link.id as string;
    const p = home(cards, (s) =>
      s.url === "/home/snooze" ? { status: 200, body: SNOOZE } : { status: 204 },
    );
    const menu = pick(p, id, "snooze");
    await p.settle();
    expect(menu.open).toBe(false);
    expect(urls(p)).toEqual(["/home/snooze"]);
    expect(hidden(p, id)).toBe(true);
  });

  it("sends nothing for a second Skip while the first is unanswered", async () => {
    const cards = two();
    let answer = (_: unknown) => {};
    const held = new Promise((r) => (answer = r));
    const p = home(cards, (s) =>
      s.url === "/home/snooze" ? { status: 200, body: SNOOZE, wait: held } : { status: 204 },
    );
    p.dispatch(p.$(".feature-quiet button[data-act=snooze]"), "click");
    p.dispatch(p.$(".feature-quiet button[data-act=snooze]"), "click");
    answer(null);
    await p.settle();
    expect(urls(p)).toEqual(["/home/snooze"]);
    expect(hidden(p, cards[0]?.link.id as string)).toBe(true);
  });

  it.each([
    ["Skip, then Archive", "snooze", "archive", "/home/snooze", "Skipped. Back in two weeks."],
    [
      "Archive, then Skip",
      "archive",
      "snooze",
      "/home/archive",
      "Archived. Off Home, All links and your spaces. Still findable in search.",
    ],
  ])("sends one action for a card: %s before the first is answered", async (_, a, b, url, undo) => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    let answer = (_: unknown) => {};
    const held = new Promise((r) => (answer = r));
    const p = home(cards, (s) =>
      s.url === "/home/snooze"
        ? { status: 200, body: SNOOZE, wait: held }
        : { ...fine(s), wait: held },
    );
    p.dispatch(p.$(`.feature-quiet button[data-act=${a}]`), "click");
    p.dispatch(p.$(`.feature-quiet button[data-act=${b}]`), "click");
    answer(null);
    await p.settle();
    expect(urls(p)).toEqual([url]);
    expect(hidden(p, id)).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe(undo);
  });

  it("sends nothing from a row's menu while that row's Skip is unanswered", async () => {
    const cards = two();
    const id = cards[1]?.link.id as string;
    let answer = (_: unknown) => {};
    const held = new Promise((r) => (answer = r));
    const p = home(cards, (s) =>
      s.url === "/home/snooze" ? { status: 200, body: SNOOZE, wait: held } : { status: 204 },
    );
    pick(p, id, "snooze");
    pick(p, id, "archive");
    pick(p, id, "keep");
    answer(null);
    await p.settle();
    expect(urls(p)).toEqual(["/home/snooze"]);
    expect(p.$("#undo-bar span").textContent).toBe("Skipped. Back in two weeks.");
  });

  it.each([
    [
      "Skip, then Delete link",
      "snooze",
      "delete-link",
      "/home/snooze",
      "Skipped. Back in two weeks.",
    ],
    ["Delete link, then Skip", "delete-link", "snooze", "/links/delete", "Link deleted."],
    [
      "Keep handy, then Delete link",
      "keep",
      "delete-link",
      "/tools/keep",
      "Kept on your Handy shelf.",
    ],
  ])("sends one action for a card: %s before the first is answered", async (_, a, b, url, undo) => {
    const cards = two();
    const id = cards[1]?.link.id as string;
    let answer = (_: unknown) => {};
    const held = new Promise((r) => (answer = r));
    const p = home(cards, (s) =>
      s.url === "/home/snooze"
        ? { status: 200, body: SNOOZE, wait: held }
        : s.url === "/tools/keep"
          ? { status: 200, body: { tool: ROW }, wait: held }
          : { status: 204, wait: held },
    );
    pick(p, id, a);
    pick(p, id, b);
    answer(null);
    await p.settle();
    expect(urls(p).filter((u) => u !== "/")).toEqual([url]);
    expect(p.$("#undo-bar span").textContent).toBe(undo);
  });

  it("frees a card again once its Delete was undone", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const p = home(cards, (s) =>
      s.url === "/home/snooze" ? { status: 200, body: SNOOZE } : { status: 204 },
    );
    pick(p, id, "delete-link");
    await p.settle();
    expect(p.document.querySelector(`[data-id="${id}"]`)).toBeNull();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(hidden(p, id)).toBe(false);
    p.dispatch(p.$(".feature-quiet button[data-act=snooze]"), "click");
    await p.settle();
    expect(urls(p)).toEqual(["/links/delete", "/links/restore", "/home/snooze"]);
    expect(hidden(p, id)).toBe(true);
  });

  it("Archive on the featured card archives once, hides it, and Undo puts it back", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const p = home(cards);
    p.dispatch(p.$(".feature-quiet button[data-act=archive]"), "click");
    await p.settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).toMatchObject({ url: "/home/archive", body: { id } });
    expect(hidden(p, id)).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe(
      "Archived. Off Home, All links and your spaces. Still findable in search.",
    );
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({ url: "/home/undo-state", body: { id, change: CHANGE } });
    expect(hidden(p, id)).toBe(false);
  });

  it("Archive in a row's menu archives exactly once", async () => {
    const cards = two();
    const id = cards[1]?.link.id as string;
    const p = home(cards);
    pick(p, id, "archive");
    await p.settle();
    expect(urls(p)).toEqual(["/home/archive"]);
    expect(hidden(p, id)).toBe(true);
  });

  it.each([
    ["a redirect to the sign-in page", "archive", REDIRECT],
    ["a 200 with no change", "archive", { status: 200, body: {} }],
    ["a 204 with no change", "archive", { status: 204 }],
    ["a redirect to the sign-in page", "snooze", REDIRECT],
    ["a 204 with no snooze", "snooze", { status: 204 }],
  ])("keeps the card and offers no Undo when %s answers %s", async (_, act, answer) => {
    const cards = two();
    const p = home(cards, () => answer);
    p.dispatch(p.$(`.feature-quiet button[data-act=${act}]`), "click");
    await p.settle();
    expect(hidden(p, cards[0]?.link.id as string)).toBe(false);
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect(p.$("#home-error").textContent).toMatch(/did not work/);
  });

  it.each([
    ["snooze", "This link is already put off. Reload."],
    ["archive", "Changed since."],
  ])("keeps the card with the refusal's words when %s gets a 409", async (act, message) => {
    const cards = two();
    const p = home(cards, () => ({ status: 409, body: { code: "conflict", message } }));
    p.dispatch(p.$(`.feature-quiet button[data-act=${act}]`), "click");
    await p.settle();
    expect(hidden(p, cards[0]?.link.id as string)).toBe(false);
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect(p.$("#home-error").textContent).toBe(message);
    expect(p.sent).toHaveLength(1);
  });

  it("keeps the card gone and says why when Undo is refused", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const p = home(cards, (s) =>
      s.url === "/home/undo-state" ? { status: 409, body: { message: "Changed since." } } : fine(s),
    );
    p.dispatch(p.$(".feature-quiet button[data-act=archive]"), "click");
    await p.settle();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(hidden(p, id)).toBe(true);
    expect(p.$("#home-error").textContent).toBe("Changed since.");
  });

  it("★ a Skip refused after Archive went through leaves the card out", async () => {
    // [Hiding at Skip's click and showing the card again on its refusal, restoring an archived card.]
    const cards = two();
    const id = cards[0]?.link.id as string;
    let archived = (_: unknown) => {};
    let refused = (_: unknown) => {};
    const archive = new Promise((r) => (archived = r));
    const snooze = new Promise((r) => (refused = r));
    const p = home(cards, (s) =>
      s.url === "/home/archive"
        ? { status: 200, body: CHANGE, wait: archive }
        : s.url === "/home/snooze"
          ? {
              status: 409,
              body: {
                code: "conflict",
                message: "This link is already archived. Reload.",
              },
              wait: snooze,
            }
          : { status: 204 },
    );
    p.dispatch(p.$(".feature-quiet button[data-act=archive]"), "click");
    p.dispatch(p.$(".feature-quiet button[data-act=snooze]"), "click");
    archived(null);
    await p.settle();
    expect(hidden(p, id)).toBe(true);
    refused(null);
    await p.settle();
    expect(hidden(p, id)).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe(
      "Archived. Off Home, All links and your spaces. Still findable in search.",
    );
  });

  it("Tell me why on the featured card saves the answer in place of the question and the amber", async () => {
    const cards = [card([], { why: null }), card([])];
    const id = cards[0]?.link.id as string;
    const p = home(cards);
    const form = p.$(".needs-you form.why-form");
    expect(form.hidden).toBe(true);
    p.dispatch(p.$(".needs-you button[data-act=why]"), "click");
    expect(form.hidden).toBe(false);
    (form.querySelector("input") as HTMLInputElement).value = "  for the <kitchen>  ";
    p.dispatch(form, "submit");
    await p.settle();
    expect(p.sent).toEqual([
      {
        url: "/home/why",
        body: { id, text: "  for the <kitchen>  " },
        redirect: "manual",
        keepalive: undefined,
      },
    ]);
    const article = p.$(`[data-id="${id}"]`);
    expect(article.classList.contains("needs-you")).toBe(false);
    expect(article.querySelector(".ask")).toBeNull();
    const answer = article.querySelector(".feature-why [data-why-answer]") as HTMLElement;
    expect(answer.hidden).toBe(false);
    expect(answer.querySelector(".why-label")?.textContent).toBe("You saved it for");
    expect(answer.textContent).toBe("You saved it forfor the <kitchen>");
    expect(answer.querySelector("kitchen")).toBeNull();
  });

  it("sends no blank answer, and shows the refusal of one that was not saved", async () => {
    const p = home([card([], { why: null })], () => ({
      status: 409,
      body: { message: "This link already has a reason. Reload." },
    }));
    p.dispatch(p.$(".needs-you button[data-act=why]"), "click");
    const input = p.$(".needs-you form.why-form input") as HTMLInputElement;
    input.value = "   ";
    p.dispatch(p.$(".needs-you form.why-form"), "submit");
    await p.settle();
    expect(p.sent).toEqual([]);
    input.value = "because";
    p.dispatch(p.$(".needs-you form.why-form"), "submit");
    await p.settle();
    expect(p.$("#home-error").textContent).toBe("This link already has a reason. Reload.");
    expect(p.$(".needs-you")).not.toBeNull();
  });

  it("Delete link on the only card takes it out, focuses the page's heading and offers Undo", async () => {
    const cards = [card([])];
    const id = cards[0]?.link.id as string;
    const p = home(cards);
    pick(p, id, "delete-link");
    await p.settle();
    expect(urls(p)).toEqual(["/links/delete"]);
    expect(p.document.querySelector(`[data-id="${id}"]`)).toBeNull();
    expect(p.focused().at(-2)?.tagName).toBe("H1");
    expect(p.focused().at(-1)).toBe(p.$("#undo-bar button"));
    expect(p.$("#undo-bar span").textContent).toBe("Link deleted.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(urls(p)).toEqual(["/links/delete", "/links/restore"]);
    expect(p.document.querySelector(`[data-id="${id}"]`)).not.toBeNull();
  });

  describe("the Worth tray when its last card goes (#306)", () => {
    const collapsed = (p: ReturnType<typeof runPage>) =>
      p.document.querySelector(WORTH_EMPTY) !== null;
    const gone =
      (answer: (s: Post) => Answer = fine) =>
      (s: Post): Answer =>
        s.url === "/home/snooze" ? { status: 200, body: SNOOZE } : answer(s);

    it.each([
      [
        "Not now",
        (p: ReturnType<typeof runPage>) =>
          p.dispatch(p.$(".feature-quiet button[data-act=snooze]"), "click"),
      ],
      [
        "Archive",
        (p: ReturnType<typeof runPage>) =>
          p.dispatch(p.$(".feature-quiet button[data-act=archive]"), "click"),
      ],
      [
        "Delete link, which removes the card",
        (p: ReturnType<typeof runPage>) =>
          pick(p, p.$("[data-id]").dataset.id as string, "delete-link"),
      ],
    ])("collapses after %s, stays open for an error, and opens again on Undo", async (_, act) => {
      const p = home([card([])], gone());
      expect(collapsed(p)).toBe(false);
      act(p);
      await p.settle();
      expect(p.$("#undo-bar span").textContent).not.toBe("");
      expect(collapsed(p)).toBe(true);
      p.$("#home-error").textContent = "Something went wrong.";
      expect(collapsed(p)).toBe(false);
      p.$("#home-error").textContent = "";
      expect(collapsed(p)).toBe(true);
      p.dispatch(p.$("#undo-bar button"), "click");
      await p.settle();
      expect(collapsed(p)).toBe(false);
    });

    it("stays open while any card or row is left, and a refusal never collapses it", async () => {
      const cards = two();
      const p = home(cards, gone());
      p.dispatch(p.$(".feature-quiet button[data-act=snooze]"), "click");
      await p.settle();
      expect(hidden(p, cards[0]?.link.id as string)).toBe(true);
      expect(collapsed(p)).toBe(false);
      pick(p, cards[1]?.link.id as string, "snooze");
      await p.settle();
      expect(collapsed(p)).toBe(true);
      const refused = home([card([])], () => ({ status: 500 }));
      refused.dispatch(refused.$(".feature-quiet button[data-act=snooze]"), "click");
      await refused.settle();
      expect(collapsed(refused)).toBe(false);
    });
  });

  it("Remove saved copy hides the featured card's Saved copy link", async () => {
    const cards = [card([])];
    const id = cards[0]?.link.id as string;
    const p = home(cards, () => ({ status: 204 }), { copies: new Map([[id, COPY]]) });
    pick(p, id, "remove-copy");
    await p.settle();
    expect(urls(p)).toEqual(["/links/copy/remove"]);
    expect((p.$(".worth-feature .saved-copy") as HTMLElement).hidden).toBe(true);
  });

  it.each([
    ["the featured card", 0, "feature-pic"],
    ["a row", 1, "also-pic"],
  ])("Edit on %s shows the saved title and picture there", async (_, i, box) => {
    const cards = two();
    const id = cards[i]?.link.id as string;
    const p = home(cards, (s) =>
      s.url === "/links/edit"
        ? {
            status: 200,
            body: {
              title: "Renamed",
              shown: "Renamed",
              url: cards[i]?.link.url,
              initials: "RE",
              version: null,
              fit: null,
              picture: { own: false, pageVersion: null, pageFit: null },
              editId: "e1",
            },
          }
        : { status: 204 },
    );
    stubDialog(p);
    pick(p, id, "edit");
    (p.$("#edit-title") as HTMLInputElement).value = "Renamed";
    p.dispatch(p.$("#edit-link form"), "submit");
    await p.settle();
    expect(urls(p)).toEqual(["/links/edit"]);
    expect(p.$(`[data-id="${id}"] [data-card-title] a`).textContent).toBe("Renamed");
    const pic = p.$(`[data-id="${id}"] [data-pic]`);
    expect(pic.className).toBe(`${box} initials-box`);
    expect(p.$("#home-error").textContent).toBe("");
  });
});

it("reloads when shown again from the back-forward cache", () => {
  const html = render(two());
  const { document, DOMParser } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => !s.includes("sign-out"))
    .join("\n");
  const location = { reloads: 0, reload: () => location.reloads++ };
  const onWindow = new Map<string, (event: unknown) => void>();
  new Function("document", "location", "addEventListener", "DOMParser", "window", code)(
    document,
    location,
    (type: string, fn: (event: unknown) => void) => onWindow.set(type, fn),
    DOMParser,
    document.defaultView,
  );
  onWindow.get("pageshow")?.({ persisted: false });
  expect(location.reloads).toBe(0);
  onWindow.get("pageshow")?.({ persisted: true });
  expect(location.reloads).toBe(1);
});

describe("Keep handy on an Explore card", () => {
  const withShelf = (links: DigestLink[], extra: Extra = {}) =>
    homePage({
      worth: worth(links, extra),
      shelf: handyShelf({ items: [], suggestions: [], catalog: [], images: new Map() }),
      spaces: "",
    });

  it("from a row's menu hides the row, puts the link on the shelf, and Undo sends back the rows and shows it", async () => {
    const cards = two();
    const id = cards[1]?.link.id as string;
    const onShelf = homePage({
      worth: worth([]),
      shelf: handyShelf({
        items: [
          {
            link: cards[1]?.link as Link,
            tool: {
              status: "kept",
              source: "stated",
              since: new Date(ROW.since),
              answeredAt: null,
              waitDays: 30,
            },
            due: false,
            gone: false,
          },
        ],
        suggestions: [],
        catalog: [],
        images: new Map(),
      }),
      spaces: "",
    });
    const pages = [onShelf, withShelf(cards)];
    const p = runPage(withShelf(cards), (s) =>
      s.body === undefined
        ? { status: 200, text: pages.shift() ?? "" }
        : s.url === "/tools/keep"
          ? { status: 200, body: { tool: ROW, previous: null } }
          : { status: 204 },
    );
    pick(p, id, "keep");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/tools/keep", body: { id }, redirect: "manual" });
    expect(hidden(p, id)).toBe(true);
    expect(p.document.querySelector(`#handy-shelf [data-id="${id}"]`)).not.toBeNull();
    expect(p.$("#undo-bar span").textContent).toBe("Kept on your Handy shelf.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent.find((s) => s.url === "/tools/undo")?.body).toEqual({
      id,
      tool: ROW,
      previous: null,
    });
    expect(hidden(p, id)).toBe(false);
    expect(urls(p)).toEqual(["/tools/keep", "/", "/tools/undo", "/"]);
  });

  it("keeps the card with the refusal's words, offers no Undo and refreshes nothing on a 409", async () => {
    const cards = [card([])];
    const message = "That link's Keep handy state changed. Reload the page.";
    const p = runPage(withShelf(cards), () => ({
      status: 409,
      body: { code: "conflict", message },
    }));
    pick(p, cards[0]?.link.id as string, "keep");
    await p.settle();
    expect(hidden(p, cards[0]?.link.id as string)).toBe(false);
    expect(p.$("#home-error").textContent).toBe(message);
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect(urls(p)).toEqual(["/tools/keep"]);
  });

  it("Not handy anymore on a pick kept by now leaves the card, swaps the row, and Undo swaps it back", async () => {
    const cards = [card([])];
    const id = cards[0]?.link.id as string;
    const views = new Map<string, LinkView>([
      [id, { handy: { status: "kept", source: "stated", due: false }, gone: null }],
    ]);
    const moved = { tool: { ...ROW, status: "declined" }, previous: ROW };
    const p = runPage(withShelf(cards, { views }), (s) =>
      s.body === undefined
        ? { status: 200, text: withShelf(cards, { views }) }
        : s.url === "/tools/not-handy"
          ? { status: 200, body: moved }
          : { status: 204 },
    );
    pick(p, id, "not-handy");
    await p.settle();
    const row = (act: string) => p.$(`[data-id="${id}"] .card-menu button[data-act=${act}]`);
    expect(hidden(p, id)).toBe(false);
    expect(row("keep").hidden).toBe(false);
    expect(row("not-handy").hidden).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent.find((s) => s.url === "/tools/undo")?.body).toEqual({ id, ...moved });
    expect(row("keep").hidden).toBe(true);
    expect(row("not-handy").hidden).toBe(false);
    expect(urls(p)).toEqual(["/tools/not-handy", "/", "/tools/undo", "/"]);
  });
});

describe("Keep on the featured card (#340)", () => {
  const keepAnswer = (s: Post): Answer =>
    s.url === "/home/keep" ? { status: 200, body: KEEP_CHANGE } : { status: 204 };
  const keepButton = ".worth-feature button[data-act=intent-keep]";

  it("posts /home/keep once, takes the card out with an Undo bar, and Undo posts /home/undo-intent with the change it got and brings the card back", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const p = home(cards, keepAnswer);
    p.dispatch(p.$(keepButton), "click");
    p.dispatch(p.$(keepButton), "click");
    await p.settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).toMatchObject({ url: "/home/keep", body: { id }, redirect: "manual" });
    expect(hidden(p, id)).toBe(true);
    expect(hidden(p, cards[1]?.link.id as string)).toBe(false);
    expect(p.$("#undo-bar strong").textContent).toBe("Kept.");
    expect(p.$("#undo-bar span").textContent).toBe("Kept. Marked To keep. Explore won't show it.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({
      url: "/home/undo-intent",
      body: { id, change: KEEP_CHANGE },
    });
    expect(hidden(p, id)).toBe(false);
  });

  it("keeps the card, shows the refusal in the page's alert and offers no Undo when Keep is refused", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const p = home(cards, (s) =>
      s.url === "/home/keep"
        ? {
            status: 409,
            body: { code: "conflict", message: "This link is already archived. Reload." },
          }
        : { status: 204 },
    );
    p.dispatch(p.$(keepButton), "click");
    await p.settle();
    expect(hidden(p, id)).toBe(false);
    expect(p.$("#home-error").textContent).toBe("This link is already archived. Reload.");
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect(p.focused().at(-1)).toBe(p.$(`[data-id="${id}"] details.card-menu summary`));
  });

  it("is also the menu row's path: a row's Keep it takes the row out the same way", async () => {
    const cards = two();
    const id = cards[1]?.link.id as string;
    const p = home(cards, keepAnswer);
    pick(p, id, "intent-keep");
    await p.settle();
    expect(urls(p)).toEqual(["/home/keep"]);
    expect(hidden(p, id)).toBe(true);
  });
});

describe("the opened line (#340)", () => {
  const lines = (html: string) => dom(html).querySelectorAll("#worth-cards [data-opened]");

  it("is drawn hidden on a card whose link was never opened, and shown on one that was", () => {
    const opened = card([], { lastOpenedAt: new Date("2026-10-01T00:00:00Z") });
    const d = dom(render([card([]), opened, card([], { lastOpenedAt: NOW })]));
    const feature = d.querySelector(".worth-feature [data-opened]") as HTMLElement;
    expect(feature.hasAttribute("hidden")).toBe(true);
    expect(feature.className).toBe("opened");
    expect(feature.textContent).toBe("Opened. Keep it or archive it?");
    const rows = [...d.querySelectorAll(".worth-row .also-open[data-opened]")] as HTMLElement[];
    expect(rows.map((r) => r.hasAttribute("hidden"))).toEqual([false, false]);
    expect(rows[0]?.textContent).toBe("Opened. Keep it or archive it?");
    expect(lines(render([card([]), card([])]))).toHaveLength(2);
    expect([...lines(render([card([]), card([])]))].every((e) => e.hasAttribute("hidden"))).toBe(
      true,
    );
  });

  it("sits between the featured card's grey line and its buttons, and under a row's why", () => {
    const d = dom(render([card([], { lastOpenedAt: NOW }), card([], { lastOpenedAt: NOW })]));
    const kids = [...(d.querySelector(".worth-feature")?.children ?? [])].map((e) => e.className);
    const at = kids.indexOf("opened");
    expect(kids[at - 1]).toContain("card-line");
    expect(kids[at + 1]).toBe("feature-buttons");
    const body = [...(d.querySelector(".worth-row .also-body")?.children ?? [])].map(
      (e) => e.className,
    );
    expect(body).toEqual(["", "also-why", "also-open"]);
  });

  it("is shown the moment the link is opened from the page, before any answer, on that card only", async () => {
    const cards = two();
    const p = home(cards);
    const line = (n: number) =>
      p.$(`[data-id="${cards[n]?.link.id}"] [data-opened]`) as HTMLElement;
    expect([line(0).hidden, line(1).hidden]).toEqual([true, true]);
    p.dispatch(p.$(".worth-feature a.button"), "click");
    expect([line(0).hidden, line(1).hidden]).toEqual([false, true]);
    p.dispatch(p.$(".worth-row h4 a"), "click");
    expect([line(0).hidden, line(1).hidden]).toEqual([false, false]);
    await p.settle();
    expect(p.sent.map((m) => m.url)).toEqual(["/links/opened", "/links/opened"]);
  });
});

describe("an Edit that makes an Explore card To keep (#340)", () => {
  const saved = (intent: string, intentSource: string | null) => ({
    title: "Title",
    shown: "Title",
    url: "https://example.com/1",
    initials: "T",
    version: null,
    fit: null,
    picture: { own: false, pageVersion: null, pageFit: null },
    tags: [],
    space: null,
    lineSpace: null,
    intent,
    intentSource,
    editId: "e1",
  });
  const radio = (p: ReturnType<typeof home>, value: string) =>
    p.$(`#edit-link input[name=edit-intent][value=${value}]`) as HTMLInputElement;

  it("takes the card out of Explore on Save, and brings it back when the edit is undone", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const p = home(cards, (s) =>
      s.url === "/links/edit"
        ? { status: 200, body: saved("keep", "stated") }
        : s.url === "/links/edit/undo"
          ? { status: 200, body: saved("explore", null) }
          : { status: 204 },
    );
    stubDialog(p);
    p.dispatch(p.$(`.worth-feature button[data-act=edit]`), "click");
    await p.settle();
    for (const other of ["explore", "keep"]) radio(p, other).checked = other === "keep";
    p.dispatch(radio(p, "keep"), "click");
    p.dispatch(p.$("#edit-link form"), "submit");
    await p.settle();
    expect(hidden(p, id)).toBe(true);
    expect(hidden(p, cards[1]?.link.id as string)).toBe(false);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(urls(p).at(-1)).toBe("/links/edit/undo");
    expect(hidden(p, id)).toBe(false);
  });
});

describe("Explore has no gone card (#340)", () => {
  it("draws no gone row, band or It still works for a link, and nothing in the page names one", () => {
    const d = dom(render([card([]), card([])]));
    expect(
      d.querySelector(".worth-gone, .gone-band, [data-gone], [data-act=still-works]"),
    ).toBeNull();
    expect(d.querySelector("main")?.textContent).not.toContain("seems gone");
  });
});

describe("the Explore cards' pictures", () => {
  it.each([
    ["cover", { version: "v1", fit: "cover" }, (c: string) => `img.${c}`],
    [
      "contain",
      { version: "v1", fit: "contain" },
      (c: string) => `div.${c}.icon-box > img.site-icon`,
    ],
    ["none", undefined, (c: string) => `div.${c}.initials-box > span.pic-initials`],
  ] as const)("renders %s on the featured card and a row", (_, picture, sel) => {
    const feature = card([]);
    const row = card([]);
    const images = new Map<string, ShownPicture>();
    if (picture) for (const l of [feature.link, row.link]) images.set(l.id, picture);
    const d = dom(render([feature, row], { images }));
    expect(d.querySelector(`.worth-feature ${sel("feature-pic")}`)).not.toBeNull();
    expect(d.querySelector(`.worth-row ${sel("also-pic")}`)).not.toBeNull();
  });
});

describe("Tidy up's tray on Home", () => {
  const input = {
    queue: [{ link: link({ title: "Old one" }), gone: false, fit: null }],
    hasFocus: false,
    copies: new Map(),
    images: new Map(),
    catalog: [],
    now: NOW,
  };
  const html = (tidy?: typeof input) =>
    homePage({ worth: worth([card([])]), shelf: "", spaces: "", tidy });
  const tray = (h: string) => parseHTML(h).document.querySelector("section.tidy-tray");

  it("draws the tray, closed, with a Start button, when asked", () => {
    const t = tray(html(input)) as Element;
    expect(t.querySelector(".tidy-closed button")?.textContent).toBe("Start");
    expect(html(input)).not.toContain('href="/tidy"');
  });

  it("draws the empty tray, and runs and records nothing for it, when not asked", () => {
    const h = html();
    expect(tray(h)?.querySelector(".tidy-quiet")?.textContent).toBe("Nothing to tidy right now.");
    expect(h).not.toContain("Clear out a few links?");
    expect(h).not.toContain('getElementById("tidy")');
  });

  it("sits after the spaces, at the bottom of the page", () => {
    const h = homePage({ worth: worth([]), shelf: "", spaces: "<b>spaces</b>", tidy: input });
    expect(h.indexOf("<b>spaces</b>")).toBeLessThan(h.indexOf('class="tidy-tray"'));
  });

  it("records the opening of a link in it, like the Handy shelf's", async () => {
    const p = runPage(html(input));
    p.dispatch(p.$(".tidy-step a[data-open]"), "click");
    await p.settle();
    expect(p.sent).toEqual([
      {
        url: "/links/opened",
        body: { id: p.$(".tidy-step").getAttribute("data-id") },
        redirect: "manual",
        keepalive: true,
      },
    ]);
  });

  it("lays the tray on the tray colour like the others", () => {
    const rule = themeCss.match(/\.handy,\.worth,\.spaces,\.tidy-tray\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("background:var(--tray)");
  });
});

describe("a Home card that is slow to answer (#314)", () => {
  /** The featured card's visible buttons, which say their working word; the ⋯ rows only dim. */
  const SLIDES: [string, string, string][] = [
    ["Keep", "intent-keep", "Keeping…"],
    ["Skip", "snooze", "Skipping…"],
    ["Archive", "archive", "Archiving…"],
  ];
  const slow = (p: ReturnType<typeof home>, id: string, act: string, button: string) => {
    const target = p.$(`[data-id="${id}"] ${button}`);
    p.dispatch(target, "click");
    return { act, target };
  };

  it.each(SLIDES)(
    "%s: the button says its working word after 300ms, and both clear",
    async (_n, act, word) => {
      const cards = two();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const p = home(cards, (s) =>
        s.url === "/home/archive" || s.url === "/home/snooze" || s.url === "/home/keep"
          ? {
              ...(s.url === "/home/archive"
                ? { status: 200, body: CHANGE }
                : s.url === "/home/keep"
                  ? { status: 200, body: KEEP_CHANGE }
                  : { status: 200, body: SNOOZE }),
              wait: gate,
            }
          : fine(s),
      );
      const id = cards[0]?.link.id as string;
      const { target } = slow(p, id, act, `.feature-quiet button[data-act=${act}]`);
      const label = target.querySelector(".slide-words > span") as Element;
      const rest = label.textContent;
      await p.settle();
      expect(p.timers.pending(300)).toBe(1);
      expect(p.$(`[data-id="${id}"]`).hasAttribute("data-busy")).toBe(false);
      p.timers.fire();
      expect(p.$(`[data-id="${id}"]`).hasAttribute("data-busy")).toBe(true);
      expect(label.textContent).toBe(word);
      expect(target.querySelector("svg")).not.toBeNull();
      release();
      await p.settle();
      expect(p.document.querySelector("[data-busy]")).toBeNull();
      expect(label.textContent).toBe(rest);
    },
  );

  it("a ⋯ menu row only dims the card: no label changes", async () => {
    const cards = two();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = home(cards, (s) =>
      s.url === "/home/snooze" ? { status: 200, body: SNOOZE, wait: gate } : fine(s),
    );
    const id = cards[1]?.link.id as string;
    const row = p.$(`[data-id="${id}"] .card-menu button[data-act=snooze]`);
    const rest = row.innerHTML;
    pick(p, id, "snooze");
    await p.settle();
    p.timers.fire();
    expect(p.$(`[data-id="${id}"]`).hasAttribute("data-busy")).toBe(true);
    expect(row.innerHTML).toBe(rest);
    release();
    await p.settle();
    expect(p.document.querySelector("[data-busy]")).toBeNull();
  });
});
