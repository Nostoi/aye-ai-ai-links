import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { ShelfItem, ToolItem } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { handyShelf, SHELF_SIZE, SUGGESTION_SIZE } from "./handy-shelf.js";
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
});
const suggested = (over: Partial<Link> = {}): ToolItem => ({
  link: link(over),
  tool: row("suggested"),
});
const render = (items: ShelfItem[], suggestions: ToolItem[] = [], catalog: Tag[] = []) =>
  handyShelf({ items, suggestions, catalog });
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
    expect(dom(html).querySelector("button[data-act=show-all]")?.textContent).toBe("Show all");
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
    expect(tile?.querySelector(".card-site")?.textContent).toBe("School, school.example");
    expect(tile?.className).toContain("space-clay");
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

  it("gives every kept tile a menu with Not handy anymore, and a suggestion none", () => {
    const html = render([kept({ title: "Attendance" })], [suggested()]);
    const [tool, guess] = tiles(html);
    const menu = tool?.querySelector("details.tile-menu");
    expect(menu?.querySelector("summary .visually-hidden")?.textContent).toBe(
      "More for Attendance",
    );
    expect(menu?.querySelector("button[data-act=not-handy]")?.textContent).toBe(
      "Not handy anymore",
    );
    expect(guess?.querySelector("details")).toBeNull();
  });

  it("puts at most 2 suggestions at the end, in the order given (newest first), as faded guesses asking Keep handy?, outside the 8", () => {
    const items = Array.from({ length: 9 }, () => kept());
    const offers = [suggested(), suggested(), suggested()];
    const html = render(items, offers);
    expect(SUGGESTION_SIZE).toBe(2);
    expect(ids(tiles(html))).toEqual([...items, ...offers.slice(0, 2)].map((i) => i.link.id));
    expect(dom(html).querySelector(`[data-id="${offers[2]?.link.id}"]`)).toBeNull();
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

  it("offers Add, a search over the owner's links", () => {
    const add = dom(render([kept()])).querySelector("#handy-shelf a.button");
    expect(add?.textContent).toBe("Add");
    expect(add?.getAttribute("href")).toBe("/search?q=");
  });

  it("shows one line with Add when there is nothing on it and nothing suggested", () => {
    const d = dom(render([]));
    expect(d.querySelector(".handy-row")).toBeNull();
    expect(d.querySelector("#handy-shelf p")?.textContent).toBe("Keep links you use often here");
    expect(d.querySelector("#handy-shelf a.button")?.getAttribute("href")).toBe("/search?q=");
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
