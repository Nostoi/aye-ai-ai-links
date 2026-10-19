import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { LinkOrder } from "../core/search.js";
import type { Link, Tag } from "../core/types.js";
import { allHref, allPage } from "./all-page.js";
import { itRecordsOpenings, openAppended, runPage } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";

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
  why: { text: `because ${id}`, source: "stated" },
  tags: [],
  savedAt: new Date("2026-10-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
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

  it("shows a neutral card for an untagged link, a colored one for a pinned tag, with the site, and never a why or a count", () => {
    const html = all({
      links: [link("1"), link("2", { tags: inKitchen, url: "https://kitchen.example/x" })],
    });
    const [plain, colored] = [...dom(html).querySelectorAll(".link-card")];
    expect(plain?.className).not.toMatch(/space-/);
    expect(plain?.querySelector(".dot")).toBeNull();
    expect(plain?.querySelector(".card-site")?.textContent?.trim()).toBe("site1.example");
    expect(colored?.className).toContain("space-clay");
    expect(colored?.querySelector(".card-site")?.textContent?.trim()).toBe(
      "Kitchen, kitchen.example",
    );
    const title = colored?.querySelector("h3 a");
    expect(title?.getAttribute("href")).toBe("https://kitchen.example/x");
    expect(title?.getAttribute("target")).toBe("_blank");
    expect(title?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(html).not.toContain("because");
    expect(html).not.toContain("Tell me why");
    expect(dom(html).querySelector("main")?.textContent).not.toMatch(/\d+ links?\b/);
    expect(outsideRefs(html)).toEqual([]);
  });

  it("shows a stored image from this site, and a plain tile otherwise", () => {
    const html = all({ links: [link("1"), link("2")], images: new Map([["1", "v9"]]) });
    const [withImage, without] = [...dom(html).querySelectorAll(".link-card")];
    expect(withImage?.querySelector("img")?.getAttribute("src")).toBe("/images/1?v=v9");
    expect(without?.querySelector("img")).toBeNull();
  });

  it("fades the cards on the done page, which links back in the same order", () => {
    const html = all({ done: true, order: "oldest", links: [link("1", { state: "archived" })] });
    expect(dom(html).querySelector(".link-card")?.className).toContain("faded");
    expect(texts(html, "h1")).toEqual(["Links you're done with"]);
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

  it("offers Search instead, and puts All links first in the menu", () => {
    const html = all();
    expect(dom(html).querySelector("a.search-instead")?.getAttribute("href")).toBe("/search");
    expect(texts(html, "nav.menu a")[0]).toBe("All links");
  });

  it.each([
    [{}, "No links yet."],
    [{ order: "opened" as const }, "Nothing opened yet. Links you open from this site show here."],
    [{ done: true }, "Nothing here is done yet."],
    [
      { done: true, order: "opened" as const },
      "You haven't opened any of the links you're done with.",
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
  describe("its links you're done with", () => {
    itRecordsOpenings(() => all({ links: shown, done: true }), web, "/links/opened");
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
  it("gives each active card the control and kept ones Handy · Not handy anymore; the done view has none", () => {
    const html = all({ links: [link("1"), link("2")], handy: new Map([["2", kept]]) });
    const d = dom(html);
    expect((d.querySelector('[data-id="1"] button[data-act=keep]') as HTMLElement).hidden).toBe(
      false,
    );
    expect((d.querySelector('[data-id="2"] .handy-on') as HTMLElement).hidden).toBe(false);
    const done = all({ links: [link("1", { state: "archived" })], done: true });
    expect(dom(done).querySelector("[data-handy]")).toBeNull();
    expect(done).not.toContain('id="undo-bar"');
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
