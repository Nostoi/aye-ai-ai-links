import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { MAX_COPY_BYTES } from "../core/saved-copy.js";
import type { LinkOrder } from "../core/search.js";
import type { Link, Tag } from "../core/types.js";
import { allHref, allPage } from "./all-page.js";
import { itRecordsOpenings, openAppended, runPage } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { themeCss } from "./theme.js";

const ORIGIN = "https://links.example";
const NOW = new Date("2026-10-14T12:00:00Z");

const KITCHEN: Tag = {
  key: "kitchen",
  name: "Kitchen",
  kind: "topic",
  kindSource: "stated",
  color: "clay",
  pinned: true,
  description: null,
  projectStatus: null,
};

const link = (id: string, over: Partial<Link> = {}): Link => ({
  id,
  url: `https://site${id}.example/page`,
  urlKey: `site${id}.example/page`,
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

const inKitchen = [
  {
    key: "kitchen",
    name: "Kitchen",
    source: "stated" as const,
    kind: "topic" as const,
    kindSource: "stated" as const,
  },
];

type Input = Parameters<typeof allPage>[0];
const all = (over: Partial<Input> = {}) =>
  allPage({
    order: "newest",
    links: [],
    older: null,
    catalog: [KITCHEN],
    images: new Map(),
    handy: new Map(),
    now: NOW,
    done: false,
    ...over,
  });

const dom = (html: string) => parseHTML(html).document;
const texts = (html: string, selector: string) =>
  [...dom(html).querySelectorAll(selector)].map((e) => e.textContent?.trim());

describe("allHref", () => {
  it("names the order (newest is the plain address), the done view and a cursor", () => {
    expect(allHref("newest")).toBe("/all");
    expect(allHref("oldest", { done: true })).toBe("/all/done?order=oldest");
    const url = new URL(allHref("opened", { before: "r5.1&x" }), ORIGIN);
    expect(url.pathname).toBe("/all");
    expect(url.searchParams.get("order")).toBe("opened");
    expect(url.searchParams.get("before")).toBe("r5.1&x");
  });
});

describe("the All links page", () => {
  it("groups cards by the UTC month they were saved, adding the year when it is not this one", () => {
    const html = all({
      links: [
        link("1", { savedAt: new Date("2026-10-01T00:00:00Z") }),
        link("2", { savedAt: new Date("2026-09-30T23:59:59Z") }),
        link("3", { savedAt: new Date("2026-09-01T00:00:00Z") }),
        link("4", { savedAt: new Date("2025-12-31T23:59:59Z") }),
      ],
    });
    const sections = [...dom(html).querySelectorAll("#all-links > section")];
    expect(sections.map((s) => s.getAttribute("data-month"))).toEqual([
      "2026-10",
      "2026-09",
      "2025-12",
    ]);
    expect(texts(html, "#all-links > section > h2")).toEqual([
      "October",
      "September",
      "December 2025",
    ]);
    expect(sections.map((s) => s.querySelectorAll("li").length)).toEqual([1, 2, 1]);
  });

  it("groups recently opened links by the month they were opened", () => {
    const html = all({
      order: "opened",
      links: [
        link("1", {
          savedAt: new Date("2025-01-05T00:00:00Z"),
          lastOpenedAt: new Date("2026-10-02T00:00:00Z"),
        }),
      ],
    });
    expect(dom(html).querySelector("section")?.getAttribute("data-month")).toBe("2026-10");
    expect(texts(html, "section > h2")).toEqual(["Opened in October"]);
  });

  it("shows a neutral row for an untagged link, a colored one for a pinned tag, with the why and the site, and never a count", () => {
    const html = all({
      links: [
        link("1"),
        link("2", { tags: inKitchen, url: "https://kitchen.example/x", why: null }),
      ],
    });
    const [plain, colored] = [...dom(html).querySelectorAll(".link-row")];
    expect(plain?.querySelector(".row-why")?.textContent).toBe('"because 1"');
    expect(colored?.querySelector(".row-why")).toBeNull();
    expect(plain?.className).not.toMatch(/space-/);
    expect(plain?.querySelector(".line-space:not([hidden]) .dot")).toBeNull();
    const parts = (card: Element | undefined) =>
      [...(card?.querySelectorAll(".card-line > :not([hidden])") ?? [])].map((e) => e.textContent);
    expect(parts(plain)).toEqual(["site1.example"]);
    expect(colored?.className).toContain("space-clay");
    expect(parts(colored)).toEqual(["Kitchen", "kitchen.example"]);
    const title = colored?.querySelector("h3 a");
    expect(title?.getAttribute("href")).toBe("https://kitchen.example/x");
    expect(title?.getAttribute("target")).toBe("_blank");
    expect(title?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(html).not.toContain("Tell me why");
    expect(dom(html).querySelector("main")?.textContent).not.toMatch(/\d+ links?\b/);
    expect(outsideRefs(html)).toEqual([]);
  });

  it("shows a stored image from this site, and a plain tile otherwise", () => {
    const html = all({
      links: [link("1"), link("2")],
      images: new Map([["1", { version: "v9", fit: "cover" }]]),
    });
    const [withImage, without] = [...dom(html).querySelectorAll(".link-row")];
    expect(withImage?.querySelector("img")?.getAttribute("src")).toBe("/images/1?v=v9");
    expect(without?.querySelector("img")).toBeNull();
  });

  it("fades the cards on the done page, which links back in the same order", () => {
    const html = all({ done: true, order: "oldest", links: [link("1", { state: "archived" })] });
    expect(dom(html).querySelector(".link-row")?.className).toContain("faded");
    expect(texts(html, "h1")).toEqual(["Out of your lists"]);
    expect(dom(html).querySelector("title")?.textContent).toBe(
      "Out of your lists · All links · Aye-AI-AI Links",
    );
    expect(dom(html).querySelector("a.back-link")?.getAttribute("href")).toBe("/all?order=oldest");
    expect(dom(html).querySelector("a.done-link")).toBeNull();
  });

  it.each<[LinkOrder, string]>([
    ["newest", "Show older links"],
    ["oldest", "Show more links"],
    ["opened", "Show more links"],
  ])("marks %s as the current order and labels the button %j", (order, label) => {
    const html = all({ order, links: [link("1")], older: "c1" });
    const choices = [...dom(html).querySelectorAll("nav.orders a")];
    expect(choices.map((a) => a.textContent)).toEqual([
      "Newest first",
      "Oldest first",
      "Recently opened",
    ]);
    expect(choices.map((a) => a.getAttribute("href"))).toEqual([
      "/all",
      "/all?order=oldest",
      "/all?order=opened",
    ]);
    expect(
      choices.filter((a) => a.getAttribute("aria-current") === "true").map((a) => a.textContent),
    ).toEqual([choices[["newest", "oldest", "opened"].indexOf(order)]?.textContent]);
    const older = dom(html).getElementById("older");
    expect(older?.textContent).toBe(label);
    expect(older?.getAttribute("href")).toBe(allHref(order, { before: "c1" }));
    expect(dom(html).querySelector("a.done-link")?.getAttribute("href")).toBe(
      allHref(order, { done: true }),
    );
  });

  it("keeps the done view in the order chooser's links", () => {
    const html = all({ done: true, order: "opened" });
    expect(
      [...dom(html).querySelectorAll("nav.orders a")].map((a) => a.getAttribute("href")),
    ).toEqual(["/all/done", "/all/done?order=oldest", "/all/done?order=opened"]);
  });

  it.each([
    ["/all", false],
    ["/all/done", true],
  ] as const)("gives the phone a select to %s in each order (#218)", (action, done) => {
    for (const order of ["newest", "oldest", "opened"] as const) {
      const html = all({ done, order, links: [link("1")] });
      const form = dom(html).querySelector("form.order-select");
      expect(form?.getAttribute("action")).toBe(action);
      expect(form?.querySelectorAll("input")).toHaveLength(0);
      const options = [...(form?.querySelectorAll("option") ?? [])];
      expect(options.map((o) => o.getAttribute("value"))).toEqual(["", "oldest", "opened"]);
      expect(options.filter((o) => o.hasAttribute("selected")).map((o) => o.textContent)).toEqual([
        { newest: "Newest first", oldest: "Oldest first", opened: "Recently opened" }[order],
      ]);
      expect(html).toContain('querySelector("form.order-select")');
    }
  });

  it("shows the phone the select in place of the text choices (#218)", () => {
    const phone = themeCss.slice(themeCss.indexOf("@media (max-width:600px)"));
    expect(phone).toMatch(/\.all>\.orders\{display:none\}/);
    expect(phone).toMatch(/\.order-select\{display:block\}/);
    expect(phone).toMatch(/\.all-tools\{display:grid;/);
    expect(phone).toMatch(/\.all-tools \.search-instead\{grid-column:1\/-1;/);
  });

  it("offers Search instead, and puts All links first in the menu", () => {
    const html = all();
    expect(dom(html).querySelector("a.search-instead")?.getAttribute("href")).toBe("/search");
    expect(texts(html, "nav.menu a")[0]).toBe("All links");
  });

  it.each([
    [{}, "No links yet."],
    [{ order: "opened" as const }, "Nothing opened yet. Links you open from this site show here."],
    [{ done: true }, "Nothing here is out of your lists yet."],
    [
      { done: true, order: "opened" as const },
      "You haven't opened any of the links out of your lists.",
    ],
    [{ later: true }, "No older links."],
    [{ later: true, order: "oldest" as const }, "No more links."],
  ])("says so when there is nothing to show (%j)", (over, words) => {
    const html = all(over);
    expect(html).toContain(words);
    expect(dom(html).getElementById("all-links")).toBeNull();
    expect(dom(html).getElementById("older")).toBeNull();
  });
});

/** The page's own script run in linkedom, with `fetch` and `location` stubbed. */
async function clickOlder(html: string, answer: string) {
  const { document, DOMParser } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => !s.includes("sign-out"))
    .join("\n");
  const location = { href: `${ORIGIN}/all` };
  const fetch = async () => ({ ok: true, redirected: false, text: async () => answer });
  new Function("document", "fetch", "location", "DOMParser", code)(
    document,
    fetch,
    location,
    DOMParser,
  );
  const win = document.defaultView as unknown as typeof globalThis;
  document.getElementById("older")?.dispatchEvent(new win.Event("click", { cancelable: true }));
  for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return document;
}

describe("Show older links on All links", () => {
  it("joins the next page's first month to the last one shown, by its UTC month, across a new year", async () => {
    const december = (id: string, day: number) =>
      link(id, { savedAt: new Date(Date.UTC(2026, 11, day, 23, 59)) });
    // The first page was drawn on New Year's Eve, the second a minute into 2027.
    const first = all({
      links: [december("3", 31), december("2", 30)],
      older: "c2",
      now: new Date("2026-12-31T23:59:00Z"),
    });
    const second = all({
      links: [december("1", 2), link("0", { savedAt: new Date("2026-11-05T00:00:00Z") })],
      older: null,
      later: true,
      now: new Date("2027-01-01T00:01:00Z"),
    });
    expect(texts(first, "section > h2")).toEqual(["December"]);
    expect(texts(second, "section > h2")).toEqual(["December 2026", "November 2026"]);
    const document = await clickOlder(first, second);
    const sections = [...document.querySelectorAll("#all-links > section")];
    expect(sections.map((s) => s.getAttribute("data-month"))).toEqual(["2026-12", "2026-11"]);
    expect(sections.map((s) => s.querySelector("h2")?.textContent)).toEqual([
      "December",
      "November 2026",
    ]);
    expect(
      [...document.querySelectorAll("#all-links h3")].map((h) => h.textContent?.trim()),
    ).toEqual(["Link 3", "Link 2", "Link 1", "Link 0"]);
    expect(document.getElementById("older")).toBeNull();
  });
});

describe("openings on All links (#124)", () => {
  const web = [link("3"), link("2")];
  const shown = [...web, link("1", { url: "notes:kept" })];
  describe("its active links", () => {
    itRecordsOpenings(() => all({ links: shown }), web, "/links/opened");
  });
  describe("its links out of your lists", () => {
    itRecordsOpenings(() => all({ links: shown, done: true }), web, "/links/opened");
  });
  describe("a put-away link opened on Out of your lists", () => {
    const put = link("1", { state: "archived", putAwayAt: new Date("2026-10-01T00:00:00Z") });
    const stale = link("2", { state: "archived" });
    const html = () => all({ links: [put, stale], done: true });
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
    const first = all({ links: [link("3")], older: "c3" });
    const next = all({ links: [link("1")], older: null, later: true });
    expect(await openAppended(first, next, "1")).toEqual([
      { url: "/links/opened", body: { id: "1" }, redirect: "manual", keepalive: true },
    ]);
  });
});

describe("Keep handy on All links", () => {
  const kept = { status: "kept", source: "stated", due: false } as const;
  it("gives each active card's menu Keep handy and kept ones Not handy anymore; the done view has neither", () => {
    const html = all({ links: [link("1"), link("2")], handy: new Map([["2", kept]]) });
    const d = dom(html);
    const row = (id: string, act: string) =>
      d.querySelector(`[data-id="${id}"] .card-menu button[data-act=${act}]`) as HTMLElement;
    expect([row("1", "keep").hidden, row("1", "not-handy").hidden]).toEqual([false, true]);
    expect([row("2", "keep").hidden, row("2", "not-handy").hidden]).toEqual([true, false]);
    const done = all({ links: [link("1", { state: "archived" })], done: true });
    expect(
      dom(done).querySelector("[data-act=keep], [data-act=not-handy], [data-handy]"),
    ).toBeNull();
    expect(done).toContain('id="undo-bar"');
  });

  it("works the control on a card Show older links appended", async () => {
    const first = all({ links: [link("2")], older: "r1" });
    const next = all({ links: [link("1")], later: true });
    const p = runPage(first, (s) =>
      s.body === undefined
        ? { status: 200, text: next }
        : { status: 200, body: { tool: {}, previous: null } },
    );
    p.dispatch(p.$("#older"), "click");
    await p.settle();
    p.dispatch(p.$('[data-id="1"] button[data-act=keep]'), "click");
    await p.settle();
    expect(p.sent.filter((s) => s.body !== undefined)).toEqual([
      { url: "/tools/keep", body: { id: "1" }, redirect: "manual", keepalive: undefined },
    ]);
  });
});

describe("the saved-copy usage line", () => {
  const GIB = 1024 ** 3;
  const FULL =
    "Saved copies are almost full, so new links may not get one. Raise AYE_SAVED_COPY_LIMIT_GB or remove some copies.";
  const notice = (html: string) => dom(html).querySelector(".all-foot .copy-notice");

  it("says how much of the limit a high level uses, with no needs-you mark", () => {
    const el = notice(all({ notice: { kind: "high", usedBytes: 1.5 * GIB, limitBytes: 2 * GIB } }));
    expect(el?.textContent?.trim()).toBe("Saved copies use 1.5 of 2 GiB.");
    expect(el?.getAttribute("class")).not.toContain("needs-you");
  });

  it("rounds the used amount down, so a high level never reads as the whole limit", () => {
    const el = notice(all({ notice: { kind: "high", usedBytes: 0.96 * GIB, limitBytes: GIB } }));
    expect(el?.textContent?.trim()).toBe("Saved copies use 0.9 of 1 GiB.");
  });

  it("shows exact tenths as set, such as a 1.3 GiB limit", () => {
    const el = notice(
      all({
        notice: {
          kind: "high",
          usedBytes: Math.floor(1.2 * GIB),
          limitBytes: Math.floor(1.3 * GIB),
        },
      }),
    );
    expect(el?.textContent?.trim()).toBe("Saved copies use 1.2 of 1.3 GiB.");
  });

  it("shows a limit that isn't a tenth to two decimals, so the most a high level uses still reads below it", () => {
    const limitBytes = Math.floor(1.25 * GIB);
    const el = notice(
      all({ notice: { kind: "high", usedBytes: limitBytes - MAX_COPY_BYTES, limitBytes } }),
    );
    expect(el?.textContent?.trim()).toBe("Saved copies use 1.23 of 1.25 GiB.");
  });

  it("says full and paused in amber", () => {
    const full = notice(all({ notice: { kind: "full" } }));
    expect(full?.textContent?.trim()).toBe(FULL);
    expect(full?.getAttribute("class")).toContain("needs-you");
    const paused = notice(all({ notice: { kind: "paused" } }));
    expect(paused?.textContent?.trim()).toBe(
      "Saved copies are paused: the server can't write to its folder.",
    );
    expect(paused?.getAttribute("class")).toContain("needs-you");
  });

  it("shows nothing without a notice, on the done view or on a later page", () => {
    expect(notice(all({ notice: null }))).toBeNull();
    expect(notice(all())).toBeNull();
    expect(notice(all({ notice: { kind: "full" }, done: true }))).toBeNull();
    expect(notice(all({ notice: { kind: "full" }, later: true }))).toBeNull();
  });

  it("runs the Remove saved copy script on the card list", () => {
    expect(all()).toContain("/links/copy/remove");
  });
});

describe("the All links row's picture", () => {
  it.each([
    ["cover", { version: "v1", fit: "cover" }, "img.row-pic"],
    ["contain", { version: "v1", fit: "contain" }, "div.row-pic.icon-box > img.site-icon"],
    ["none", undefined, "div.row-pic.initials-box > span.pic-initials"],
  ] as const)("renders %s, on the done page too", (_, picture, selector) => {
    for (const done of [false, true]) {
      const html = all({
        done,
        links: [link("1", { state: done ? "archived" : "active" })],
        images: new Map(picture ? [["1", picture]] : []),
      });
      expect(dom(html).querySelector(`.link-row ${selector}`), `done ${done}`).not.toBeNull();
    }
  });

  it.each(["list", "pictures"] as const)(
    "fades a done link's picture in the %s view, by the theme's own fade rule",
    (view) => {
      const html = all({ done: true, view, links: [link("1", { state: "archived" })] });
      const fade = /([^{}]+)\{opacity:\.4\}/.exec(themeCss.slice(themeCss.indexOf(".faded")))?.[1];
      expect(fade).toBeDefined();
      const faded = dom(html).querySelectorAll(fade as string);
      expect([...faded].map((e) => e.getAttribute("class"))).toEqual(["row-pic initials-box"]);
      expect(dom(html).querySelector("main")?.getAttribute("data-view")).toBe(view);
    },
  );
});

describe("the List / Pictures switch on All links", () => {
  it.each(["list", "pictures"] as const)("draws the page in the %s view it is given", (view) => {
    for (const done of [false, true]) {
      const d = dom(all({ view, done, links: [link("1")] }));
      expect(d.querySelector("main")?.getAttribute("data-view")).toBe(view);
      expect(
        d.querySelector(`.view-switch [data-choice=${view}]`)?.getAttribute("aria-pressed"),
      ).toBe("true");
    }
  });

  it("shows the switch on an empty page too, and draws the list without a view given", () => {
    const d = dom(all());
    expect(d.querySelector("main")?.getAttribute("data-view")).toBe("list");
    expect(d.querySelector(".view-switch")).not.toBeNull();
    expect(d.querySelector("#all-links")).toBeNull();
  });

  it("keeps the view of rows that Show older links appended", async () => {
    const first = all({ view: "pictures", links: [link("2")], older: "2.2" });
    const next = all({ view: "pictures", links: [link("1")], later: true });
    const p = runPage(first, () => ({ status: 200, text: next }));
    p.dispatch(p.$("[data-choice=list]"), "click");
    p.dispatch(p.$("#older"), "click");
    await p.settle();
    expect(p.document.querySelectorAll("#all-links > section")).toHaveLength(1);
    expect(p.document.querySelectorAll("#all-links .link-row")).toHaveLength(2);
    expect(p.$("main").getAttribute("data-view")).toBe("list");
  });
});

describe("Bring it back and the markers on Out of your lists", () => {
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
    const html = all({ done: true, links: [put("1"), stale("2")] });
    const lines = [...dom(html).querySelectorAll(".link-row .card-line")].map(
      (l) => l.lastElementChild?.textContent,
    );
    expect(lines).toEqual(["Put away", "Stale"]);
  });

  it("puts no marker on an active row", () => {
    const html = all({ links: [link("1")] });
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
      const first = all({ done: true, links: [put("1")], older: appended ? "c1" : null });
      const next = all({ done: true, links: [put("9")], later: true });
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
