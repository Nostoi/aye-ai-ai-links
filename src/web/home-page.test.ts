import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { DigestLink, DigestReason } from "../core/digest.js";
import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { LinkView } from "../core/tools.js";
import type { FocusEntry, Link, Source, Tag } from "../core/types.js";
import { copyHref } from "./copy-page.js";
import { handyShelf } from "./handy-shelf.js";
import { homePage, type WorthCards } from "./home-page.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { spacesSection } from "./spaces-section.js";
import { themeCss } from "./theme.js";

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
    putAwayAt: null,
    tidyKeptAt: null,
    lastSurfacedAt: null,
    snoozedUntil: null,
    state: "active",
    snapshot: null,
    ...over,
  };
};

const focus = (text: string, source: Source): DigestReason => ({
  kind: "focus_words",
  focus: { id: "f", text, source, writtenBy: "agent", createdAt: NOW } satisfies FocusEntry,
});
const card = (reasons: DigestReason[], over: Partial<Link> = {}): DigestLink => ({
  link: link(over),
  reasons,
});
const GONE: LinkView = {
  handy: null,
  gone: { since: new Date("2026-10-01T00:00:00Z"), checkedAt: NOW },
};
const COPY: CopyInfo = { madeAt: new Date("2026-03-12T10:00:00Z") };

type Extra = Partial<Omit<WorthCards, "links">>;
const worth = (links: DigestLink[], extra: Extra = {}): WorthCards => {
  const views = new Map<string, LinkView>(extra.views ?? []);
  if (extra.gone && !views.has(extra.gone.id)) views.set(extra.gone.id, GONE);
  return { links, images: new Map(), now: NOW, catalog: [], gone: null, ...extra, views };
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
const reasonOf = (html: string) => dom(html).querySelector(".worth-feature .reason")?.textContent;
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

describe("Worth a look today", () => {
  it("is left out when there is nothing to show", () => {
    const html = render([]);
    expect(html).not.toContain("Worth a look today");
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

  it("shows the first pick as the featured card and the others as Also today rows, in order", () => {
    const cards = [card([]), card([]), card([])];
    const d = dom(render(cards));
    expect(d.querySelectorAll(".worth-feature")).toHaveLength(1);
    expect(d.querySelectorAll(".worth-row")).toHaveLength(2);
    expect(d.querySelector("h3.also-today")?.textContent).toBe("Also today");
    expect([...d.querySelectorAll("[data-id]")].map((e) => (e as HTMLElement).dataset.id)).toEqual(
      cards.map((c) => c.link.id),
    );
    expect((d.querySelector(".worth-feature") as HTMLElement).dataset.id).toBe(cards[0]?.link.id);
  });

  it("leaves out Also today when there is only the featured card", () => {
    const d = dom(render([card([])]));
    expect(d.querySelector(".also-today")).toBeNull();
    expect(d.querySelector(".worth-rows")).toBeNull();
  });

  it("gives the featured card Open it, It's stale and Not now, and a row only its ⋯", () => {
    const d = dom(render([card([]), card([])]));
    const feature = d.querySelector(".worth-feature") as HTMLElement;
    const open = feature.querySelector("a.button.primary[data-open]") as HTMLAnchorElement;
    expect(open.textContent).toBe("Open it");
    expect(open.getAttribute("href")).toBe(feature.querySelector("h3 a")?.getAttribute("href"));
    expect(shownButtons(feature)).toEqual(["archive It's stale", "snooze Not now"]);
    const row = d.querySelector(".worth-row");
    expect(shownButtons(row)).toEqual([]);
    expect(row?.querySelector("a.button")).toBeNull();
  });

  it("gives a row the seven-row menu and the featured card the menu without its visible two", () => {
    const [first, second] = [card([]), card([])];
    const copies = new Map([
      [first?.link.id as string, COPY],
      [second?.link.id as string, COPY],
    ]);
    const d = dom(render([first as DigestLink, second as DigestLink], { copies }));
    expect(menuRows(d.querySelector(".worth-row"))).toEqual([
      "archive",
      "put-away",
      "snooze",
      "keep",
      "not-handy (hidden)",
      "edit",
      "remove-copy",
      "delete-link",
    ]);
    expect(menuRows(d.querySelector(".worth-feature"))).toEqual([
      "put-away",
      "keep",
      "not-handy (hidden)",
      "edit",
      "remove-copy",
      "delete-link",
    ]);
    const noCopy = dom(render([card([]), card([])]));
    expect(menuRows(noCopy.querySelector(".worth-row"))).not.toContain("remove-copy");
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
          `You said you're working on "home batteries"`,
        );
      }
    });

    it("never says 'You said' for an inferred focus entry, and calls it a guess", () => {
      const html = render([card([focus("home batteries", "inferred")])]);
      expect(reasonOf(html)).toBe(`Maybe you're working on "home batteries" (a guess)`);
      expect(html).not.toContain("You said");
    });

    describe("a link that came back", () => {
      const PUT_AWAY = new Date("2026-08-20T10:00:00Z");
      const cameBack = (
        text: string,
        source: Source,
        putAwayAt = PUT_AWAY,
        over: Partial<Link> = {},
      ): DigestLink =>
        card(
          [
            {
              kind: "came_back",
              focus: { id: "f", text, source, writtenBy: "agent", createdAt: NOW },
              putAwayAt,
            },
          ],
          { state: "archived", putAwayAt, ...over },
        );

      it("names the month it was put away and the focus it fits, for a stated or asked focus", () => {
        for (const source of ["stated", "asked"] as const) {
          expect(reasonOf(render([cameBack("home batteries", source)]))).toBe(
            `You put this away in August. It fits "home batteries".`,
          );
        }
      });

      it("calls an inferred focus a guess and never says 'It fits' flatly", () => {
        const html = render([cameBack("home batteries", "inferred")]);
        expect(reasonOf(html)).toBe(
          `You put this away in August. It may fit "home batteries" (a guess).`,
        );
        expect(html).not.toContain("It fits");
      });

      it("adds the year when it was put away in another year", () => {
        const html = render([cameBack("x", "stated", new Date("2025-12-03T10:00:00Z"))]);
        expect(reasonOf(html)).toBe(`You put this away in December 2025. It fits "x".`);
      });

      it("keeps Open it, It's stale and Not now, and takes its space's colour", () => {
        const html = render([cameBack("x", "stated", PUT_AWAY, on("kitchen"))], {
          catalog: [tag("kitchen", { pinned: true, color: "clay" })],
        });
        const feature = dom(html).querySelector(".worth-feature");
        expect(feature?.classList.contains("space-clay")).toBe(true);
        expect(feature?.querySelector("a.button.primary")?.textContent).toBe("Open it");
        expect(feature?.querySelector("[data-act=archive]")?.textContent).toBe("It's stale");
        expect(feature?.querySelector("[data-act=snooze]")?.textContent).toBe("Not now");
      });
    });

    it("says a link not opened lately was saved over a month ago", () => {
      expect(reasonOf(render([card([{ kind: "not_opened_recently" }])]))).toBe(
        "You saved this over a month ago",
      );
    });

    it("falls back to the saved date for no why or never shown", () => {
      for (const kind of ["no_why", "never_surfaced"] as const) {
        expect(reasonOf(render([card([{ kind }])]))).toBe("You saved this March 12");
      }
      expect(reasonOf(render([card([], { savedAt: new Date("2025-03-12T10:00:00Z") })]))).toBe(
        "You saved this March 12, 2025",
      );
    });

    it("prefers focus over the other reasons", () => {
      const html = render([
        card([{ kind: "no_why" }, { kind: "not_opened_recently" }, focus("x", "stated")]),
      ]);
      expect(reasonOf(html)).toBe(`You said you're working on "x"`);
    });

    it("is a line with the space's dot, not a pill", () => {
      const d = dom(render([card([])]));
      expect(d.querySelector(".worth-feature .reason .dot")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
      expect(themeCss).not.toMatch(/\.reason\{[^}]*border-radius:999px/);
    });
  });

  it("shows the featured why quoted, as a guess when inferred, and the date only when the reason lacks it", () => {
    const said = dom(render([card([{ kind: "not_opened_recently" }])]));
    expect(said.querySelector(".feature-why")?.textContent).toBe('"to compare"');
    const parts = (d: Document) =>
      [...d.querySelectorAll(".worth-feature .card-line > *")].map((p) => p.textContent);
    expect(parts(said)).toEqual(["example.com", "saved March 12"]);
    const plain = dom(render([card([], { why: { text: "maybe solar", source: "inferred" } })]));
    expect(plain.querySelector(".feature-why")?.textContent).toBe("Why (a guess): maybe solar");
    expect(parts(plain)).toEqual(["example.com"]);
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
    expect(rows[1]?.querySelector(".also-why")?.textContent).toBe('"y"');
    expect(rows[2]?.querySelector(".also-why")).toBeNull();
    expect(
      [...(rows[2]?.querySelectorAll(".card-line > *") ?? [])].map((p) => p.textContent),
    ).toEqual(["example.com", "saved March 12"]);
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
    for (const el of dom(html).querySelectorAll(".reason, [data-pic]")) {
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

  it("gives every card, the gone row too, the edit dialog's data, one title marker and one picture", () => {
    const gone = link();
    const pictures = new Map<string, PictureInfo>([
      [gone.id, { own: true, pageVersion: "page-v1", pageFit: "cover" }],
    ]);
    const images = new Map<string, ShownPicture>([[gone.id, { version: "own-v1", fit: "cover" }]]);
    const d = dom(render([card([]), card([])], { gone, pictures, images }));
    const cards = [...d.querySelectorAll("#worth-cards [data-id]")] as HTMLElement[];
    expect(cards).toHaveLength(3);
    for (const c of cards) {
      expect(c.hasAttribute("data-title"), c.className).toBe(true);
      expect(c.querySelectorAll("[data-card-title]"), c.className).toHaveLength(1);
      expect(c.querySelectorAll("[data-pic]"), c.className).toHaveLength(1);
    }
    const goneRow = d.querySelector(".worth-gone") as HTMLElement;
    expect(goneRow.dataset.own).toBe("1");
    expect(goneRow.dataset.pageVersion).toBe("page-v1");
    expect(goneRow.dataset.version).toBe("own-v1");
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

it("orders home: the search, the Handy shelf, Worth a look today, Your spaces", () => {
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
  ]);
  expect(html.indexOf("<script>")).toBe(
    html.indexOf(`<script>\ndocument.addEventListener("keydown"`),
  );
});

const SNOOZE = {
  until: "2026-10-28T10:00:00.000Z",
  claimedAt: "2026-10-14T10:00:00.000Z",
  previousSurfacedAt: "2026-09-01T10:00:00.000Z",
};
const CHANGE = {
  before: { state: "active", putAwayAt: null, snoozedUntil: null },
  after: { state: "archived", putAwayAt: null },
};
/** What nothing wrong answers: It's stale the change as JSON, anything else 204. */
const fine = (s: Post): Answer =>
  s.url === "/home/archive" ? { status: 200, body: CHANGE } : { status: 204 };
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
  it("records an opening from Open it or a row's title with a keepalive post, without stopping the link", async () => {
    const cards = two();
    const p = home(cards);
    const first = p.dispatch(p.$(".worth-feature a.button"), "click");
    p.dispatch(p.$(".worth-row h4 a"), "click");
    await p.settle();
    expect(first.defaultPrevented).toBe(false);
    expect(p.sent).toEqual([
      { url: "/home/opened", body: { id: cards[0]?.link.id }, redirect: "manual", keepalive: true },
      { url: "/home/opened", body: { id: cards[1]?.link.id }, redirect: "manual", keepalive: true },
    ]);
  });

  it("a came-back card's three buttons post the existing routes", async () => {
    const away = new Date("2026-08-20T10:00:00Z");
    const came: DigestLink = {
      link: link({ state: "archived", putAwayAt: away }),
      reasons: [
        {
          kind: "came_back",
          focus: { id: "f", text: "x", source: "stated", writtenBy: "agent", createdAt: NOW },
          putAwayAt: away,
        },
      ],
    };
    const id = came.link.id;
    const p = home([came, card([])], (s) =>
      s.url === "/home/snooze" ? { status: 200, body: SNOOZE } : { status: 204 },
    );
    p.dispatch(p.$(".worth-feature a.button"), "click");
    p.dispatch(p.$(".feature-quiet button[data-act=snooze]"), "click");
    await p.settle();
    p.dispatch(p.$(".feature-quiet button[data-act=archive]"), "click");
    await p.settle();
    expect(urls(p)).toEqual(["/home/opened", "/home/snooze", "/home/archive"]);
    expect(p.sent.map((s) => (s.body as { id: string }).id)).toEqual([id, id, id]);
  });

  it("Not now on the featured card hides it once put off, and Undo sends back the snooze and shows it", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const p = home(cards, (s) =>
      s.url === "/home/snooze" ? { status: 200, body: SNOOZE } : { status: 204 },
    );
    p.dispatch(p.$(".feature-quiet button[data-act=snooze]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/home/snooze", body: { id }, redirect: "manual" });
    expect(hidden(p, id)).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe("Hidden for two weeks.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({ url: "/home/unsnooze" });
    expect(p.sent[1]?.body).toEqual({ id, ...SNOOZE });
    expect(hidden(p, id)).toBe(false);
  });

  it("Not now in a row's menu closes the menu, posts once and hides the row", async () => {
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

  it("sends nothing for a second Not now while the first is unanswered", async () => {
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
    ["Not now, then It's stale", "snooze", "archive", "/home/snooze", "Hidden for two weeks."],
    [
      "It's stale, then Not now",
      "archive",
      "snooze",
      "/home/archive",
      "Let go. You won't see it again unless you search for it.",
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

  it("sends nothing from a row's menu while that row's Not now is unanswered", async () => {
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
    expect(p.$("#undo-bar span").textContent).toBe("Hidden for two weeks.");
  });

  it.each([
    ["Not now, then Delete link", "snooze", "delete-link", "/home/snooze", "Hidden for two weeks."],
    ["Delete link, then Not now", "delete-link", "snooze", "/links/delete", "Link deleted."],
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

  it("It's stale on the featured card archives once, hides it, and Undo puts it back", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const p = home(cards);
    p.dispatch(p.$(".feature-quiet button[data-act=archive]"), "click");
    await p.settle();
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).toMatchObject({ url: "/home/archive", body: { id } });
    expect(hidden(p, id)).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe(
      "Let go. You won't see it again unless you search for it.",
    );
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({ url: "/home/undo-state", body: { id, change: CHANGE } });
    expect(hidden(p, id)).toBe(false);
  });

  it("It's stale in a row's menu archives exactly once", async () => {
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

  it("★ a Not now refused after It's stale went through leaves the card out", async () => {
    // [Hiding at Not now's click and showing the card again on its refusal, restoring an archived card.]
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
                message: "This link is already out of your lists. Reload.",
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
      "Let go. You won't see it again unless you search for it.",
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
    expect(answer.textContent).toBe('"for the <kitchen>"');
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

describe("Keep handy on a Worth a look card", () => {
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

describe("the Worth a look gone row (#128)", () => {
  const ROWS = { check: { result: "alive" }, previous: { result: "dead" } };

  it("is the last row, amber while it seems gone, with the gone line and the seven-row menu", () => {
    const g = link({ why: null });
    const d = dom(render([card([]), card([]), card([])], { gone: g }));
    const rows = [...d.querySelectorAll(".worth-row")];
    const last = rows[rows.length - 1] as HTMLElement;
    expect(rows).toHaveLength(3);
    expect(last.dataset.id).toBe(g.id);
    expect(last.classList.contains("worth-gone")).toBe(true);
    expect(last.querySelector("[data-gone] p.small")?.textContent).toBe("This page seems gone");
    expect(shownButtons(last)).toEqual(["still-works It still works", "gone-done It's stale"]);
    expect(menuRows(last)[0]).toBe("archive");
    expect(menuRows(last)).toHaveLength(7);
    expect(last.querySelector("[data-card-title] a")?.getAttribute("href")).toBe(g.url);
    expect(last.querySelector(".ask")).toBeNull();
    expect(themeCss).toMatch(
      /,\.worth-gone:has\(\[data-gone\]:not\(\[hidden\]\)\)\{outline:2px solid var\(--amber\)/,
    );
  });

  it("keeps Read the saved copy on its warning line when it has a copy, and only then", () => {
    const g = link();
    const withCopy = dom(render([card([])], { gone: g, copies: new Map([[g.id, COPY]]) }));
    const reads = [...withCopy.querySelectorAll(".worth-gone [data-act=read-copy]")];
    expect(reads.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Read the saved copy", copyHref(g.id, "/")],
    ]);
    expect(reads[0]?.previousElementSibling?.hasAttribute("data-gone")).toBe(true);
    expect(menuRows(withCopy.querySelector(".worth-gone"))).toContain("remove-copy");
    expect(
      dom(render([card([])], { gone: link() })).querySelector("[data-act=read-copy]"),
    ).toBeNull();
    expect(themeCss).toContain("[data-gone][hidden]+.gone-copy{display:none}");
  });

  it("stands alone when there are no reading picks, with no Also today heading", () => {
    const d = dom(render([], { gone: link() }));
    expect(d.querySelector("#worth")?.textContent).toBe("Worth a look today");
    expect(d.querySelector(".worth-feature")).toBeNull();
    expect(d.querySelector(".also-today")).toBeNull();
    expect(d.querySelectorAll("#worth-cards .worth-gone")).toHaveLength(1);
  });

  it("leaves home without a Worth a look section when there is nothing at all", () => {
    expect(dom(render([])).querySelector(".worth")).toBeNull();
  });

  const open = (answer: (s: Post) => Answer = fine, copy = false) => {
    const g = link();
    const p = home([card([])], answer, {
      gone: g,
      copies: copy ? new Map([[g.id, COPY]]) : new Map(),
    });
    return { p, g, row: () => p.$(".worth-gone") as HTMLElement };
  };

  it("It still works hides the warning and keeps the row; Undo brings the warning back", async () => {
    const { p, g, row } = open((s) =>
      s.url === "/links/still-works" ? { status: 200, body: ROWS } : { status: 204 },
    );
    p.dispatch(p.$(".worth-gone button[data-act=still-works]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/links/still-works", body: { id: g.id } });
    expect(row().hidden).toBe(false);
    expect((row().querySelector("[data-gone]") as HTMLElement).hidden).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe("Marked as working.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({
      url: "/links/still-works/undo",
      body: { id: g.id, ...ROWS },
    });
    expect((row().querySelector("[data-gone]") as HTMLElement).hidden).toBe(false);
  });

  it("It's stale on the warning line archives once, and Undo sends the change back", async () => {
    const { p, g, row } = open();
    p.dispatch(p.$(".worth-gone button[data-act=gone-done]"), "click");
    await p.settle();
    expect(urls(p)).toEqual(["/home/archive"]);
    expect(p.sent[0]).toMatchObject({ body: { id: g.id } });
    expect(row().hidden).toBe(true);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({
      url: "/home/undo-state",
      body: { id: g.id, change: CHANGE },
    });
    expect(row().hidden).toBe(false);
  });

  it("Remove saved copy hides the warning line's Read the saved copy", async () => {
    const { p, g } = open(() => ({ status: 204 }), true);
    pick(p, g.id, "remove-copy");
    await p.settle();
    expect(urls(p)).toEqual(["/links/copy/remove"]);
    expect((p.$(".worth-gone .gone-copy") as HTMLElement).hidden).toBe(true);
  });
});

describe("the Worth a look cards' pictures", () => {
  it.each([
    ["cover", { version: "v1", fit: "cover" }, (c: string) => `img.${c}`],
    [
      "contain",
      { version: "v1", fit: "contain" },
      (c: string) => `div.${c}.icon-box > img.site-icon`,
    ],
    ["none", undefined, (c: string) => `div.${c}.initials-box > span.pic-initials`],
  ] as const)("renders %s on the featured card, a row and the gone row", (_, picture, sel) => {
    const feature = card([]);
    const row = card([]);
    const gone = link();
    const images = new Map<string, ShownPicture>();
    if (picture) for (const l of [feature.link, row.link, gone]) images.set(l.id, picture);
    const d = dom(render([feature, row], { images, gone }));
    expect(d.querySelector(`.worth-feature ${sel("feature-pic")}`)).not.toBeNull();
    expect(d.querySelector(`.worth-row:not(.worth-gone) ${sel("also-pic")}`)).not.toBeNull();
    expect(d.querySelector(`.worth-gone ${sel("also-pic")}`)).not.toBeNull();
  });
});

describe("Tidy up's start line", () => {
  const html = (tidy?: boolean) =>
    homePage({ worth: worth([card([])]), shelf: "", spaces: "", ...(tidy ? { tidy } : {}) });
  const start = (h: string) => parseHTML(h).document.querySelector('.tidy-start a[href="/tidy"]');

  it("offers a Start link to /tidy with its two lines when asked", () => {
    const h = html(true);
    expect(h).toContain("Clear out a few old links?");
    expect(h).toContain("Five, one at a time. Nothing gets deleted.");
    expect(start(h)?.textContent).toBe("Start");
  });

  it("is absent when not asked", () => {
    expect(html()).not.toContain("Clear out a few old links?");
    expect(start(html())).toBeNull();
  });

  it("sits after the spaces, at the bottom of the page", () => {
    const h = homePage({ worth: worth([]), shelf: "", spaces: "<b>spaces</b>", tidy: true });
    expect(h.indexOf("<b>spaces</b>")).toBeLessThan(h.indexOf("Clear out"));
  });

  it("is a control at least 44px tall with only theme tokens", () => {
    const css = themeCss;
    expect(css).toMatch(/\.tidy-start a[^{]*\{[^}]*min-height:44px/);
    const rules = css.match(/\.tidy-start[^{]*\{[^}]*\}/g)?.join("") ?? "";
    expect(rules).not.toMatch(/#[0-9a-f]{3,6}\b|amber/i);
  });
});
