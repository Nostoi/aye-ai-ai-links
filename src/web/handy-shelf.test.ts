import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { ShownPicture } from "../core/image-store.js";
import type { ShelfItem, ToolItem } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { handyShelf, SHELF_SIZE, SHELF_STALE } from "./handy-shelf.js";
import { homePage, type WorthCards } from "./home-page.js";
import { type Answer, itRecordsOpenings, type Post, runPage } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";

let n = 0;
const link = (over: Partial<Link> = {}): Link => {
  n += 1;
  return {
    id: String(n),
    url: `https://tool${n}.example/login`,
    urlKey: `tool${n}.example/login`,
    title: `Tool ${n}`,
    summary: null,
    why: null,
    tags: [],
    savedAt: new Date("2026-09-01T00:00:00Z"),
    savedBy: "t",
    lastOpenedAt: null,
    lastSurfacedAt: null,
    snoozedUntil: null,
    state: "active",
    snapshot: null,
    ...over,
  };
};
const row = (status: "kept" | "suggested") => ({
  status,
  source: status === "kept" ? ("stated" as const) : ("inferred" as const),
  since: new Date("2026-10-01T00:00:00Z"),
  answeredAt: null,
  waitDays: 30 as const,
});
const kept = (over: Partial<Link> = {}, due = false): ShelfItem => ({
  link: link(over),
  tool: row("kept"),
  due,
  gone: false,
});
const suggested = (over: Partial<Link> = {}): ToolItem => ({
  link: link(over),
  tool: row("suggested"),
});
const render = (
  items: ShelfItem[],
  suggestions: ToolItem[] = [],
  catalog: Tag[] = [],
  images = new Map<string, ShownPicture>(),
) => handyShelf({ items, suggestions, catalog, images });
const dom = (html: string) => parseHTML(html).document;
const tiles = (html: string) =>
  [...dom(html).querySelectorAll("#handy-shelf .handy-tile")] as HTMLElement[];
const ids = (els: HTMLElement[]) => els.map((e) => e.dataset.id);

describe("the Handy shelf", () => {
  it("shows the kept tools in the order given, the first 8 visible and the rest hidden behind Show all", () => {
    const items = Array.from({ length: 10 }, () => kept());
    const html = render(items);
    expect(SHELF_SIZE).toBe(8);
    expect(ids(tiles(html))).toEqual(items.map((i) => i.link.id));
    expect(tiles(html).map((t) => t.hidden)).toEqual([...Array(8).fill(false), true, true]);
    expect(tiles(html).filter((t) => t.hasAttribute("data-more"))).toHaveLength(2);
    expect(
      dom(html).querySelector("#handy-shelf .handy-head button[data-act=show-all]")?.textContent,
    ).toBe("Show all 10");
    expect(dom(html).querySelector(".handy-foot")).toBeNull();
  });

  it("offers no Show all for 8 or fewer, and hides none", () => {
    const html = render(Array.from({ length: 8 }, () => kept()));
    expect(tiles(html).some((t) => t.hidden)).toBe(false);
    expect(dom(html).querySelector("button[data-act=show-all]")).toBeNull();
  });

  it("shows each tile's title, opening in a new tab, and its site and space, in the space's color", () => {
    const catalog: Tag[] = [
      {
        key: "school",
        name: "School",
        kind: "topic",
        kindSource: "stated",
        color: "clay",
        pinned: true,
        description: null,
        projectStatus: null,
      },
    ];
    const item = kept({
      title: "Attendance",
      url: "https://school.example/attendance",
      tags: [
        { key: "school", name: "School", source: "stated", kind: "topic", kindSource: "stated" },
      ],
    });
    const [tile] = tiles(render([item], [], catalog));
    const a = tile?.querySelector("h3 a") as HTMLAnchorElement;
    expect(a.textContent).toBe("Attendance");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.hasAttribute("data-open")).toBe(true);
    expect(tile?.querySelector(".card-site")?.textContent).toBe("school.example");
    expect(tile?.className).toContain("space-clay");
  });

  it("fills a tile with the link's stored image, from this site, with no alt text", () => {
    const item = kept({ title: "Attendance" });
    const [tile] = tiles(
      render([item], [], [], new Map([[item.link.id, { version: "v7", fit: "cover" }]])),
    );
    const img = tile?.querySelector("img.handy-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`/images/${item.link.id}?v=v7`);
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(tile?.querySelector(".pic-initials")).toBeNull();
  });

  it("★ an icon tile shows the icon whole, without .photo, keeping the dark caption", () => {
    const item = kept({ title: "Attendance" });
    const [t] = tiles(
      render([item], [], [], new Map([[item.link.id, { version: "v7", fit: "contain" }]])),
    );
    expect(t?.classList.contains("photo")).toBe(false);
    expect(t?.querySelector("div.handy-image.icon-box > img.site-icon")?.getAttribute("src")).toBe(
      `/images/${item.link.id}?v=v7`,
    );
    expect(t?.querySelector(".pic-initials")).toBeNull();
  });

  it("with no image shows a block for the space color and the initials of the title's first two words", () => {
    const [tile] = tiles(render([kept({ title: "attendance tracker online" })]));
    expect(tile?.querySelector("img")).toBeNull();
    expect(tile?.querySelector("div.handy-image.initials-box")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    const initials = tile?.querySelector(".pic-initials");
    expect(initials?.textContent).toBe("AT");
    expect(initials?.parentElement?.getAttribute("aria-hidden")).toBe("true");
  });

  it("takes initials from the host when the link has no title, and skips words with no letter or digit", () => {
    const noTitle = kept({ title: null, url: "https://www.school.example/login" });
    const symbols = kept({ title: "& 2nd Floor Plan" });
    const [a, b] = tiles(render([noTitle, symbols]));
    expect(a?.querySelector(".pic-initials")?.textContent).toBe("SE");
    expect(b?.querySelector(".pic-initials")?.textContent).toBe("2F");
  });

  it("escapes a markup title everywhere it shows, so initials are only letters and digits", () => {
    const html = render([kept({ title: `<script>alert(1)</script> "co" & <b>` })]);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>");
    expect(tiles(html)[0]?.querySelector(".pic-initials")?.textContent).toBe("SC");
  });

  it("names the host only under the title, with the space's dot and not its name", () => {
    const space: Tag = {
      key: "school",
      name: "School",
      kind: "topic",
      kindSource: "stated",
      color: "clay",
      pinned: true,
      description: null,
      projectStatus: null,
    };
    const spaced = kept({
      url: "https://school.example/a",
      tags: [
        { key: "school", name: "School", source: "stated", kind: "topic", kindSource: "stated" },
      ],
    });
    const plain = kept({ url: "https://plain.example/a" });
    const [a, b] = tiles(render([spaced, plain], [], [space]));
    expect(a?.querySelector(".card-site")?.textContent).toBe("school.example");
    expect(a?.querySelector(".card-site .dot")).not.toBeNull();
    expect(a?.textContent).not.toContain("School");
    expect(b?.querySelector(".card-site .host")?.textContent).toBe("plain.example");
    expect(b?.querySelector(".card-site .dot")).toBeNull();
  });

  it("marks a due tile as needing you with Still using?, Yes and Done; a tile not due has neither", () => {
    const html = render([kept({}, true), kept()]);
    const [due, calm] = tiles(html);
    expect(due?.classList.contains("needs-you")).toBe(true);
    expect(due?.querySelector(".ask p")?.textContent).toBe("Still using?");
    expect(
      [...(due?.querySelectorAll(".ask button") ?? [])].map((b) => [
        (b as HTMLElement).dataset.act,
        b.textContent,
      ]),
    ).toEqual([
      ["still-using", "Yes"],
      ["done", "Done"],
    ]);
    expect(calm?.classList.contains("needs-you")).toBe(false);
    expect(calm?.querySelector(".ask")).toBeNull();
    for (const t of tiles(html)) expect(t.className).not.toMatch(/amber|worth-tile/);
  });

  it("marks a gone tile as needing you with the gone ask in place of Still using?; not gone is unchanged", () => {
    const [gone, calm] = tiles(render([{ ...kept(), gone: true }, kept()]));
    expect(gone?.classList.contains("needs-you")).toBe(true);
    expect(gone?.querySelector(".ask p")?.textContent).toBe("Seems gone");
    expect(
      [...(gone?.querySelectorAll(".ask button") ?? [])].map((b) => [
        (b as HTMLElement).dataset.act,
        b.textContent,
      ]),
    ).toEqual([
      ["still-works", "It works"],
      ["done", "Done"],
    ]);
    expect(calm?.classList.contains("needs-you")).toBe(false);
    expect(calm?.querySelector(".ask")).toBeNull();
  });

  it("shows a gone and due tile only the gone ask", () => {
    const [both] = tiles(render([{ ...kept({}, true), gone: true }]));
    expect(both?.querySelectorAll(".ask")).toHaveLength(1);
    expect(both?.querySelector(".ask p")?.textContent).toBe("Seems gone");
    expect(both?.querySelector("button[data-act=still-using]")).toBeNull();
  });

  it("renders the items in the order given, so a gone tile first stays first", () => {
    const calm = kept();
    const gone = { ...kept(), gone: true };
    expect(ids(tiles(render([gone, calm])))).toEqual([gone.link.id, calm.link.id]);
  });

  it("gives every kept tile a menu with I'm done with it then Not handy anymore, and a suggestion none", () => {
    const html = render([kept({ title: "Attendance" })], [suggested()]);
    const [tool, guess] = tiles(html);
    const menu = tool?.querySelector("details.card-menu");
    expect(menu?.querySelector("summary .visually-hidden")?.textContent).toBe(
      "More for Attendance",
    );
    expect(
      [...(menu?.querySelectorAll(".card-menu-list > *") ?? [])].map(
        (b) => `${b.getAttribute("data-act")} ${b.textContent}`,
      ),
    ).toEqual(["archive I'm done with it", "not-handy Not handy anymore"]);
    expect(guess?.querySelector("details")).toBeNull();
  });

  it("puts the suggestions given at the end, in that order, as faded guesses asking Keep handy?, outside the 8", () => {
    const items = Array.from({ length: 9 }, () => kept());
    const offers = [suggested(), suggested()];
    const html = render(items, offers);
    expect(ids(tiles(html))).toEqual([...items, ...offers].map((i) => i.link.id));
    const guesses = tiles(html).slice(9);
    for (const g of guesses) {
      expect(g.classList.contains("guess")).toBe(true);
      expect(g.hidden).toBe(false);
      expect(g.querySelector("p.small:not(.card-site)")?.textContent).toBe("Keep handy?");
      expect(
        [...g.querySelectorAll("button")].map((b) => [
          (b as HTMLElement).dataset.act,
          b.textContent,
        ]),
      ).toEqual([
        ["suggest-yes", "Yes"],
        ["suggest-no", "No"],
      ]);
    }
    expect(
      dom(
        render(
          Array.from({ length: 8 }, () => kept()),
          offers,
        ),
      ).querySelector("button[data-act=show-all]"),
    ).toBeNull();
  });

  it("offers Add in the header, inside the refreshed shelf: a search over the owner's links", () => {
    const d = dom(render([kept()]));
    const add = d.querySelector("#handy-shelf .handy-head a.handy-add");
    expect(add?.textContent).toBe("Add");
    expect(add?.getAttribute("href")).toBe("/search?q=&keep=1");
    expect(add?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(d.querySelector(".handy-head button[data-act=show-all]")).toBeNull();
  });

  it("shows one line with Add when there is nothing on it and nothing suggested, and no header buttons", () => {
    const d = dom(render([]));
    expect(d.querySelector(".handy-row")).toBeNull();
    expect(d.querySelector(".handy-head")).toBeNull();
    expect(d.querySelector("#handy-shelf .handy-empty p")?.textContent).toBe(
      "Keep links you use often here",
    );
    expect(d.querySelector("#handy-shelf .handy-empty a.handy-add")?.getAttribute("href")).toBe(
      "/search?q=&keep=1",
    );
    expect(d.querySelector("h2")?.textContent).toBe("Handy");
  });

  it("renders hostile titles and non-web URLs inertly, making no outside request", () => {
    const evil = `"><img src=https://evil.example/x onerror=alert(1)><script>alert(2)</script>`;
    const html = render(
      [kept({ title: evil }), kept({ title: "Odd", url: "javascript:alert(1)" })],
      [suggested({ title: evil })],
    );
    const d = dom(html);
    expect(d.querySelectorAll("img")).toHaveLength(0);
    expect(d.querySelectorAll("script")).toHaveLength(0);
    expect(outsideRefs(html)).toEqual([]);
    expect(html).not.toContain("javascript:");
    expect(tiles(html)[0]?.querySelector("summary .visually-hidden")?.textContent).toBe(
      `More for ${evil}`,
    );
    expect(tiles(html)[1]?.querySelector("h3 a")).toBeNull();
    expect(tiles(html)[1]?.querySelector("h3")?.textContent).toBe("Odd");
  });
});

const NO_WORTH: WorthCards = {
  links: [],
  images: new Map(),
  now: new Date("2026-10-16T00:00:00Z"),
  catalog: [],
  gone: null,
  goneCopy: null,
};
const home = (items: ShelfItem[], suggestions: ToolItem[] = []) =>
  homePage({ worth: NO_WORTH, shelf: render(items, suggestions), spaces: "" });
const ROW = {
  status: "kept",
  source: "stated",
  since: "2026-10-01T00:00:00.000Z",
  answeredAt: null,
  waitDays: 30,
};
const MOVED = { tool: { ...ROW, status: "declined" }, previous: ROW };

/** The shelf page with `answer` for posts and `next` (a later home page) for each refresh. */
function shelfPage(html: string, answer: (s: Post) => Answer, next: string[] = []) {
  const pages = [...next];
  return runPage(html, (s) =>
    s.body === undefined ? { status: 200, text: pages.shift() ?? html } : answer(s),
  );
}
const urls = (p: ReturnType<typeof runPage>) => p.sent.map((s) => s.url);
const shelfIds = (p: ReturnType<typeof runPage>) =>
  [...p.document.querySelectorAll("#handy-shelf .handy-tile")].map(
    (t) => (t as HTMLElement).dataset.id,
  );

describe("the shelf's openings", () => {
  const items = [kept(), kept()];
  itRecordsOpenings(
    () => home(items),
    items.map((i) => i.link),
    "/links/opened",
  );
});

describe("the shelf's script", () => {
  it("Yes to Still using? posts /tools/still-using, refreshes the shelf from home, and offers no Undo", async () => {
    const due = kept({}, true);
    const after = home([{ ...due, due: false }]);
    const p = shelfPage(home([due]), () => ({ status: 200, body: MOVED }), [after]);
    p.dispatch(p.$("button[data-act=still-using]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/tools/still-using", body: { id: due.link.id } });
    expect(urls(p)).toEqual(["/tools/still-using", "/"]);
    expect(p.$(".handy-tile").classList.contains("needs-you")).toBe(false);
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("It works posts /links/still-works, refreshes the shelf, and offers Undo with the answer's payload", async () => {
    const item = { ...kept(), gone: true };
    const CHECK = { checkedAt: "2026-10-17T00:00:00.000Z", status: "ok" };
    const p = shelfPage(
      home([item]),
      (s) =>
        s.url === "/links/still-works/undo"
          ? { status: 204 }
          : { status: 200, body: { check: CHECK, previous: null } },
      [home([{ ...item, gone: false }]), home([item])],
    );
    p.dispatch(p.$("button[data-act=still-works]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/links/still-works", body: { id: item.link.id } });
    expect(p.$(".handy-tile").classList.contains("needs-you")).toBe(false);
    expect(p.$("#undo-bar span").textContent).toBe("Marked as working.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(urls(p)).toEqual(["/links/still-works", "/", "/links/still-works/undo", "/"]);
    expect(p.sent[2]).toMatchObject({ body: { id: item.link.id, check: CHECK, previous: null } });
    expect(p.$(".handy-tile").classList.contains("needs-you")).toBe(true);
  });

  it("a refused It works shows the message, leaves the tile and offers no Undo", async () => {
    const item = { ...kept(), gone: true };
    const message = "This link isn't marked as gone. Reload the page.";
    const p = shelfPage(home([item]), () => ({ status: 409, body: { code: "conflict", message } }));
    p.dispatch(p.$("button[data-act=still-works]"), "click");
    await p.settle();
    expect(urls(p)).toEqual(["/links/still-works"]);
    expect(p.$("#handy-error").textContent).toBe(message);
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect((p.$("button[data-act=still-works]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("an Undo of It works answered 409 shows the message", async () => {
    const item = { ...kept(), gone: true };
    const message = "That link was checked again. Reload the page.";
    const p = shelfPage(
      home([item]),
      (s) =>
        s.url === "/links/still-works/undo"
          ? { status: 409, body: { code: "conflict", message } }
          : { status: 200, body: { check: {}, previous: null } },
      [home([{ ...item, gone: false }])],
    );
    p.dispatch(p.$("button[data-act=still-works]"), "click");
    await p.settle();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.$("#handy-error").textContent).toBe(message);
  });

  it("Not handy anymore posts, refreshes, and offers Undo, which sends back the rows it got and refreshes again", async () => {
    const [a, b] = [kept(), kept()];
    const p = shelfPage(
      home([a, b]),
      (s) => (s.url === "/tools/undo" ? { status: 204 } : { status: 200, body: MOVED }),
      [home([b]), home([a, b])],
    );
    p.dispatch(p.$(`[data-id="${a.link.id}"] button[data-act=not-handy]`), "click");
    await p.settle();
    expect(shelfIds(p)).toEqual([b.link.id]);
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[2]).toMatchObject({ url: "/tools/undo", body: { id: a.link.id, ...MOVED } });
    expect(urls(p)).toEqual(["/tools/not-handy", "/", "/tools/undo", "/"]);
    expect(shelfIds(p)).toEqual([a.link.id, b.link.id]);
  });

  it("a refresh re-renders the header with the tiles: emptying swaps it for the empty line, Undo brings it back", async () => {
    const only = kept();
    const p = shelfPage(
      home([only]),
      (s) => (s.url === "/tools/undo" ? { status: 204 } : { status: 200, body: MOVED }),
      [home([]), home([only])],
    );
    p.dispatch(p.$("button[data-act=not-handy]"), "click");
    await p.settle();
    expect(p.document.querySelector("#handy-shelf .handy-head")).toBeNull();
    expect(p.document.querySelector("#handy-shelf .handy-empty a.handy-add")).not.toBeNull();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.document.querySelector("#handy-shelf .handy-head a.handy-add")).not.toBeNull();
    expect(p.document.querySelector("#handy-shelf .handy-empty")).toBeNull();
  });

  it("Done archives through /home/archive and offers Undo through /home/unarchive", async () => {
    const due = kept({}, true);
    const p = shelfPage(home([due]), () => ({ status: 204 }), [home([]), home([due])]);
    p.dispatch(p.$("button[data-act=done]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/home/archive", body: { id: due.link.id } });
    expect(p.$("#undo-bar span").textContent).toBe("Moved out of your list.");
    expect(shelfIds(p)).toEqual([]);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(urls(p)).toEqual(["/home/archive", "/", "/home/unarchive", "/"]);
    expect(shelfIds(p)).toEqual([due.link.id]);
  });

  it("the menu's I'm done with it archives, refreshes the shelf and offers Undo, which brings the tile back", async () => {
    const tool = kept();
    const p = shelfPage(home([tool]), () => ({ status: 204 }), [home([]), home([tool])]);
    p.dispatch(p.$(".card-menu button[data-act=archive]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/home/archive", body: { id: tool.link.id } });
    expect(shelfIds(p)).toEqual([]);
    expect(p.$("#undo-bar span").textContent).toBe("Moved out of your list.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(urls(p)).toEqual(["/home/archive", "/", "/home/unarchive", "/"]);
    expect(shelfIds(p)).toEqual([tool.link.id]);
  });

  it("Yes to a suggestion posts keep: true with no Undo; No posts keep: false with Undo", async () => {
    const offer = suggested();
    const yes = shelfPage(home([], [offer]), () => ({ status: 200, body: MOVED }));
    yes.dispatch(yes.$("button[data-act=suggest-yes]"), "click");
    await yes.settle();
    expect(yes.sent[0]).toMatchObject({
      url: "/tools/suggestion",
      body: { id: offer.link.id, keep: true },
    });
    expect(yes.$("#undo-bar").hidden).toBe(true);
    const no = shelfPage(home([], [offer]), () => ({ status: 200, body: MOVED }));
    no.dispatch(no.$("button[data-act=suggest-no]"), "click");
    await no.settle();
    expect(no.sent[0]).toMatchObject({
      url: "/tools/suggestion",
      body: { id: offer.link.id, keep: false },
    });
    expect(no.$("#undo-bar span").textContent).toBe("Not kept handy.");
  });

  it("a refused action says why, refreshes nothing and offers no Undo", async () => {
    const item = kept();
    const message = "That link's Keep handy state changed. Reload the page.";
    const p = shelfPage(home([item]), () => ({ status: 409, body: { code: "conflict", message } }));
    p.dispatch(p.$("button[data-act=not-handy]"), "click");
    await p.settle();
    expect(urls(p)).toEqual(["/tools/not-handy"]);
    expect(p.$("#handy-error").textContent).toBe(message);
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect(shelfIds(p)).toEqual([item.link.id]);
  });

  it("a refresh that is redirected (the session ended) leaves the shelf as it was and says to reload", async () => {
    const item = kept();
    const p = runPage(home([item]), (s) =>
      s.body === undefined ? { status: 0, type: "opaqueredirect" } : { status: 200, body: MOVED },
    );
    p.dispatch(p.$("button[data-act=not-handy]"), "click");
    await p.settle();
    expect(shelfIds(p)).toEqual([item.link.id]);
    expect(p.$("#handy-error").textContent).toBe(SHELF_STALE);
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
  });

  it("a refresh whose body cannot be read leaves the shelf, says to reload and still offers Undo", async () => {
    const item = kept();
    const p = runPage(home([item]), (s) =>
      s.body === undefined ? { status: 200, textFails: true } : { status: 200, body: MOVED },
    );
    p.dispatch(p.$("button[data-act=not-handy]"), "click");
    await p.settle();
    expect(shelfIds(p)).toEqual([item.link.id]);
    expect(p.$("#handy-error").textContent).toBe(SHELF_STALE);
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
  });

  it("Show all reveals the hidden tiles in place, with no request, and they stay shown after a refresh", async () => {
    const items = Array.from({ length: 10 }, () => kept());
    const p = shelfPage(home(items), () => ({ status: 200, body: MOVED }), [home(items)]);
    p.dispatch(p.$("button[data-act=show-all]"), "click");
    await p.settle();
    expect(p.sent).toEqual([]);
    const hidden = () =>
      [...p.document.querySelectorAll("#handy-shelf .handy-tile")].filter(
        (t) => (t as HTMLElement).hidden,
      );
    expect(hidden()).toHaveLength(0);
    expect(p.document.querySelector("button[data-act=show-all]")).toBeNull();
    p.dispatch(p.$(`[data-id="${items[0]?.link.id}"] button[data-act=not-handy]`), "click");
    await p.settle();
    expect(hidden()).toHaveLength(0);
    expect(p.document.querySelector("button[data-act=show-all]")).toBeNull();
  });

  it("a refresh re-renders Show all's count, and drops it when the shelf falls to 8", async () => {
    const items = Array.from({ length: 10 }, () => kept());
    const p = shelfPage(home(items), () => ({ status: 200, body: MOVED }), [
      home(items.slice(1)),
      home(items.slice(2)),
    ]);
    const showAll = () => p.document.querySelector("#handy-shelf button[data-act=show-all]");
    expect(showAll()?.textContent).toBe("Show all 10");
    p.dispatch(p.$(`[data-id="${items[0]?.link.id}"] button[data-act=not-handy]`), "click");
    await p.settle();
    expect(showAll()?.textContent).toBe("Show all 9");
    p.dispatch(p.$(`[data-id="${items[1]?.link.id}"] button[data-act=not-handy]`), "click");
    await p.settle();
    expect(showAll()).toBeNull();
  });

  it("after a refresh, puts focus back on the same tile, or else the next tile, or else the heading", async () => {
    // Still using: the same tile stays, but its Yes is gone, so focus goes to its title link.
    const due = kept({}, true);
    const yes = shelfPage(home([due]), () => ({ status: 200, body: MOVED }), [
      home([{ ...due, due: false }]),
    ]);
    yes.dispatch(yes.$("button[data-act=still-using]"), "click");
    await yes.settle();
    expect(yes.focused().at(-1)).toBe(yes.$(`[data-id="${due.link.id}"] h3 a`));
    // Not handy anymore: the tile is gone, so focus goes to the next tile and then to Undo.
    const [a, b] = [kept(), kept()];
    const gone = shelfPage(home([a, b]), () => ({ status: 200, body: MOVED }), [home([b])]);
    gone.dispatch(gone.$(`[data-id="${a.link.id}"] button[data-act=not-handy]`), "click");
    await gone.settle();
    expect(gone.focused().slice(-2)).toEqual([
      gone.$(`[data-id="${b.link.id}"] h3 a`),
      gone.$("#undo-bar button"),
    ]);
    // Done on the only tile: nothing is left, so focus goes to the heading and then to Undo.
    const done = shelfPage(home([due]), () => ({ status: 204 }), [home([])]);
    done.dispatch(done.$("button[data-act=done]"), "click");
    await done.settle();
    expect(done.focused().slice(-2)).toEqual([done.$("#handy-title"), done.$("#undo-bar button")]);
  });

  it.each(["archive", "not-handy"])(
    "after the menu's %s and its Undo, focus is on the restored tile's ⋯",
    async (act) => {
      const [a, b] = [kept(), kept()];
      const answer = (s: Post): Answer =>
        s.url === "/tools/not-handy" ? { status: 200, body: MOVED } : { status: 204 };
      const p = shelfPage(home([a, b]), answer, [home([b]), home([a, b])]);
      p.dispatch(p.$(`[data-id="${a.link.id}"] .card-menu button[data-act=${act}]`), "click");
      await p.settle();
      p.dispatch(p.$("#undo-bar button"), "click");
      await p.settle();
      expect(shelfIds(p)).toEqual([a.link.id, b.link.id]);
      expect(p.focused().at(-1)).toBe(p.$(`[data-id="${a.link.id}"] .card-menu summary`));
    },
  );

  it("when the acted-on tile comes back past the 8 cut, reveals the hidden tiles and focuses it", async () => {
    const items = Array.from({ length: 9 }, (_, i) => kept({}, i === 0));
    const first = items[0] as ShelfItem;
    const after = home([...items.slice(1), { ...first, due: false }]);
    const p = shelfPage(home(items), () => ({ status: 200, body: MOVED }), [after]);
    p.dispatch(p.$("button[data-act=still-using]"), "click");
    await p.settle();
    const target = p.focused().at(-1) as HTMLElement;
    expect(target).toBe(p.$(`[data-id="${first.link.id}"] h3 a`));
    expect(target.closest("[hidden]")).toBeNull();
  });

  it("ignores a second click on a tile's button until the shelf refresh settles", async () => {
    const item = kept();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = runPage(home([item]), (s) =>
      s.body === undefined
        ? { status: 200, text: home([]), wait: gate }
        : { status: 200, body: MOVED },
    );
    const button = p.$("button[data-act=not-handy]");
    p.dispatch(button, "click");
    await p.settle();
    p.dispatch(button, "click");
    await p.settle();
    expect(p.sent.filter((s) => s.url === "/tools/not-handy")).toHaveLength(1);
    release();
    await p.settle();
  });

  it("keeps a tile's button off when its refresh was dropped for a newer one, so a third click posts nothing", async () => {
    const [a, b] = [kept(), kept()];
    const gates: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => gates.push(resolve));
    const p = runPage(home([a, b]), (s) =>
      s.body === undefined
        ? { status: 200, text: home([]), wait: hold() }
        : { status: 200, body: MOVED },
    );
    const buttonA = p.$(`[data-id="${a.link.id}"] button[data-act=not-handy]`);
    p.dispatch(buttonA, "click");
    await p.settle();
    p.dispatch(p.$(`[data-id="${b.link.id}"] button[data-act=not-handy]`), "click");
    await p.settle();
    gates[0]?.();
    await p.settle();
    expect((buttonA as HTMLButtonElement).disabled).toBe(true);
    p.dispatch(buttonA, "click");
    await p.settle();
    expect(p.sent.filter((s) => s.url === "/tools/not-handy")).toHaveLength(2);
    gates[1]?.();
    await p.settle();
  });

  it("lets the button work again when the action is refused or the refresh is redirected", async () => {
    const refused = shelfPage(home([kept()]), () => ({ status: 409, body: { message: "no" } }));
    refused.dispatch(refused.$("button[data-act=not-handy]"), "click");
    await refused.settle();
    expect((refused.$("button[data-act=not-handy]") as HTMLButtonElement).disabled).toBe(false);
    const stale = runPage(home([kept()]), (s) =>
      s.body === undefined ? { status: 0, type: "opaqueredirect" } : { status: 200, body: MOVED },
    );
    stale.dispatch(stale.$("button[data-act=not-handy]"), "click");
    await stale.settle();
    expect((stale.$("button[data-act=not-handy]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("drops a refresh that answers after a newer one began, keeping the newer shelf", async () => {
    const [a, b] = [kept({}, true), kept({}, true)];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = home([{ ...a, due: false }, b]);
    const fresh = home([
      { ...a, due: false },
      { ...b, due: false },
    ]);
    const answers: Answer[] = [
      { status: 200, text: stale, wait: gate },
      { status: 200, text: fresh },
    ];
    const p = runPage(home([a, b]), (s) =>
      s.body === undefined ? (answers.shift() as Answer) : { status: 200, body: MOVED },
    );
    p.dispatch(p.$(`[data-id="${a.link.id}"] button[data-act=still-using]`), "click");
    await p.settle();
    p.dispatch(p.$(`[data-id="${b.link.id}"] button[data-act=still-using]`), "click");
    await p.settle();
    release();
    await p.settle();
    expect(p.document.querySelectorAll("#handy-shelf .needs-you")).toHaveLength(0);
  });
});
