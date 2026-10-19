import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { HomeSpace } from "../core/spaces.js";
import type { Link, Tag } from "../core/types.js";
import { itRecordsOpenings, openAppended } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { searchPage } from "./pages.js";
import { spaceHref, spacePage } from "./space-page.js";
import { spacesSection } from "./spaces-section.js";
import { tagsPage } from "./tags-page.js";

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

describe("the Your spaces section", () => {
  const tile = (over: Partial<HomeSpace> & { key: string }): HomeSpace => ({
    name: over.key,
    color: null,
    mosaic: [],
    ...over,
  });

  it("says how to make a space when nothing is pinned", () => {
    const html = spacesSection([]);
    expect(html).toContain("Your spaces");
    expect(html).toContain("Pin a tag on the");
    expect(hrefs(html, "a")).toEqual(["/tags"]);
  });

  it("shows each space as a tile opening its page, in its color, with its stored images", () => {
    const html = spacesSection([
      tile({
        key: "home batteries",
        name: "Home batteries",
        color: "teal",
        mosaic: [
          { linkId: "7", version: "v7" },
          { linkId: "3", version: "v3" },
        ],
      }),
      tile({ key: "kitchen", name: "Kitchen", color: null }),
    ]);
    const tiles = [...dom(html).querySelectorAll("a.home-space")];
    expect(tiles.map((a) => a.textContent?.trim())).toEqual(["Home batteries", "Kitchen"]);
    expect(tiles.map((a) => tagOf(a.getAttribute("href") as string))).toEqual([
      "home batteries",
      "kitchen",
    ]);
    expect(tiles[0]?.className).toContain("space-teal");
    expect(tiles[1]?.className).not.toMatch(/space-/);
    const imgs = [...(tiles[0]?.querySelectorAll("img") ?? [])].map((i) => i.getAttribute("src"));
    expect(imgs).toEqual(["/images/7?v=v7", "/images/3?v=v3"]);
    expect(tiles[0]?.querySelectorAll(".mosaic > *")).toHaveLength(3);
    expect(tiles[1]?.querySelectorAll(".mosaic > img")).toHaveLength(0);
    expect(tiles[1]?.querySelectorAll(".mosaic > *")).toHaveLength(3);
    expect(outsideRefs(html)).toEqual([]);
  });

  it("keeps a hostile name inert and an odd key intact", () => {
    const html = spacesSection([tile({ key: ODD_KEY, name: HOSTILE, color: "clay" })]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(hrefs(html, "a.home-space").map(tagOf)).toEqual([ODD_KEY]);
  });
});

describe("a space page", () => {
  it("heads the page with the space's color band, name and kind, and links to the Tags page", () => {
    const html = space();
    const header = dom(html).querySelector(".band");
    expect(header?.className).toContain("space-teal");
    expect(dom(html).querySelector("h1")?.textContent?.trim()).toBe("Home batteries");
    expect(html).toContain("A topic you save links about");
    expect(hrefs(html, ".band a")).toEqual(["/tags"]);
    expect(html).toContain("Change this space");
  });

  it.each([
    ["no color", null],
    ["a stored color that is not a space color", "amber"],
    ["CSS in the color", "teal;x"],
  ])("draws a neutral band for a tag with %s", (_, color) => {
    const html = space({ tag: tag({ key: "k", color, pinned: true }) });
    expect(dom(html).querySelector(".band")?.className).not.toMatch(/space-/);
    expect(html).not.toContain("space-amber");
    expect(html).not.toContain("teal;x");
  });

  it("draws a neutral band for an unpinned tag that kept a space color, matching its cards", () => {
    const kept = tag({ key: "baking", name: "Baking", color: "violet" });
    const links = [link("a", { tags: onTag("baking") })];
    const html = space({ tag: kept, catalog: [kept], links });
    expect(dom(html).querySelector(".band")?.className).not.toMatch(/space-/);
    expect(dom(html).querySelector(".link-card")?.className).not.toMatch(/space-/);
    const pinned = { ...kept, pinned: true };
    const again = space({ tag: pinned, catalog: [pinned], links });
    expect(dom(again).querySelector(".band")?.className).toContain("space-violet");
    expect(dom(again).querySelector(".link-card")?.className).toContain("space-violet");
  });

  it("gives an unpinned tag with no color a page with a neutral band", () => {
    const html = space({ tag: tag({ key: "baking", name: "Baking" }), catalog: [] });
    expect(dom(html).querySelector("h1")?.textContent?.trim()).toBe("Baking");
    expect(dom(html).querySelector(".band")?.className).not.toMatch(/space-/);
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
    [tag({ key: "p" }), "A topic you save links about"],
  ])("says what kind of space it is (%#)", (t, line) => {
    expect(space({ tag: t })).toContain(line);
  });

  it("shows a description only when the tag has one, escaped", () => {
    expect(dom(space()).querySelector(".band-description")).toBeNull();
    const html = space({ tag: { ...HOME, description: HOSTILE } });
    expect(dom(html).querySelector(".band-description")?.textContent).toBe(HOSTILE);
    expect(html).not.toContain("<img src=x");
  });

  it("keeps a hostile name inert in the title and heading", () => {
    const html = space({ tag: tag({ key: "x", name: HOSTILE }) });
    expect(html).not.toContain("<img src=x");
    expect(dom(html).querySelector("title")?.textContent).toContain(HOSTILE);
  });

  it("lists the links newest first as given, each in the space's color, opening in a new tab", () => {
    const links = [link("2", { tags: onTag("home batteries") }), link("1")];
    const html = space({ links, images: new Map([["2", "v2"]]) });
    const cards = [...dom(html).querySelectorAll("#space-links > li")];
    expect(cards.map((c) => c.querySelector("h3")?.textContent?.trim())).toEqual([
      "Link 2",
      "Link 1",
    ]);
    expect(cards[0]?.className).toContain("space-teal");
    expect(cards[1]?.className).not.toMatch(/space-/);
    const a = cards[0]?.querySelector("h3 a");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(html).toContain("ex.com, saved October 1");
    expect(html).toContain("because 2");
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
    const html = space({ links, images: new Map([["1", "v1"]]) });
    const srcs = [...dom(html).querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["/images/1?v=v1"]);
    expect(outsideRefs(html)).toEqual([]);
  });

  it("asks Tell me why, as home does, on an active link with no why, and not on one with a why", () => {
    const d = dom(space({ links: [link("1", { why: null }), link("2")] }));
    const [needy, known] = [...d.querySelectorAll("#space-links > li")];
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
    expect(space({ later: true, done: true })).not.toContain("Nothing here is done yet.");
  });

  it("shows Show older links only when older links exist, as a real link to the next page", () => {
    expect(dom(space({ links: [link("1")] })).querySelector("#older")).toBeNull();
    const html = space({ links: [link("1")], older: "100.1" });
    const older = new URL(hrefs(html, "#older")[0] as string, ORIGIN);
    expect(older.pathname).toBe("/spaces");
    expect(older.searchParams.get("tag")).toBe("home batteries");
    expect(older.searchParams.get("before")).toBe("100.1");
  });

  it("links to the links you're done with", () => {
    const done = hrefs(space(), "a.done-link").map((h) => new URL(h, ORIGIN));
    expect(done.map((u) => [u.pathname, u.searchParams.get("tag")])).toEqual([
      ["/spaces/done", "home batteries"],
    ]);
  });
});

describe("a space's links you're done with", () => {
  const done = (over: Partial<Parameters<typeof spacePage>[0]> = {}) =>
    space({ done: true, ...over });

  it("is headed so, links back to the space, and pages within the done view", () => {
    const html = done({ links: [link("1", { state: "archived" })], older: "9.1" });
    expect(html).toContain("Links you're done with");
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
    const card = dom(html).querySelector("#space-links > li");
    expect(card?.className).toContain("faded");
    expect(card?.querySelector("h3")?.textContent?.trim()).toBe("Link 1");
    expect(card?.querySelector(".ask, button[data-act=why], form.why-form")).toBeNull();
    expect(card?.querySelector(".card-why")?.textContent).toBe("No why yet");
    expect(card?.outerHTML).not.toMatch(/amber|needs/);
    expect(html).not.toContain("/home/why");
  });

  it("says when nothing in the space is done", () => {
    expect(done()).toContain("Nothing here is done yet.");
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
    const why = card.querySelector(".card-why") as HTMLElement;
    expect(why.hidden).toBe(false);
    expect(why.textContent).toBe('Why: "for the <attic>"');
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
    const titles = [...r.document.querySelectorAll("#space-links > li h3")].map((h) =>
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
    expect(card.querySelector("[data-why-answer]")?.textContent).toBe('Why: "for the shed"');
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
    expect(r.document.querySelectorAll("#space-links > li")).toHaveLength(2);
  });

  it.each([
    ["was redirected, as when the session ended", { ok: true, redirected: true }],
    ["failed", { ok: false, redirected: false }],
  ])("navigates to the next page when the request %s", async (_, answer) => {
    const r = await clickOlder(first, { ...answer, text: next });
    expect(r.location.href).toBe(r.asked[0]);
    expect(r.document.querySelectorAll("#space-links > li")).toHaveLength(2);
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
    expect(first?.querySelector(".in-space")?.textContent?.trim()).toBe("Home batteries");
    expect(second?.className).not.toMatch(/space-/);
    expect(second?.querySelector(".in-space")).toBeNull();
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
  describe("its links you're done with", () => {
    itRecordsOpenings(() => space({ links: shown, done: true }), web, "/links/opened");
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
  it("gives each active card the control, and the done view none and no Undo bar", () => {
    const html = space({ links: [link("1"), link("2")], handy: new Map([["2", kept]]) });
    const d = dom(html);
    expect((d.querySelector('[data-id="1"] button[data-act=keep]') as HTMLElement).hidden).toBe(
      false,
    );
    expect((d.querySelector('[data-id="2"] .handy-on') as HTMLElement).hidden).toBe(false);
    expect(html).toContain('id="undo-bar"');
    expect(html.match(/const post = /g)).toHaveLength(1);
    const done = space({ links: [link("1", { state: "archived" })], done: true });
    expect(dom(done).querySelector("[data-handy]")).toBeNull();
    expect(done).not.toContain('id="undo-bar"');
  });
});
