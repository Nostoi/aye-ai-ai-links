import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { DigestLink, DigestReason } from "../core/digest.js";
import type { FocusEntry, Link, Source, Tag } from "../core/types.js";
import { handyShelf } from "./handy-shelf.js";
import { homePage } from "./home-page.js";
import { runPage } from "./opened-test-kit.js";
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
    why: { text: "to compare", source: "stated" },
    tags: [],
    savedAt: new Date("2026-03-12T10:00:00Z"),
    savedBy: "claude",
    lastOpenedAt: null,
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
const render = (
  links: DigestLink[],
  images = new Map<string, string>(),
  catalog: Tag[] = [],
  gone: Link | null = null,
) => homePage({ worth: { links, images, now: NOW, catalog, gone }, shelf: "", spaces: "" });
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
const pill = (html: string) => dom(html).querySelector(".worth-lead .reason")?.textContent;

describe("Worth a look today", () => {
  it("is left out when there is nothing to show", () => {
    const html = render([]);
    expect(html).not.toContain("Worth a look today");
    expect(html).toContain("What are you trying to remember?");
  });

  it("shows one large card and up to two small ones, each with its id", () => {
    const cards = [card([]), card([]), card([])];
    const d = dom(render(cards));
    expect(d.querySelectorAll(".worth-lead")).toHaveLength(1);
    expect(d.querySelectorAll(".worth-small")).toHaveLength(2);
    expect([...d.querySelectorAll("[data-id]")].map((e) => (e as HTMLElement).dataset.id)).toEqual(
      cards.map((c) => c.link.id),
    );
  });

  it("gives the large card Open it, and each card Not now, I'm done with it and Keep handy", () => {
    const d = dom(render([card([]), card([])]));
    const lead = d.querySelector(".worth-lead") as HTMLElement;
    const open = lead.querySelector("a.button[data-open]") as HTMLAnchorElement;
    expect(open.textContent).toBe("Open it");
    expect(open.getAttribute("href")).toBe(lead.querySelector("h3 a")?.getAttribute("href"));
    const acts = (el: Element) =>
      [...el.querySelectorAll("button[data-act]")].map((b) => [
        (b as HTMLElement).dataset.act,
        b.textContent,
      ]);
    // #125 adds Keep handy as Worth a look's fourth choice.
    const both = [
      ["snooze", "Not now"],
      ["archive", "I'm done with it"],
      ["keep", "Keep handy"],
    ];
    expect(acts(lead)).toEqual(both);
    expect(acts(d.querySelector(".worth-small") as Element)).toEqual(both);
  });

  it("opens every link in a new tab, and records the opening from the title and Open it", () => {
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
    expect(dom(html).querySelector(".worth-lead a")).toBeNull();
    expect(dom(html).querySelector(".worth-lead h3")?.textContent).toBe("Odd");
  });

  describe("the reason on the large card", () => {
    it("quotes a focus entry the owner gave as what they said", () => {
      for (const source of ["stated", "asked"] as const) {
        expect(pill(render([card([focus("home batteries", source)])]))).toBe(
          `You said you're working on "home batteries"`,
        );
      }
    });

    it("never says 'You said' for an inferred focus entry, and calls it a guess", () => {
      const html = render([card([focus("home batteries", "inferred")])]);
      expect(pill(html)).toBe(`Maybe you're working on "home batteries" (a guess)`);
      expect(html).not.toContain("You said");
    });

    it("says a link not opened lately was saved over a month ago", () => {
      expect(pill(render([card([{ kind: "not_opened_recently" }])]))).toBe(
        "You saved this over a month ago",
      );
    });

    it("falls back to the saved date for no why or never shown", () => {
      for (const kind of ["no_why", "never_surfaced"] as const) {
        expect(pill(render([card([{ kind }])]))).toBe("You saved this March 12");
      }
      expect(pill(render([card([], { savedAt: new Date("2025-03-12T10:00:00Z") })]))).toBe(
        "You saved this March 12, 2025",
      );
    });

    it("prefers focus over the other reasons", () => {
      const html = render([
        card([{ kind: "no_why" }, { kind: "not_opened_recently" }, focus("x", "stated")]),
      ]);
      expect(pill(html)).toBe(`You said you're working on "x"`);
    });
  });

  it("shows the why: quoted when the owner gave it, as a guess when inferred", () => {
    const said = dom(render([card([{ kind: "not_opened_recently" }])]));
    expect(said.querySelector(".worth-lead .meta")?.textContent).toBe(
      'Saved March 12, "to compare"',
    );
    const guessed = dom(render([card([], { why: { text: "maybe solar", source: "inferred" } })]));
    expect(guessed.querySelector(".worth-lead .meta")?.textContent).toBe('"maybe solar" (a guess)');
    const small = dom(render([card([]), card([], { why: { text: "x", source: "inferred" } })]));
    expect(small.querySelector(".worth-small .meta")?.textContent).toBe(
      'Saved March 12, "x" (a guess)',
    );
  });

  it("asks why, in amber, only on cards with no why", () => {
    const html = render([card([], { why: null }), card([]), card([], { why: null })]);
    const d = dom(html);
    const needy = [...d.querySelectorAll(".needs-you")];
    expect(needy.map((e) => (e as HTMLElement).dataset.id)).toEqual([String(n - 2), String(n)]);
    for (const el of needy) {
      expect(el.tagName).toBe("ARTICLE");
      expect(el.querySelector(".ask")?.textContent).toContain("Why did you save this?");
      expect(el.querySelector("button[data-act=why]")?.textContent).toBe("Tell me why");
    }
    expect(d.querySelectorAll("button[data-act=why]")).toHaveLength(2);
    expect(d.querySelectorAll("form.why-form")).toHaveLength(2);
  });

  it("uses amber only for the needs-you card and its Tell me why, never a reason pill or a tile", () => {
    const rules = [...themeCss.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel = "", body = ""]) => ({
      sel: sel.trim(),
      body,
    }));
    const amber = rules.filter((r) => /amber/.test(r.body)).map((r) => r.sel);
    for (const sel of amber)
      expect(sel, sel).not.toMatch(/reason|tile|worth-image|worth-lead\b(?!\.needs)/);
    expect(amber).toEqual(expect.arrayContaining([".needs-you", ".tell-why"]));
    const html = render([card([{ kind: "no_why" }], { why: null })]);
    for (const el of dom(html).querySelectorAll(".reason, .worth-image, .worth-tile")) {
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
    const d = dom(render(cards, new Map(), catalog));
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
    const html = render([withImage, without], new Map([[withImage.link.id, "v1"]]));
    expect(outsideRefs(html)).toEqual([]);
    expect(html).not.toContain("images.example");
    const d = dom(html);
    expect(d.querySelector(".worth-lead img")?.getAttribute("src")).toBe(
      `/images/${withImage.link.id}?v=v1`,
    );
    expect(d.querySelector(".worth-small img")).toBeNull();
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
    expect(d.querySelector(".worth-lead h3")?.textContent).toBe(evil);
  });
});

type Answer = { status: number; type?: string; body?: unknown };
type Sent = { url: string; body: unknown; redirect: unknown; keepalive: unknown };
const REDIRECT: Answer = { status: 0, type: "opaqueredirect" };

/** The page in linkedom with its scripts, except the menu's, run against it. */
function load(answer: (sent: Sent) => Answer, links: DigestLink[]) {
  const html = render(links);
  const { document, window } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => !s.includes("sign-out"))
    .join("\n");
  const sent: Sent[] = [];
  const fetch = async (
    url: string,
    init: { body: string; redirect?: string; keepalive?: boolean },
  ) => {
    const request = {
      url,
      body: JSON.parse(init.body),
      redirect: init.redirect,
      keepalive: init.keepalive,
    };
    sent.push(request);
    const a = answer(request);
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      type: a.type ?? "basic",
      json: async () => {
        if (a.body === undefined) throw new SyntaxError("no body");
        return a.body;
      },
    };
  };
  const location = { reloads: 0, reload: () => location.reloads++ };
  const onWindow = new Map<string, (event: unknown) => void>();
  new Function(
    "document",
    "fetch",
    "location",
    "addEventListener",
    "setTimeout",
    "clearTimeout",
    code,
  )(
    document,
    fetch,
    location,
    (type: string, fn: (event: unknown) => void) => onWindow.set(type, fn),
    () => 0,
    () => {},
  );
  const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
  const dispatch = (selector: string, type: string, init: Record<string, unknown> = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, init);
    $(selector).dispatchEvent(event);
    return event;
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const hidden = (id: string) => $(`[data-id="${id}"]`).hidden;
  return {
    $,
    dispatch,
    sent,
    settle,
    location,
    hidden,
    fire: (t: string, e: unknown) => onWindow.get(t)?.(e),
  };
}

describe("the home page's script", () => {
  const two = () => [card([]), card([], { why: null })];

  it("records an opening from Open it or the title with a keepalive post, without stopping the link", async () => {
    const cards = two();
    const page = load(() => ({ status: 204 }), cards);
    const first = page.dispatch(".worth-lead a.button", "click");
    page.dispatch(".worth-small h3 a", "click");
    await page.settle();
    expect(first.defaultPrevented).toBe(false);
    expect(page.sent).toEqual([
      { url: "/home/opened", body: { id: cards[0]?.link.id }, redirect: "manual", keepalive: true },
      { url: "/home/opened", body: { id: cards[1]?.link.id }, redirect: "manual", keepalive: true },
    ]);
  });

  it("records a middle click, and not a right click", async () => {
    const page = load(() => ({ status: 204 }), two());
    page.dispatch(".worth-lead h3 a", "auxclick", { button: 2 });
    await page.settle();
    expect(page.sent).toEqual([]);
    page.dispatch(".worth-lead h3 a", "auxclick", { button: 1 });
    await page.settle();
    expect(page.sent.map((s) => s.url)).toEqual(["/home/opened"]);
  });

  it("Not now hides the card and offers Undo, which sends back the snooze it got and shows the card", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const snooze = {
      until: "2026-10-28T10:00:00.000Z",
      claimedAt: "2026-10-14T10:00:00.000Z",
      previousSurfacedAt: "2026-09-01T10:00:00.000Z",
    };
    const page = load(
      (s) => (s.url === "/home/snooze" ? { status: 200, body: snooze } : { status: 204 }),
      cards,
    );
    page.dispatch(".worth-lead button[data-act=snooze]", "click");
    await page.settle();
    expect(page.sent[0]).toMatchObject({ url: "/home/snooze", body: { id }, redirect: "manual" });
    expect(page.hidden(id)).toBe(true);
    expect(page.$("#undo-bar span").textContent).toBe("Hidden for two weeks.");
    page.dispatch("#undo-bar button", "click");
    await page.settle();
    expect(page.sent[1]).toMatchObject({ url: "/home/unsnooze" });
    expect(page.sent[1]?.body).toEqual({ id, ...snooze });
    expect(page.hidden(id)).toBe(false);
  });

  it("I'm done hides the card and offers Undo, which puts it back", async () => {
    const cards = two();
    const id = cards[1]?.link.id as string;
    const page = load(() => ({ status: 204 }), cards);
    page.dispatch(".worth-small button[data-act=archive]", "click");
    await page.settle();
    expect(page.sent[0]).toMatchObject({ url: "/home/archive", body: { id } });
    expect(page.hidden(id)).toBe(true);
    expect(page.$("#undo-bar span").textContent).toBe("Moved out of your list.");
    page.dispatch("#undo-bar button", "click");
    await page.settle();
    expect(page.sent[1]).toMatchObject({ url: "/home/unarchive", body: { id } });
    expect(page.hidden(id)).toBe(false);
  });

  it.each([
    ["a redirect to the sign-in page", "archive", REDIRECT],
    ["a 200 instead of a 204", "archive", { status: 200, body: {} }],
    ["a redirect to the sign-in page", "snooze", REDIRECT],
    ["a 204 with no snooze", "snooze", { status: 204 }],
  ])(
    "puts the card back and offers no Undo when the action gets %s (%s)",
    async (_, act, answer) => {
      const cards = two();
      const page = load(() => answer, cards);
      page.dispatch(`.worth-lead button[data-act=${act}]`, "click");
      await page.settle();
      expect(page.hidden(cards[0]?.link.id as string)).toBe(false);
      expect(page.$("#undo-bar").hidden).toBe(true);
      expect(page.$("#home-error").textContent).toMatch(/did not work/);
    },
  );

  it.each([
    ["snooze", "This link is already put off. Reload."],
    ["archive", "Changed since."],
  ])(
    "puts the card back with the refusal's words and offers no Undo when %s gets a 409",
    async (act, message) => {
      const cards = two();
      const page = load(() => ({ status: 409, body: { code: "conflict", message } }), cards);
      page.dispatch(`.worth-lead button[data-act=${act}]`, "click");
      await page.settle();
      expect(page.hidden(cards[0]?.link.id as string)).toBe(false);
      expect(page.$("#undo-bar").hidden).toBe(true);
      expect(page.$("#home-error").textContent).toBe(message);
      expect(page.sent).toHaveLength(1);
    },
  );

  it("keeps the card gone and says why when Undo is refused", async () => {
    const cards = two();
    const id = cards[0]?.link.id as string;
    const page = load(
      (s) =>
        s.url === "/home/unarchive"
          ? { status: 409, body: { message: "Changed since." } }
          : { status: 204 },
      cards,
    );
    page.dispatch(".worth-lead button[data-act=archive]", "click");
    await page.settle();
    page.dispatch("#undo-bar button", "click");
    await page.settle();
    expect(page.hidden(id)).toBe(true);
    expect(page.$("#home-error").textContent).toBe("Changed since.");
  });

  it("Tell me why opens a field; a saved answer replaces the question and the amber", async () => {
    const cards = two();
    const id = cards[1]?.link.id as string;
    const page = load(() => ({ status: 204 }), cards);
    const form = page.$(".needs-you form.why-form");
    expect(form.hidden).toBe(true);
    page.dispatch(".needs-you button[data-act=why]", "click");
    expect(form.hidden).toBe(false);
    (form.querySelector("input") as HTMLInputElement).value = "  for the <kitchen>  ";
    page.dispatch(".needs-you form.why-form", "submit");
    await page.settle();
    expect(page.sent).toEqual([
      {
        url: "/home/why",
        body: { id, text: "  for the <kitchen>  " },
        redirect: "manual",
        keepalive: undefined,
      },
    ]);
    const article = page.$(`[data-id="${id}"]`);
    expect(article.classList.contains("needs-you")).toBe(false);
    expect(article.querySelector(".ask")).toBeNull();
    expect(article.querySelector(".meta")?.textContent).toBe('Saved March 12, "for the <kitchen>"');
  });

  it("sends no blank answer, and shows the refusal of one that was not saved", async () => {
    const cards = two();
    const page = load(
      () => ({ status: 409, body: { message: "This link already has a reason. Reload." } }),
      cards,
    );
    page.dispatch(".needs-you button[data-act=why]", "click");
    const input = page.$(".needs-you form.why-form input") as HTMLInputElement;
    input.value = "   ";
    page.dispatch(".needs-you form.why-form", "submit");
    await page.settle();
    expect(page.sent).toEqual([]);
    input.value = "because";
    page.dispatch(".needs-you form.why-form", "submit");
    await page.settle();
    expect(page.$("#home-error").textContent).toBe("This link already has a reason. Reload.");
    expect(page.$(".needs-you")).not.toBeNull();
  });

  it("reloads when shown again from the back-forward cache", () => {
    const page = load(() => ({ status: 204 }), two());
    page.fire("pageshow", { persisted: false });
    expect(page.location.reloads).toBe(0);
    page.fire("pageshow", { persisted: true });
    expect(page.location.reloads).toBe(1);
  });
});

it("orders home: the search, the Handy shelf, Worth a look today, Your spaces", () => {
  const html = homePage({
    worth: { links: [card([])], images: new Map(), now: NOW, catalog: [], gone: null },
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

describe("Keep handy on a Worth a look card", () => {
  const withShelf = (links: DigestLink[]) =>
    homePage({
      worth: { links, images: new Map(), now: NOW, catalog: [], gone: null },
      shelf: handyShelf({ items: [], suggestions: [], catalog: [], images: new Map() }),
      spaces: "",
    });
  const ROW = {
    status: "kept",
    source: "stated",
    since: "2026-10-14T10:00:00.000Z",
    answeredAt: null,
    waitDays: 30,
  };

  it("hides the card, keeps the link, puts it on the shelf, and Undo sends back the rows and shows the card", async () => {
    const cards = [card([]), card([])];
    const id = cards[0]?.link.id as string;
    const onShelf = homePage({
      worth: { links: [], images: new Map(), now: NOW, catalog: [], gone: null },
      shelf: handyShelf({
        items: [
          {
            link: cards[0]?.link as Link,
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
    p.dispatch(p.$(".worth-lead button[data-act=keep]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/tools/keep", body: { id }, redirect: "manual" });
    expect((p.$(".worth-lead") as HTMLElement).hidden).toBe(true);
    expect(p.document.querySelector(`#handy-shelf [data-id="${id}"]`)).not.toBeNull();
    expect(p.$("#undo-bar span").textContent).toBe("Kept on your Handy shelf.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent.find((s) => s.url === "/tools/undo")?.body).toEqual({
      id,
      tool: ROW,
      previous: null,
    });
    expect((p.$(".worth-lead") as HTMLElement).hidden).toBe(false);
    expect(p.sent.map((s) => s.url)).toEqual(["/tools/keep", "/", "/tools/undo", "/"]);
    expect(p.sent.some((s) => s.url === "/home/opened")).toBe(false);
  });

  it("puts the card back with the refusal's words, offers no Undo and refreshes nothing on a 409", async () => {
    const cards = [card([])];
    const message = "That link's Keep handy state changed. Reload the page.";
    const p = runPage(withShelf(cards), () => ({
      status: 409,
      body: { code: "conflict", message },
    }));
    p.dispatch(p.$(".worth-lead button[data-act=keep]"), "click");
    await p.settle();
    expect((p.$(".worth-lead") as HTMLElement).hidden).toBe(false);
    expect(p.$("#home-error").textContent).toBe(message);
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect(p.sent.map((s) => s.url)).toEqual(["/tools/keep"]);
  });
});

describe("the Worth a look gone card (#128)", () => {
  const goneLink = () => link({ why: null });
  const html = (links: DigestLink[], gone: Link | null) => render(links, new Map(), [], gone);
  const ROWS = { check: { result: "alive" }, previous: { result: "dead" } };

  it("is the last card in the side column, small, amber, with its two buttons and nothing else", () => {
    const g = goneLink();
    const d = dom(html([card([]), card([]), card([])], g));
    const side = [...d.querySelectorAll(".worth-side > article")];
    const last = side[side.length - 1] as HTMLElement;
    expect(last.dataset.id).toBe(g.id);
    expect(side).toHaveLength(3);
    expect(last.className).toMatch(/worth-small worth-gone needs-you/);
    expect(last.querySelector("p.small")?.textContent).toBe("This page seems gone");
    expect([...last.querySelectorAll("button")].map((b) => [b.dataset.act, b.textContent])).toEqual(
      [
        ["archive", "I'm done with it"],
        ["still-works", "It still works"],
      ],
    );
    expect(last.textContent).not.toMatch(/Not now|Keep handy|Tell me why/);
    expect(last.querySelector(".worth-body")?.textContent?.replace(g.title ?? "", "")).not.toMatch(
      /\d/,
    );
    expect(last.querySelector("h3 a")?.getAttribute("href")).toBe(g.url);
  });

  it("stands alone and small when there are no reading picks, never in the lead slot", () => {
    const d = dom(html([], goneLink()));
    expect(d.querySelector("#worth")?.textContent).toBe("Worth a look today");
    expect(d.querySelectorAll(".worth-lead")).toHaveLength(0);
    const only = d.querySelectorAll("#worth-cards article");
    expect(only).toHaveLength(1);
    expect(only[0]?.className).toMatch(/worth-small worth-gone/);
    // The theme sizes a side column that is the grid's first child as one small card.
    expect(d.getElementById("worth-cards")?.firstElementChild?.className).toBe("worth-side");
  });

  it("leaves home without a Worth a look section when there is nothing at all", () => {
    expect(dom(html([], null)).querySelector(".worth")).toBeNull();
  });

  const open = (answer: (s: Sent) => Answer = () => ({ status: 204 })) => {
    const g = goneLink();
    const p = runPage(html([card([])], g), answer);
    return { p, g, gone: () => p.$(".worth-gone") as HTMLElement };
  };

  it("It still works posts the id, hides the card, and Undo sends back the answer's rows and shows it", async () => {
    const { p, g, gone } = open((s) =>
      s.url === "/links/still-works" ? { status: 200, body: ROWS } : { status: 204 },
    );
    p.dispatch(p.$(".worth-gone button[data-act=still-works]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/links/still-works", body: { id: g.id } });
    expect(gone().hidden).toBe(true);
    expect(p.$("#undo-bar span").textContent).toBe("Marked as working.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({
      url: "/links/still-works/undo",
      body: { id: g.id, ...ROWS },
    });
    expect(gone().hidden).toBe(false);
  });

  it("an Undo the server refuses shows its message and leaves the card hidden", async () => {
    const message = "This link was checked since, so it stays as it is.";
    const { p, gone } = open((s) =>
      s.url === "/links/still-works"
        ? { status: 200, body: ROWS }
        : { status: 409, body: { code: "conflict", message } },
    );
    p.dispatch(p.$(".worth-gone button[data-act=still-works]"), "click");
    await p.settle();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(gone().hidden).toBe(true);
    expect(p.$("#home-error").textContent).toBe(message);
  });

  it("a refused It still works puts the card back with the message and offers no Undo", async () => {
    const message = "This link isn't marked as gone. Reload the page.";
    const { p, gone } = open(() => ({ status: 409, body: { code: "conflict", message } }));
    p.dispatch(p.$(".worth-gone button[data-act=still-works]"), "click");
    await p.settle();
    expect(gone().hidden).toBe(false);
    expect(p.$("#home-error").textContent).toBe(message);
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("I'm done with it archives as on any card, and Undo unarchives", async () => {
    const { p, g, gone } = open();
    p.dispatch(p.$(".worth-gone button[data-act=archive]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/home/archive", body: { id: g.id } });
    expect(gone().hidden).toBe(true);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({ url: "/home/unarchive", body: { id: g.id } });
    expect(gone().hidden).toBe(false);
  });
});
