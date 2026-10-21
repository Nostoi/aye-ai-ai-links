import { describe, expect, it } from "vitest";
import type { GoneView } from "../core/link-check.js";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { searchPage } from "./pages.js";
import { spacePage } from "./space-page.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const SEPTEMBER = new Date("2026-09-10T12:00:00Z");
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
const GONE: GoneView = {
  since: new Date("2026-10-10T00:00:00Z"),
  checkedAt: new Date("2026-10-13T00:00:00Z"),
};
const link = (id: string, savedAt = NOW): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  why: { text: `because ${id}`, source: "stated" },
  tags: [
    { key: "kitchen", name: "Kitchen", source: "stated", kind: "topic", kindSource: "stated" },
  ],
  savedAt,
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});
const post = (url: string, body: unknown): Post => ({
  url,
  body,
  redirect: "manual",
  keepalive: undefined,
});
const allLinks = (
  links: Link[],
  {
    older = null,
    later = false,
    gone = [],
  }: { older?: string | null; later?: boolean; gone?: string[] } = {},
) =>
  allPage({
    order: "newest",
    links,
    older,
    catalog: [KITCHEN],
    images: new Map(),
    handy: new Map(),
    gone: new Map(gone.map((id) => [id, GONE])),
    now: NOW,
    done: false,
    later,
  });
const click = async (p: ReturnType<typeof runPage>, selector: string) => {
  p.dispatch(p.$(selector), "click");
  await p.settle();
};
const MENU_DONE = (id: string) => `[data-id='${id}'] .card-menu button[data-act=archive]`;
const GONE_DONE = (id: string) => `[data-id='${id}'] [data-gone] button[data-act=gone-done]`;

describe.each([
  ["the ⋯ menu's It's stale", MENU_DONE],
  ["the gone line's It's stale", GONE_DONE],
])("%s on All links", (_, button) => {
  const load = (answer: (s: Post) => Answer = () => ({ status: 204 })) =>
    runPage(allLinks([link("7"), link("8"), link("9", SEPTEMBER)], { gone: ["7"] }), answer);

  it("posts /home/archive, hides the card, focuses the next card's ⋯ and offers Undo", async () => {
    const p = load();
    const menu = p.$("[data-id='7'] details.card-menu") as HTMLDetailsElement;
    if (button === MENU_DONE) menu.open = true;
    await click(p, button("7"));
    expect(p.sent).toEqual([post("/home/archive", { id: "7" })]);
    expect(p.$("[data-id='7']").hidden).toBe(true);
    if (button === MENU_DONE) expect(menu.open).toBe(false);
    expect(p.focused().at(-2)).toBe(p.$("[data-id='8'] .card-menu summary"));
    expect(p.$("#undo-bar span").textContent).toBe(
      "Let go. You won't see it again unless you search for it.",
    );
  });

  it("Undo posts /home/unarchive and shows the card again", async () => {
    const p = load();
    await click(p, button("7"));
    await click(p, "#undo-bar button");
    expect(p.sent[1]).toEqual(post("/home/unarchive", { id: "7" }));
    expect(p.$("[data-id='7']").hidden).toBe(false);
    expect(p.$("#all-error").textContent).toBe("");
  });

  it("a refused Undo says why and leaves the card hidden", async () => {
    const p = load((s) =>
      s.url === "/home/unarchive"
        ? { status: 409, body: { code: "conflict", message: "Changed since." } }
        : { status: 204 },
    );
    await click(p, button("7"));
    await click(p, "#undo-bar button");
    expect(p.$("[data-id='7']").hidden).toBe(true);
    expect(p.$("#all-error").textContent).toBe("Changed since.");
  });

  it("a refusal says why, leaves the card shown and offers no Undo", async () => {
    const p = load(() => ({ status: 409, body: { code: "conflict", message: "Already done." } }));
    await click(p, button("7"));
    expect(p.$("[data-id='7']").hidden).toBe(false);
    expect(p.$("#all-error").textContent).toBe("Already done.");
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("sends one request for a second click while the first is waiting", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = load(() => ({ status: 204, wait }));
    p.dispatch(p.$(button("7")), "click");
    p.dispatch(p.$(button("7")), "click");
    release();
    await p.settle();
    expect(p.sent).toEqual([post("/home/archive", { id: "7" })]);
  });
});

describe.each([
  ["the ⋯ menu", MENU_DONE],
  ["the gone line", GONE_DONE],
])("It's stale from %s on a month's only card", (_, button) => {
  it("hides the month, focuses the next month's card, and Undo shows both again", async () => {
    const p = runPage(allLinks([link("7"), link("9", SEPTEMBER)], { gone: ["7"] }));
    const month = p.$("[data-id='7']").closest("section.month") as HTMLElement;
    await click(p, button("7"));
    expect(month.hidden).toBe(true);
    expect(p.$("[data-id='9']").closest("section.month")?.hasAttribute("hidden")).toBe(false);
    expect(p.focused().at(-2)).toBe(p.$("[data-id='9'] .card-menu summary"));
    await click(p, "#undo-bar button");
    expect(month.hidden).toBe(false);
    expect(p.$("[data-id='7']").hidden).toBe(false);
  });

  it("works on a card Show older appended, in a month of its own", async () => {
    const first = allLinks([link("1")], { older: "c1" });
    const next = allLinks([link("9", SEPTEMBER)], { later: true, gone: ["9"] });
    const p = runPage(first, (s) =>
      s.body === undefined ? { status: 200, text: next } : { status: 204 },
    );
    await click(p, "#older");
    await click(p, button("9"));
    expect(p.sent.at(-1)).toEqual(post("/home/archive", { id: "9" }));
    expect(p.$("[data-id='9']").closest("section.month")?.hasAttribute("hidden")).toBe(true);
    const h1 = p.$("h1");
    expect(p.focused().at(-2)).toBe(h1);
  });
});

describe("It's stale from the ⋯ menu on space pages and search", () => {
  it.each([
    [
      "a space page",
      () =>
        spacePage({
          tag: KITCHEN,
          catalog: [KITCHEN],
          links: [link("7"), link("8")],
          older: null,
          images: new Map(),
          handy: new Map(),
          now: NOW,
          done: false,
        }),
      "#space-error",
    ],
    [
      "search",
      () => searchPage({ query: "", links: [link("7"), link("8")], now: NOW }),
      "#results-error",
    ],
  ])("on %s hides the card and Undo shows it again", async (_, html, error) => {
    const p = runPage(html());
    await click(p, MENU_DONE("7"));
    expect(p.sent).toEqual([post("/home/archive", { id: "7" })]);
    expect(p.$("[data-id='7']").hidden).toBe(true);
    expect(p.focused().at(-2)).toBe(p.$("[data-id='8'] .card-menu summary"));
    await click(p, "#undo-bar button");
    expect(p.$("[data-id='7']").hidden).toBe(false);
    expect(p.$(error).textContent).toBe("");
  });
});
