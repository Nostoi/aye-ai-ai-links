import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { itRecordsOpenings, openAppended, runPage } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { searchPage } from "./pages.js";
import { spaceHref, spacePage } from "./space-page.js";
import { tagsPage } from "./tags-page.js";
import { themeCss } from "./theme.js";

const ORIGIN = "https://links.example";
const NOW = new Date("2026-10-14T12:00:00Z");
const HOSTILE = `<img src=x onerror=alert(1)>`;
const ODD_KEY = "c++ & ü/x#y";

const tag = (over: Partial<Tag> & { key: string }): Tag => ({
  name: over.key,
  kind: "topic",
  kindSource: "stated",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
  ...over,
});

const link = (id: string, over: Partial<Link> = {}): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  summarySource: null,
  why: { text: `because ${id}`, source: "stated" },
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
  ...over,
});

const onTag = (key: string) => [
  {
    key,
    name: key,
    source: "stated" as const,
    kind: "topic" as const,
    kindSource: "stated" as const,
  },
];

const HOME = tag({ key: "home batteries", name: "Home batteries", color: "teal", pinned: true });

const space = (over: Partial<Parameters<typeof spacePage>[0]> = {}) =>
  spacePage({
    tag: HOME,
    catalog: [HOME],
    links: [],
    older: null,
    images: new Map(),
    handy: new Map(),
    now: NOW,
    done: false,
    ...over,
  });

const dom = (html: string) => parseHTML(html).document;
/** The parts of a card's grey line. */
const lineParts = (card: Element | null | undefined) =>
  [...(card?.querySelectorAll(".card-line > :not([hidden])") ?? [])].map((e) => e.textContent);
const hrefs = (html: string, selector: string) =>
  [...dom(html).querySelectorAll(selector)].map((a) => a.getAttribute("href") as string);
/** The `tag` a rendered href names, read the way the server reads it. */
const tagOf = (href: string) => new URL(href, ORIGIN).searchParams.get("tag");

describe("spaceHref", () => {
  it("round-trips any key through the query, and names the done view and a cursor", () => {
    for (const key of [ODD_KEY, "a+b", "100%", "x&before=1", HOSTILE]) {
      expect(tagOf(spaceHref(key))).toBe(key);
    }
    const done = new URL(spaceHref(ODD_KEY, { done: true, before: "5.link+1" }), ORIGIN);
    expect(done.pathname).toBe("/spaces/done");
    expect(done.searchParams.get("before")).toBe("5.link+1");
    expect(done.searchParams.get("tag")).toBe(ODD_KEY);
  });
});

describe("a space page", () => {
  it("heads the page with the space's name and color dot and a quiet Change link to its panel", () => {
    const html = space();
    const header = dom(html).querySelector("header.page-head");
    expect(header?.className).toContain("space-teal");
    expect(header?.querySelector("h1")?.textContent?.trim()).toBe("Home batteries");
    expect(header?.querySelector("h1 .dot")).not.toBeNull();
    expect(dom(html).querySelector(".band, .band-color")).toBeNull();
    expect(hrefs(html, "header.page-head a")).toEqual(["/tags#tag=home%20batteries"]);
    expect(dom(html).querySelector("header.page-head a")?.textContent).toBe("Change");
    expect(html).not.toContain("Change this space");
  });

  it("sends Change to the Tags page with the key encoded, so any key comes back as itself", () => {
    for (const key of [ODD_KEY, "a+b", "100%", HOSTILE]) {
      const [href] = hrefs(space({ tag: tag({ key, name: key }) }), "header.page-head a");
      expect(href?.startsWith("/tags#tag=")).toBe(true);
      expect(new URLSearchParams((href as string).split("#")[1]).get("tag")).toBe(key);
    }
  });

  it.each([
    ["no color", null],
    ["a stored color that is not a space color", "amber"],
    ["CSS in the color", "teal;x"],
  ])("draws a neutral dot for a tag with %s", (_, color) => {
    const html = space({ tag: tag({ key: "k", color, pinned: true }) });
    expect(dom(html).querySelector("header.page-head")?.className).not.toMatch(/space-/);
    expect(html).not.toContain("space-amber");
    expect(html).not.toContain("teal;x");
  });

  it("draws every dot of an unpinned tag that kept a space color with no space class, as its cards", () => {
    const kept = tag({ key: "baking", name: "Baking", color: "violet" });
    const links = [link("a", { tags: onTag("baking") })];
    const dots = (html: string) =>
      [...dom(html).querySelectorAll("header.page-head, .back-link, .link-row")].map(
        (e) => e.className,
      );
    for (const done of [false, true]) {
      const html = space({ tag: kept, catalog: [kept], links, done });
      expect(dots(html), `done ${done}`).not.toEqual([]);
      for (const className of dots(html)) expect(className).not.toMatch(/space-/);
      const pinned = { ...kept, pinned: true };
      const again = space({ tag: pinned, catalog: [pinned], links, done });
      for (const className of dots(again)) expect(className).toContain("space-violet");
    }
  });

  it("gives an unpinned tag with no color a page with a neutral dot", () => {
    const html = space({ tag: tag({ key: "baking", name: "Baking" }), catalog: [] });
    expect(dom(html).querySelector("h1")?.textContent?.trim()).toBe("Baking");
    expect(dom(html).querySelector("header.page-head")?.className).not.toMatch(/space-/);
  });

  it.each([
    [
      tag({ key: "p", kind: "project", projectStatus: "active" }),
      "A project you're working on now",
    ],
    [tag({ key: "p", kind: "project", projectStatus: null }), "A project you're working on now"],
    [tag({ key: "p", kind: "project", projectStatus: "done" }), "A project you finished"],
    [
      tag({ key: "p", kind: "project", kindSource: "inferred", projectStatus: "active" }),
      "Maybe a project you're working on (a guess)",
    ],
  ])("says what a project is (%#)", (t, line) => {
    expect(dom(space({ tag: t })).querySelector(".page-kind")?.textContent).toBe(line);
  });

  it("says nothing of kind for a topic", () => {
    const html = space();
    expect(dom(html).querySelector(".page-kind")).toBeNull();
    expect(html).not.toContain("A topic you save links about");
  });

  it("shows a description only when the tag has one, escaped", () => {
    expect(dom(space()).querySelector(".page-description")).toBeNull();
    const html = space({ tag: { ...HOME, description: HOSTILE } });
    expect(dom(html).querySelector(".page-description")?.textContent).toBe(HOSTILE);
    expect(html).not.toContain("<img src=x");
  });

  it("puts Search this space with the list controls, to a search within the space", () => {
    for (const key of [HOME.key, ODD_KEY, HOSTILE]) {
      const html = space({ tag: tag({ key, name: key, pinned: true }) });
      const search = dom(html).querySelector("a.search-instead");
      expect(search?.textContent).toBe("Search this space");
      const url = new URL(search?.getAttribute("href") as string, ORIGIN);
      expect([url.pathname, url.searchParams.get("tag")]).toEqual(["/search", key]);
      expect(dom(html).querySelector(".view-switch")).not.toBeNull();
    }
  });

  it("keeps a hostile name inert in the title and heading", () => {
    const html = space({ tag: tag({ key: "x", name: HOSTILE }) });
    expect(html).not.toContain("<img src=x");
    expect(dom(html).querySelector("title")?.textContent).toContain(HOSTILE);
  });

  it("lists the links newest first as given, each in the space's color, opening in a new tab", () => {
    const links = [link("2", { tags: onTag("home batteries") }), link("1")];
    const html = space({ links, images: new Map([["2", { version: "v2", fit: "cover" }]]) });
    const cards = [...dom(html).querySelectorAll("#space-links .link-row")];
    expect(cards.map((c) => c.querySelector("h3")?.textContent?.trim())).toEqual([
      "Link 2",
      "Link 1",
    ]);
    expect(cards[0]?.className).toContain("space-teal");
    expect(cards[1]?.className).not.toMatch(/space-/);
    const a = cards[0]?.querySelector("h3 a");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(lineParts(cards[0])).toEqual(["ex.com"]);
    expect(cards[0]?.querySelector(".row-why")?.textContent).toBe('"because 2"');
  });

  it("groups the rows by the UTC month they were saved, as All links does", () => {
    const html = space({
      links: [
        link("2", { savedAt: new Date("2026-10-01T00:00:00Z") }),
        link("1", { savedAt: new Date("2025-12-31T23:59:59Z") }),
      ],
    });
    const sections = [...dom(html).querySelectorAll("#space-links > section.month")];
    expect(sections.map((s) => s.getAttribute("data-month"))).toEqual(["2026-10", "2025-12"]);
    expect(sections.map((s) => s.querySelector("h2")?.textContent)).toEqual([
      "October",
      "December 2025",
    ]);
  });

  it("names a card's space on its grey line only when it is not the page's own", () => {
    const kitchen = tag({ key: "kitchen", name: "Kitchen", color: "clay", pinned: true });
    const both = link("1", { tags: [...onTag("home batteries"), ...onTag("kitchen")] });
    const own = dom(space({ catalog: [HOME, kitchen], links: [both] }));
    expect(lineParts(own.querySelector("[data-id]"))).toEqual(["ex.com"]);
    // An unpinned tag's page has no color of its own, so the card's pinned space is named.
    const loose = tag({ key: "loose" });
    const elsewhere = link("2", { tags: [...onTag("loose"), ...onTag("kitchen")] });
    const other = dom(space({ tag: loose, catalog: [loose, kitchen], links: [elsewhere] }));
    expect(lineParts(other.querySelector("[data-id]"))).toEqual(["Kitchen", "ex.com"]);
  });

  it.each(["list", "pictures"] as const)("draws the page in the %s view it is given", (view) => {
    for (const done of [false, true]) {
      const d = dom(space({ view, done, links: [link("1")] }));
      expect(d.querySelector("main")?.getAttribute("data-view")).toBe(view);
      expect(
        d.querySelector(`.view-switch [data-choice=${view}]`)?.getAttribute("aria-pressed"),
      ).toBe("true");
    }
    const empty = dom(space({ view }));
    expect(empty.querySelector("main")?.getAttribute("data-view")).toBe(view);
    expect(empty.querySelector(".view-switch")).not.toBeNull();
  });

  it("uses only this site's stored images, never a page's own image URL", () => {
    const links = [
      link("2", {
        snapshot: {
          status: "ok",
          fetchedAt: NOW,
          title: null,
          description: null,
          imageUrl: "https://cdn.example/remote.png",
        },
      }),
      link("1"),
    ];
    const html = space({ links, images: new Map([["1", { version: "v1", fit: "cover" }]]) });
    const srcs = [...dom(html).querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["/images/1?v=v1"]);
    expect(outsideRefs(html)).toEqual([]);
  });

  it("asks Tell me why, as home does, on an active link with no why, and not on one with a why", () => {
    const d = dom(space({ links: [link("1", { why: null }), link("2")] }));
    const [needy, known] = [...d.querySelectorAll("#space-links .link-row")];
    expect(needy?.querySelector(".ask")?.textContent).toContain("Why did you save this?");
    expect(needy?.querySelector("button[data-act=why]")?.textContent).toBe("Tell me why");
    expect(needy?.querySelector("form.why-form")?.hasAttribute("hidden")).toBe(true);
    expect(known?.querySelector(".ask")).toBeNull();
    expect(d.querySelectorAll("button[data-act=why]")).toHaveLength(1);
  });

  it("says when the space has no links yet", () => {
    expect(space()).toContain("No links in this space yet.");
  });

  it("says a later page has no older links, not that the space is empty", () => {
    const html = space({ later: true });
    expect(html).toContain("No older links.");
    expect(html).not.toContain("No links in this space yet.");
    expect(space({ later: true, done: true })).not.toContain(
      "Nothing here is out of your lists yet.",
    );
  });

  it("shows Show older links only when older links exist, as a real link to the next page", () => {
    expect(dom(space({ links: [link("1")] })).querySelector("#older")).toBeNull();
    const html = space({ links: [link("1")], older: "100.1" });
    const older = new URL(hrefs(html, "#older")[0] as string, ORIGIN);
    expect(older.pathname).toBe("/spaces");
    expect(older.searchParams.get("tag")).toBe("home batteries");
    expect(older.searchParams.get("before")).toBe("100.1");
  });

  it("links to the links out of your lists", () => {
    const done = hrefs(space(), "a.done-link").map((h) => new URL(h, ORIGIN));
    expect(done.map((u) => [u.pathname, u.searchParams.get("tag")])).toEqual([
      ["/spaces/done", "home batteries"],
    ]);
  });
});

describe("a space's sort orders", () => {
  const tagIn = (href: string) => new URL(href, ORIGIN);

  it("names the order in an address only when it is not newest, with the tag and cursor", () => {
    const params = (href: string) => [...tagIn(href).searchParams.entries()];
    expect(params(spaceHref("k"))).toEqual([["tag", "k"]]);
    expect(params(spaceHref("k", { order: "newest" }))).toEqual([["tag", "k"]]);
    expect(params(spaceHref("a b", { order: "opened", before: "r5.x" }))).toEqual([
      ["tag", "a b"],
      ["order", "opened"],
      ["before", "r5.x"],
    ]);
    expect(tagIn(spaceHref("k", { order: "oldest", done: true })).pathname).toBe("/spaces/done");
  });

  it("offers all three orders as links to the space in that order", () => {
    const d = dom(space({ links: [link("1")] }));
    const choices = [...d.querySelectorAll("nav.orders a")];
    expect(choices.map((a) => a.textContent)).toEqual([
      "Newest first",
      "Oldest first",
      "Recently opened",
    ]);
    expect(
      choices.map((a) => tagIn(a.getAttribute("href") as string).searchParams.get("order")),
    ).toEqual([null, "oldest", "opened"]);
    expect(choices.map((a) => tagOf(a.getAttribute("href") as string))).toEqual(
      Array(3).fill("home batteries"),
    );
  });

  it.each(["newest", "oldest", "opened"] as const)("marks %s as the current order", (order) => {
    const d = dom(space({ order, links: [link("1")] }));
    const current = [...d.querySelectorAll("nav.orders a[aria-current=true]")];
    expect(current.map((a) => a.textContent)).toEqual([
      { newest: "Newest first", oldest: "Oldest first", opened: "Recently opened" }[order],
    ]);
    const selected = d.querySelector("form.order-select option[selected]");
    expect(selected?.textContent).toBe(current[0]?.textContent);
  });

  it("gives the phone a select in a form to this space, and the page script that submits it", () => {
    const html = space({ order: "oldest", links: [link("1")] });
    const d = dom(html);
    const form = d.querySelector("form.order-select");
    expect(form?.getAttribute("action")).toBe("/spaces");
    expect(form?.querySelector("input[name=tag]")?.getAttribute("value")).toBe("home batteries");
    expect(html).toContain('querySelector("form.order-select")');
  });

  it("pages in the same order: Show older links keeps it, and says Show more links off newest", () => {
    const oldest = space({ order: "oldest", links: [link("1")], older: "o5.x" });
    const a = dom(oldest).querySelector("#older");
    expect(a?.textContent).toBe("Show more links");
    const href = tagIn(a?.getAttribute("href") as string);
    expect([href.searchParams.get("order"), href.searchParams.get("before")]).toEqual([
      "oldest",
      "o5.x",
    ]);
    const newest = dom(space({ links: [link("1")], older: "5.x" })).querySelector("#older");
    expect(newest?.textContent).toBe("Show older links");
    expect(tagIn(newest?.getAttribute("href") as string).searchParams.has("order")).toBe(false);
  });

  it("sends the link to Out of your lists with no order, as that view has no sort", () => {
    const href = hrefs(space({ order: "oldest", links: [link("1")] }), "a.done-link")[0];
    expect(tagIn(href as string).searchParams.has("order")).toBe(false);
  });

  it("groups Recently opened by the month of opening, not of saving", () => {
    const opened = new Date("2026-10-05T00:00:00Z");
    const html = space({
      order: "opened",
      links: [
        link("2", { savedAt: new Date("2026-09-01T00:00:00Z"), lastOpenedAt: opened }),
        link("1", { savedAt: new Date("2026-08-01T00:00:00Z"), lastOpenedAt: opened }),
      ],
    });
    const sections = [...dom(html).querySelectorAll("#space-links > section.month")];
    expect(sections.map((s) => s.querySelector("h2")?.textContent)).toEqual(["Opened in October"]);
    expect(sections[0]?.querySelectorAll(".link-row")).toHaveLength(2);
  });

  it.each([
    ["newest", false, "No links in this space yet."],
    ["oldest", false, "No links in this space yet."],
    ["opened", false, "Nothing in this space opened yet. Links you open from this site show here."],
    ["newest", true, "No older links."],
    ["oldest", true, "No more links."],
    ["opened", true, "No more links."],
  ] as const)("says an empty %s page (later %s) so", (order, later, text) => {
    const paragraphs = [...dom(space({ order, later })).querySelectorAll("main p")];
    expect(paragraphs.map((p) => p.textContent)).toContain(text);
  });
});

describe("a space's links out of your lists", () => {
  const done = (over: Partial<Parameters<typeof spacePage>[0]> = {}) =>
    space({ done: true, ...over });

  it("is headed so, links back to the space, and pages within the done view", () => {
    const html = done({ links: [link("1", { state: "archived" })], older: "9.1" });
    expect(html).toContain("Out of your lists");
    expect(dom(html).querySelector("title")?.textContent).toContain("Out of your lists in ");
    const back = hrefs(html, "a.back-link").map((h) => new URL(h, ORIGIN));
    expect(back.map((u) => [u.pathname, u.searchParams.get("tag")])).toEqual([
      ["/spaces", "home batteries"],
    ]);
    expect(new URL(hrefs(html, "#older")[0] as string, ORIGIN).pathname).toBe("/spaces/done");
    expect(dom(html).querySelector("a.done-link")).toBeNull();
  });

  it("fades its cards but keeps them, and never asks in amber, even for a missing why", () => {
    const html = done({
      links: [link("1", { state: "archived", why: null, tags: onTag("home batteries") })],
    });
    const card = dom(html).querySelector("#space-links .link-row");
    expect(card?.className).toContain("faded");
    expect(card?.querySelector("h3")?.textContent?.trim()).toBe("Link 1");
    expect(card?.querySelector(".ask, button[data-act=why], form.why-form")).toBeNull();
    expect(card?.querySelector(".row-why")).toBeNull();
    expect(card?.outerHTML).not.toMatch(/amber|needs/);
    expect(html).not.toContain("/home/why");
  });

  it("says when nothing in the space is done, in a card that explains what lands here", () => {
    const card = dom(done()).querySelector(".done-empty");
    expect(card?.querySelector("p:first-child")?.textContent).toBe(
      "Nothing here is out of your lists yet.",
    );
    expect(card?.textContent).toContain(
      "Links you mark stale or put away from this space wait here. Search still finds them.",
    );
    expect(dom(done()).querySelector("#space-links")).toBeNull();
  });

  it("tops the page with Back to the space, in its dot, above an Out of your lists heading with the switch", () => {
    const d = dom(done({ links: [link("1", { state: "archived" })] }));
    expect(
      d.querySelector("header.page-head, .change-link, nav.orders, .search-instead"),
    ).toBeNull();
    const main = d.querySelector("main") as Element;
    const back = main.querySelector("a.back-link") as Element;
    expect(main.firstElementChild).toBe(back);
    expect(back.textContent?.trim()).toBe("Back to Home batteries");
    expect(back.className).toContain("space-teal");
    expect(back.querySelector(".dot")).not.toBeNull();
    const head = d.querySelector("h1");
    expect(head?.textContent).toBe("Out of your lists");
    expect(head?.parentElement?.querySelector(".view-switch")).not.toBeNull();
    expect(d.querySelectorAll("h1")).toHaveLength(1);
  });

  it("keeps the card and the switch on a first page that has links, for the theme to hide", () => {
    const d = dom(done({ links: [link("1", { state: "archived" })], older: "9.1" }));
    expect(d.querySelector(".done-empty")).not.toBeNull();
    expect(d.querySelector(".view-switch")).not.toBeNull();
  });

  it("gives a later page no card, only that no older links are left", () => {
    const d = dom(done({ later: true }));
    expect(d.querySelector(".done-empty")).toBeNull();
    expect(d.querySelector("main")?.textContent).toContain("No older links.");
    expect(d.querySelector("main")?.textContent).not.toContain("Nothing here is out of your lists");
  });

  it("shows the card, and hides the switch, only while no row is shown and no older link waits", () => {
    const rule = (selector: string) =>
      themeCss.split("}").find((r) => r.includes(selector) && r.includes("display:"));
    const empty = ":not(:has(#space-links [data-id]:not([hidden]))):not(:has(#older))";
    expect(rule(".done-empty{")).toMatch(/display:none/);
    expect(rule(`${empty} .done-empty`)).toMatch(/display:block/);
    expect(rule(`${empty} .done-head .view-switch`)).toMatch(/display:none/);
  });
});

/** The space page's own script run in linkedom, with `fetch` and `location` stubbed. */
async function clickOlder(
  html: string,
  answer: { ok: boolean; redirected: boolean; text: string },
) {
  const { document, DOMParser } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => !s.includes("sign-out"))
    .join("\n");
  const location = { href: `${ORIGIN}/spaces?tag=x` };
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    return { ok: answer.ok, redirected: answer.redirected, text: async () => answer.text };
  };
  new Function("document", "fetch", "location", "DOMParser", code)(
    document,
    fetch,
    location,
    DOMParser,
  );
  const older = document.getElementById("older");
  let prevented = false;
  older?.dispatchEvent(
    Object.assign(
      new (document.defaultView as unknown as typeof globalThis).Event("click", {
        cancelable: true,
      }),
      {
        preventDefault: () => {
          prevented = true;
        },
      },
    ),
  );
  // The script's fetch, text() and DOM work are all microtasks: two macrotask turns settle them.
  for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return { document, location, asked, prevented };
}

describe("Tell me why on a space card", () => {
  type Sent = { url: string; body: unknown; redirect: unknown };
  async function answerWhy(html: string, reply: { status: number; body?: unknown }, text: string) {
    const { document } = parseHTML(html);
    const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1] ?? "")
      .filter((s) => !s.includes("sign-out"))
      .join("\n");
    const sent: Sent[] = [];
    const fetch = async (url: string, init: { body: string; redirect?: string }) => {
      sent.push({ url, body: JSON.parse(init.body), redirect: init.redirect });
      return { status: reply.status, json: async () => reply.body };
    };
    new Function("document", "fetch", code)(document, fetch);
    const win = document.defaultView as unknown as typeof globalThis;
    const fire = (el: Element | null, type: string) =>
      el?.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
    fire(document.querySelector("button[data-act=why]"), "click");
    const form = document.querySelector("form.why-form") as HTMLFormElement;
    const opened = !form.hidden;
    (form.querySelector("input") as HTMLInputElement).value = text;
    fire(form, "submit");
    for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    return { document, sent, opened };
  }
  const page = () => space({ links: [link("7", { why: null }), link("8")] });

  it("opens the field, posts /home/why, and replaces the question with the answer", async () => {
    const r = await answerWhy(page(), { status: 204 }, "  for the <attic>  ");
    expect(r.opened).toBe(true);
    expect(r.sent).toEqual([
      { url: "/home/why", body: { id: "7", text: "  for the <attic>  " }, redirect: "manual" },
    ]);
    const card = r.document.querySelector('[data-id="7"]') as HTMLElement;
    expect(card.querySelector(".ask")).toBeNull();
    const why = card.querySelector(".row-why") as HTMLElement;
    expect(why.hidden).toBe(false);
    expect(why.textContent).toBe('"for the <attic>"');
  });

  it("removes the row's summary when the answer shows the why", async () => {
    const withSummary = space({
      links: [link("7", { why: null, summary: "About seven" }), link("8")],
    });
    expect(
      parseHTML(withSummary).document.querySelector('[data-id="7"] .row-about'),
    ).not.toBeNull();
    const r = await answerWhy(withSummary, { status: 204 }, "for the attic");
    const card = r.document.querySelector('[data-id="7"]') as HTMLElement;
    expect(card.querySelector(".row-about")).toBeNull();
    expect(card.querySelector(".row-why")?.textContent).toBe('"for the attic"');
  });

  it("keeps the summary when the answer is refused", async () => {
    const withSummary = space({ links: [link("7", { why: null, summary: "About seven" })] });
    const r = await answerWhy(withSummary, { status: 409, body: { message: "no" } }, "x");
    expect(r.document.querySelector('[data-id="7"] .row-about')?.textContent).toBe("About seven");
  });

  it("shows the refusal's words on a 409 and keeps the question", async () => {
    const message = "This link already has a reason. Reload.";
    const r = await answerWhy(page(), { status: 409, body: { code: "conflict", message } }, "x");
    expect(r.document.querySelector("[role=alert]")?.textContent).toBe(message);
    expect(r.document.querySelector('[data-id="7"] .ask')).not.toBeNull();
  });
});

describe("Show older links", () => {
  const first = space({ links: [link("3"), link("2")], older: "2.2" });
  const next = space({ links: [link("1")], older: null });

  it("appends the next page's cards and drops the button when no older links are left", async () => {
    const r = await clickOlder(first, { ok: true, redirected: false, text: next });
    expect(r.prevented).toBe(true);
    expect(new URL(r.asked[0] as string, ORIGIN).searchParams.get("before")).toBe("2.2");
    const titles = [...r.document.querySelectorAll("#space-links .link-row h3")].map((h) =>
      h.textContent?.trim(),
    );
    expect(titles).toEqual(["Link 3", "Link 2", "Link 1"]);
    expect(r.document.getElementById("older")).toBeNull();
    expect(r.location.href).toBe(`${ORIGIN}/spaces?tag=x`);
  });

  it("lets an appended card answer Tell me why", async () => {
    const page = space({ links: [link("3")], older: "3.3" });
    const later = space({ links: [link("1", { why: null })], older: null, later: true });
    const { document, DOMParser } = parseHTML(page);
    const code = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1] ?? "")
      .filter((s) => !s.includes("sign-out"))
      .join("\n");
    const posted: string[] = [];
    const fetch = async (url: string) => {
      if (url === "/home/why") {
        posted.push(url);
        return { status: 204 };
      }
      return { ok: true, redirected: false, text: async () => later };
    };
    new Function("document", "fetch", "location", "DOMParser", code)(
      document,
      fetch,
      { href: `${ORIGIN}/spaces?tag=x` },
      DOMParser,
    );
    const win = document.defaultView as unknown as typeof globalThis;
    const fire = (el: Element | null, type: string) =>
      el?.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
    const settle = async () => {
      for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    fire(document.getElementById("older"), "click");
    await settle();
    const card = document.querySelector('#space-links [data-id="1"]') as HTMLElement;
    fire(card.querySelector("button[data-act=why]"), "click");
    (card.querySelector("form.why-form input") as HTMLInputElement).value = "for the shed";
    fire(card.querySelector("form.why-form"), "submit");
    await settle();
    expect(posted).toEqual(["/home/why"]);
    expect(card.querySelector(".ask")).toBeNull();
    expect(card.querySelector(".row-why[data-why-answer]")?.textContent).toBe('"for the shed"');
  });

  it("moves the button on to the page after when there are more", async () => {
    const more = space({ links: [link("1")], older: "1.1" });
    const r = await clickOlder(first, { ok: true, redirected: false, text: more });
    const href = r.document.getElementById("older")?.getAttribute("href") as string;
    expect(new URL(href, ORIGIN).searchParams.get("before")).toBe("1.1");
  });

  it("drops the button and stays put when the older links were all moved away meanwhile", async () => {
    const empty = space({ links: [], older: null, later: true });
    const r = await clickOlder(first, { ok: true, redirected: false, text: empty });
    expect(r.location.href).toBe(`${ORIGIN}/spaces?tag=x`);
    expect(r.document.getElementById("older")).toBeNull();
    expect(r.document.querySelectorAll("#space-links .link-row")).toHaveLength(2);
  });

  it.each([
    ["was redirected, as when the session ended", { ok: true, redirected: true }],
    ["failed", { ok: false, redirected: false }],
  ])("navigates to the next page when the request %s", async (_, answer) => {
    const r = await clickOlder(first, { ...answer, text: next });
    expect(r.location.href).toBe(r.asked[0]);
    expect(r.document.querySelectorAll("#space-links .link-row")).toHaveLength(2);
  });
});

describe("the list roots the edit dialog reads the space from", () => {
  const root = (html: string, id: string) => dom(html).getElementById(id);
  it("marks a space page's list with its tag key and as its own, done or not", () => {
    for (const done of [false, true]) {
      const html = space({ links: [link("1")], done });
      const list = root(html, "space-links");
      expect(list?.getAttribute("data-within"), `done ${done}`).toBe(HOME.key);
      expect(list?.getAttribute("data-own"), `done ${done}`).toBe("1");
    }
  });

  it("marks a search within a space with its key, not as the space's own, and an open search with neither", () => {
    const scoped = searchPage({
      query: "q",
      links: [link("1")],
      now: NOW,
      catalog: [HOME],
      space: HOME,
    });
    expect(root(scoped, "results")?.getAttribute("data-within")).toBe(HOME.key);
    expect(root(scoped, "results")?.hasAttribute("data-own")).toBe(false);
    const open = searchPage({ query: "q", links: [link("1")], now: NOW, catalog: [HOME] });
    expect(root(open, "results")?.hasAttribute("data-within")).toBe(false);
  });
});

describe("the search page's space line", () => {
  it("names the link's space in its color, and tints a tile with no image", () => {
    const html = searchPage({
      query: "q",
      links: [link("1", { tags: onTag("home batteries") }), link("2")],
      now: NOW,
      catalog: [HOME],
    });
    const [first, second] = [...dom(html).querySelectorAll(".result")];
    expect(first?.className).toContain("space-teal");
    expect(lineParts(first)).toEqual(["Home batteries", "ex.com", "saved October 1"]);
    expect(first?.querySelector(".card-line .line-space .dot")).not.toBeNull();
    expect(second?.className).not.toMatch(/space-/);
    expect(lineParts(second)).toEqual(["ex.com", "saved October 1"]);
  });
});

describe("the Tags page's links to spaces", () => {
  it("links each tag's name to its space page, whatever the key", () => {
    const html = tagsPage({ tags: [tag({ key: ODD_KEY, name: "C++ & Ü" }), HOME] });
    const names = [...dom(html).querySelectorAll("a.tag-name")];
    expect(names.map((a) => a.textContent)).toEqual(["C++ & Ü", "Home batteries"]);
    expect(names.map((a) => tagOf(a.getAttribute("href") as string))).toEqual([
      ODD_KEY,
      "home batteries",
    ]);
  });
});

describe("openings on a space page (#124)", () => {
  const web = [link("3"), link("2")];
  const shown = [...web, link("1", { url: "notes:kept" })];
  describe("its active links", () => {
    itRecordsOpenings(() => space({ links: shown }), web, "/links/opened");
  });
  describe("its links out of your lists", () => {
    itRecordsOpenings(() => space({ links: shown, done: true }), web, "/links/opened");
  });
  describe("a put-away link opened on Out of your lists", () => {
    const put = link("1", { state: "archived", putAwayAt: new Date("2026-10-01T00:00:00Z") });
    const stale = link("2", { state: "archived" });
    const html = () => space({ links: [put, stale], done: true });
    it("leaves the page once the opening is recorded; a stale row stays", async () => {
      const page = runPage(html());
      page.dispatch(page.$("[data-id='2'] a[data-open]"), "click");
      page.dispatch(page.$("[data-id='1'] a[data-open]"), "click");
      await page.settle();
      expect(page.sent.map((s) => s.body)).toEqual([{ id: "2" }, { id: "1" }]);
      expect(page.$("[data-id='1']").hidden).toBe(true);
      expect(page.$("[data-id='2']").hidden).toBeFalsy();
    });
    it("stays when the opening is refused", async () => {
      const page = runPage(html(), () => ({ status: 500 }));
      page.dispatch(page.$("[data-id='1'] a[data-open]"), "click");
      await page.settle();
      expect(page.sent).toHaveLength(1);
      expect(page.$("[data-id='1']").hidden).toBeFalsy();
    });
  });
  it("records a link Show older links appended", async () => {
    const first = space({ links: [link("3")], older: "3.3" });
    const next = space({ links: [link("1")], older: null, later: true });
    expect(await openAppended(first, next, "1")).toEqual([
      { url: "/links/opened", body: { id: "1" }, redirect: "manual", keepalive: true },
    ]);
  });
});

describe("Remove saved copy on a space page", () => {
  it("is on the cards in `copies` only, and the page script posts remove and restore", () => {
    const html = space({
      links: [link("1"), link("2")],
      copies: new Map([["1", { madeAt: new Date(0) }]]),
    });
    const d = dom(html);
    expect(d.querySelectorAll('[data-id="1"] button[data-act=remove-copy]')).toHaveLength(1);
    expect(d.querySelectorAll('[data-id="2"] button[data-act=remove-copy]')).toHaveLength(0);
    expect(html).toContain('"/links/copy/remove"');
    expect(html).toContain('"/links/copy/restore"');
  });
});

describe("Keep handy on a space page", () => {
  const kept = { status: "kept", source: "stated", due: false } as const;
  it("gives each active card's menu Keep handy or Not handy anymore, and the done view neither but the Undo bar", () => {
    const html = space({ links: [link("1"), link("2")], handy: new Map([["2", kept]]) });
    const d = dom(html);
    const row = (id: string, act: string) =>
      d.querySelector(`[data-id="${id}"] .card-menu button[data-act=${act}]`) as HTMLElement;
    expect([row("1", "keep").hidden, row("1", "not-handy").hidden]).toEqual([false, true]);
    expect([row("2", "keep").hidden, row("2", "not-handy").hidden]).toEqual([true, false]);
    expect(html).toContain('id="undo-bar"');
    expect(html.match(/const post = /g)).toHaveLength(1);
    const done = space({ links: [link("1", { state: "archived" })], done: true });
    expect(
      dom(done).querySelector("[data-act=keep], [data-act=not-handy], [data-handy]"),
    ).toBeNull();
    expect(done).toContain('id="undo-bar"');
  });
});

describe("the space card's picture", () => {
  it.each([
    ["cover", { version: "v1", fit: "cover" }, "img.row-pic"],
    ["contain", { version: "v1", fit: "contain" }, "div.row-pic.icon-box > img.site-icon"],
    ["none", undefined, "div.row-pic.initials-box > span.pic-initials"],
  ] as const)("renders %s, on the done page too", (_, picture, selector) => {
    for (const done of [false, true]) {
      const html = space({
        done,
        links: [link("1", { state: done ? "archived" : "active" })],
        images: new Map(picture ? [["1", picture]] : []),
      });
      expect(dom(html).querySelector(`#space-links ${selector}`), `done ${done}`).not.toBeNull();
    }
  });

  it("fades a done link's picture, by the theme's own fade rule", () => {
    const html = space({ done: true, links: [link("1", { state: "archived" })] });
    const fade = /([^{}]+)\{opacity:\.4\}/.exec(themeCss.slice(themeCss.indexOf(".faded")))?.[1];
    const faded = dom(html).querySelectorAll(fade as string);
    expect([...faded].map((e) => e.getAttribute("class"))).toEqual(["row-pic initials-box"]);
  });
});

describe("Bring it back and the markers on a space's Out of your lists", () => {
  const CHANGE = {
    before: { state: "archived", putAwayAt: "2026-10-01T00:00:00.000Z", snoozedUntil: null },
    after: { state: "active", putAwayAt: null },
  };
  const stale = (id: string) => link(id, { state: "archived" });
  const put = (id: string) =>
    link(id, { state: "archived", putAwayAt: new Date("2026-10-01T00:00:00Z") });
  const back = (id: string) => `[data-id='${id}'] .card-menu button[data-act=bring-back]`;
  const sentPosts = (p: ReturnType<typeof runPage>) => p.sent.filter((s) => s.body !== undefined);
  const answer = (next: string) => (s: { url: string; body: unknown }) =>
    s.body === undefined
      ? { status: 200, text: next }
      : s.url === "/home/bring-back"
        ? { status: 200, body: CHANGE }
        : { status: 204 };

  it("ends each grey line with Put away or Stale", () => {
    const html = space({ done: true, links: [put("1"), stale("2")] });
    const lines = [...dom(html).querySelectorAll(".link-row .card-line")].map(
      (l) => l.lastElementChild?.textContent,
    );
    expect(lines).toEqual(["Put away", "Stale"]);
  });

  it("puts no marker on an active row", () => {
    const html = space({ links: [link("1")] });
    expect(dom(html).querySelector(".link-row .card-line")?.textContent).not.toMatch(
      /Put away|Stale/,
    );
  });

  it.each([
    ["a row drawn at load", false],
    ["a row Show older links appended", true],
  ])(
    "posts /home/bring-back for %s, takes the row out and Undo sends the change back",
    async (_, appended) => {
      const first = space({ done: true, links: [put("1")], older: appended ? "c1" : null });
      const next = space({ done: true, links: [put("9")], later: true });
      const p = runPage(first, answer(next));
      if (appended) {
        p.dispatch(p.$("#older"), "click");
        await p.settle();
      }
      const id = appended ? "9" : "1";
      p.dispatch(p.$(back(id)), "click");
      await p.settle();
      expect(sentPosts(p)).toEqual([
        { url: "/home/bring-back", body: { id }, redirect: "manual", keepalive: undefined },
      ]);
      expect(p.$(`[data-id='${id}']`).hidden).toBe(true);
      expect(p.$("#undo-bar span").textContent?.trim()).toBe("Back in your lists.");
      p.dispatch(p.$("#undo-bar button"), "click");
      await p.settle();
      expect(sentPosts(p).at(-1)).toEqual({
        url: "/home/undo-state",
        body: { id, change: CHANGE },
        redirect: "manual",
        keepalive: undefined,
      });
      expect(p.$(`[data-id='${id}']`).hidden).toBe(false);
    },
  );
});
