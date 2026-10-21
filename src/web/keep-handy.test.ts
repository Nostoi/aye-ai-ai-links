import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HandyView } from "../core/tools.js";
import type { Link } from "../core/types.js";
import { allPage } from "./all-page.js";
import { handyControl, keepHandyScript } from "./keep-handy.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { page } from "./page.js";
import { searchPage } from "./pages.js";
import { spacePage } from "./space-page.js";
import { CARD_FETCH } from "./tell-why.js";

const link = (over: Partial<Link> = {}): Link => ({
  id: "7",
  url: "https://school.example/attendance",
  urlKey: "school.example/attendance",
  title: "Attendance",
  summary: null,
  why: null,
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
const view = (status: HandyView["status"]): HandyView => ({ status, source: "stated", due: false });

/** What the control shows: the visible part's text, or null for no control. */
const shown = (html: string) => {
  const control = parseHTML(`<div>${html}</div>`).document.querySelector("[data-handy]");
  if (!control) return null;
  const keep = control.querySelector("button[data-act=keep]") as HTMLElement;
  const on = control.querySelector(".handy-on") as HTMLElement;
  expect(keep.hidden).toBe(!on.hidden);
  return (keep.hidden ? on.textContent : keep.textContent)?.replace(/\s+/g, " ").trim();
};

describe("handyControl", () => {
  it("reads Keep handy for an ordinary, suggested or declined link, and Handy · Not handy anymore once kept", () => {
    expect(shown(handyControl(link(), null))).toBe("Keep handy");
    expect(shown(handyControl(link(), undefined))).toBe("Keep handy");
    expect(shown(handyControl(link(), view("suggested")))).toBe("Keep handy");
    expect(shown(handyControl(link(), view("declined")))).toBe("Keep handy");
    expect(shown(handyControl(link(), view("kept")))).toBe("Handy · Not handy anymore");
  });

  it("gives an archived link no control: it can't be on the shelf", () => {
    expect(handyControl(link({ state: "archived" }), view("kept"))).toBe("");
    expect(handyControl(link({ state: "archived" }), null)).toBe("");
  });

  it("uses the small text buttons, which are 44px tall", () => {
    const control = parseHTML(handyControl(link(), null)).document.querySelector("[data-handy]");
    expect(control?.classList.contains("small-actions")).toBe(true);
    for (const b of control?.querySelectorAll("button") ?? []) {
      expect(b.getAttribute("type")).toBe("button");
    }
  });
});

const MOVED = {
  tool: {
    status: "declined",
    source: "stated",
    since: "2026-10-16T10:00:00.000Z",
    answeredAt: null,
    waitDays: 30,
  },
  previous: {
    status: "kept",
    source: "stated",
    since: "2026-10-01T10:00:00.000Z",
    answeredAt: null,
    waitDays: 30,
  },
};

/** A list of one card with the control, its error line and the script, on a page with Undo. */
function load(kept: boolean, answer: (sent: Post) => Answer) {
  const html = page(
    "Test",
    `<p id="list-error" role="alert"></p>
<ul id="list"><li data-id="7">${handyControl(link(), kept ? view("kept") : null)}</li></ul>
<script>
${CARD_FETCH}
${keepHandyScript("list", "list-error")}
</script>`,
    { undo: true },
  );
  return runPage(html, answer);
}
/** linkedom doesn't track focus, so record each element `focus()` is called on. */
function watchFocus(p: ReturnType<typeof runPage>) {
  let owner: object = p.$("button");
  while (!Object.hasOwn(owner, "focus")) owner = Object.getPrototypeOf(owner);
  const focused: Element[] = [];
  vi.spyOn(owner as { focus(): void }, "focus").mockImplementation(function (this: Element) {
    focused.push(this);
  });
  return () => focused.at(-1);
}
afterEach(() => vi.restoreAllMocks());
const state = (p: ReturnType<typeof runPage>) =>
  p.$("button[data-act=keep]").hidden ? "kept" : "not kept";

describe("the Keep handy script", () => {
  it("Keep handy posts /tools/keep, shows Handy · Not handy anymore and offers Undo, which sends back the rows it got", async () => {
    const p = load(false, (s) =>
      s.url === "/tools/undo"
        ? { status: 204 }
        : { status: 200, body: { tool: MOVED.previous, previous: null } },
    );
    const lastFocused = watchFocus(p);
    p.dispatch(p.$("button[data-act=keep]"), "click");
    await p.settle();
    expect(p.sent).toEqual([
      { url: "/tools/keep", body: { id: "7" }, redirect: "manual", keepalive: undefined },
    ]);
    expect(state(p)).toBe("kept");
    expect(p.$("#undo-bar span").textContent).toBe("Kept on your Handy shelf.");
    expect(lastFocused()).toBe(p.$("#undo-bar button"));
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toEqual({
      url: "/tools/undo",
      body: { id: "7", tool: MOVED.previous, previous: null },
      redirect: "manual",
      keepalive: undefined,
    });
    expect(state(p)).toBe("not kept");
    expect(lastFocused()).toBe(p.$("button[data-act=keep]"));
  });

  it("Not handy anymore posts /tools/not-handy, shows Keep handy and offers Undo, which sends back the rows it got", async () => {
    const p = load(true, (s) =>
      s.url === "/tools/undo" ? { status: 204 } : { status: 200, body: MOVED },
    );
    const lastFocused = watchFocus(p);
    p.dispatch(p.$("button[data-act=not-handy]"), "click");
    await p.settle();
    expect(state(p)).toBe("not kept");
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
    expect(lastFocused()).toBe(p.$("#undo-bar button"));
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toEqual({
      url: "/tools/undo",
      body: { id: "7", tool: MOVED.tool, previous: MOVED.previous },
      redirect: "manual",
      keepalive: undefined,
    });
    expect(state(p)).toBe("kept");
    expect(lastFocused()).toBe(p.$("button[data-act=not-handy]"));
  });

  it.each([
    [
      "a 409",
      {
        status: 409,
        body: {
          code: "conflict",
          message: "That link's Keep handy state changed. Reload the page.",
        },
      },
      "That link's Keep handy state changed. Reload the page.",
    ],
    [
      "a redirect to the sign-in page",
      { status: 0, type: "opaqueredirect" },
      "That did not work. Reload the page and try again.",
    ],
    [
      "a 200 with no rows",
      { status: 200, body: {} },
      "That did not work. Reload the page and try again.",
    ],
  ])(
    "leaves the control as it was, offers no Undo and says why on %s",
    async (_, answer, message) => {
      const p = load(true, () => answer as Answer);
      const lastFocused = watchFocus(p);
      p.dispatch(p.$("button[data-act=not-handy]"), "click");
      await p.settle();
      expect(state(p)).toBe("kept");
      expect(p.$("#undo-bar").hidden).toBe(true);
      expect(p.$("#list-error").textContent).toBe(message);
      expect(lastFocused()).toBe(p.$("button[data-act=not-handy]"));
    },
  );

  it("keeps Keep handy showing and says why when Undo is refused", async () => {
    const p = load(true, (s) =>
      s.url === "/tools/undo"
        ? { status: 409, body: { message: "Changed." } }
        : { status: 200, body: MOVED },
    );
    p.dispatch(p.$("button[data-act=not-handy]"), "click");
    await p.settle();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(state(p)).toBe("not kept");
    expect(p.$("#list-error").textContent).toBe("Changed.");
  });

  it("sends nothing for a second click while the first is still waiting", async () => {
    const p = load(false, () => ({ status: 200, body: { tool: MOVED.previous, previous: null } }));
    const keep = p.$("button[data-act=keep]");
    p.dispatch(keep, "click");
    p.dispatch(keep, "click");
    await p.settle();
    expect(p.sent).toHaveLength(1);
  });
});

const KEPT_ROW = MOVED.previous;
const keepAnswer = (s: Post): Answer =>
  s.url === "/tools/undo"
    ? { status: 204 }
    : s.url === "/tools/keep"
      ? { status: 200, body: { tool: KEPT_ROW, previous: null } }
      : { status: 200, body: MOVED };
/** Which of the card's Keep handy rows show, menu and visible control alike. */
const rows = (p: ReturnType<typeof runPage>) =>
  [
    ...p.document.querySelectorAll(
      "[data-id='7'] button[data-act=keep], [data-id='7'] button[data-act=not-handy]",
    ),
  ].map(
    (b) =>
      `${b.closest(".card-menu") ? "menu" : "control"} ${b.textContent}${b.closest("[hidden]") ? " (hidden)" : ""}`,
  );
const LATER = new Date("2026-10-17T00:00:00Z");
const allLinks = (kept: boolean) =>
  allPage({
    order: "newest",
    links: [link()],
    older: null,
    catalog: [],
    images: new Map(),
    handy: new Map([["7", kept ? view("kept") : null]]),
    now: LATER,
    done: false,
  });
const keepSearch = (kept: boolean) =>
  searchPage({
    query: "",
    links: [link()],
    now: LATER,
    handy: new Map([["7", kept ? view("kept") : null]]),
    keep: true,
  });

describe("Keep handy in the ⋯ menu", () => {
  it("All links, space pages and search carry it in the menu only, with no Keep handy control on the card", () => {
    const space = spacePage({
      tag: {
        key: "k",
        name: "K",
        kind: "topic",
        kindSource: "stated",
        color: null,
        pinned: true,
        description: null,
        projectStatus: null,
      },
      catalog: [],
      links: [link()],
      older: null,
      images: new Map(),
      handy: new Map(),
      now: LATER,
      done: false,
    });
    const search = searchPage({ query: "", links: [link()], now: LATER });
    for (const html of [allLinks(false), space, search]) {
      const d = parseHTML(html).document;
      expect(d.querySelector("[data-handy]")).toBeNull();
      expect(d.querySelector(".card-menu button[data-act=keep]")?.textContent).toBe("Keep handy");
    }
  });

  it("Keep handy posts /tools/keep, swaps the row to Not handy anymore, offers Undo, and Undo swaps it back", async () => {
    const p = runPage(allLinks(false), keepAnswer);
    const menu = p.$("[data-id='7'] details.card-menu") as HTMLDetailsElement;
    menu.open = true;
    p.dispatch(p.$(".card-menu button[data-act=keep]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/tools/keep", body: { id: "7" } });
    expect(menu.open).toBe(false);
    expect(rows(p)).toEqual(["menu Keep handy (hidden)", "menu Not handy anymore"]);
    expect(p.$("#undo-bar span").textContent).toBe("Kept on your Handy shelf.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({
      url: "/tools/undo",
      body: { id: "7", tool: KEPT_ROW, previous: null },
    });
    expect(rows(p)).toEqual(["menu Keep handy", "menu Not handy anymore (hidden)"]);
  });

  it("Not handy anymore posts /tools/not-handy, swaps the row back and offers Undo", async () => {
    const p = runPage(allLinks(true), keepAnswer);
    p.dispatch(p.$(".card-menu button[data-act=not-handy]"), "click");
    await p.settle();
    expect(p.sent[0]).toMatchObject({ url: "/tools/not-handy", body: { id: "7" } });
    expect(rows(p)).toEqual(["menu Keep handy", "menu Not handy anymore (hidden)"]);
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
  });

  it("Keep handy from the menu puts focus on the card's ⋯, and so does its Undo", async () => {
    const p = runPage(allLinks(false), keepAnswer);
    const summary = p.$("[data-id='7'] .card-menu summary");
    p.dispatch(p.$(".card-menu button[data-act=keep]"), "click");
    await p.settle();
    expect(p.focused().slice(-2)).toEqual([summary, p.$("#undo-bar button")]);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.focused().at(-1)).toBe(summary);
  });

  it("a refusal from the menu leaves the rows as they were and says why", async () => {
    const p = runPage(allLinks(false), () => ({
      status: 409,
      body: { code: "conflict", message: "Changed." },
    }));
    p.dispatch(p.$(".card-menu button[data-act=keep]"), "click");
    await p.settle();
    expect(rows(p)).toEqual(["menu Keep handy", "menu Not handy anymore (hidden)"]);
    expect(p.$("#all-error").textContent).toBe("Changed.");
    expect(p.$("#undo-bar").hidden).toBe(true);
  });
});

describe("Keep handy on the search that Add opens (keep=1)", () => {
  const BOTH_KEPT = [
    "menu Keep handy (hidden)",
    "menu Not handy anymore",
    "control Keep handy (hidden)",
    "control Not handy anymore",
  ];
  const NEITHER_KEPT = [
    "menu Keep handy",
    "menu Not handy anymore (hidden)",
    "control Keep handy",
    "control Not handy anymore (hidden)",
  ];

  it("sends one request while one is waiting, whichever control is pressed second", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = runPage(keepSearch(false), (s) => ({ ...keepAnswer(s), wait }));
    p.dispatch(p.$("[data-handy] button[data-act=keep]"), "click");
    p.dispatch(p.$(".card-menu button[data-act=keep]"), "click");
    release();
    await p.settle();
    expect(p.sent.map((s) => s.url)).toEqual(["/tools/keep"]);
  });

  it("keeps the visible control as well as the menu row", () => {
    const d = parseHTML(keepSearch(false)).document;
    expect(d.querySelector("[data-id='7'] [data-handy] button[data-act=keep]")).not.toBeNull();
    expect(d.querySelector("[data-id='7'] .card-menu button[data-act=keep]")).not.toBeNull();
  });

  it.each([".card-menu", "[data-handy]"])(
    "the control and the menu agree after Keep handy from %s, and after its Undo",
    async (where) => {
      const p = runPage(keepSearch(false), keepAnswer);
      p.dispatch(p.$(`${where} button[data-act=keep]`), "click");
      await p.settle();
      expect(rows(p)).toEqual(BOTH_KEPT);
      p.dispatch(p.$("#undo-bar button"), "click");
      await p.settle();
      expect(rows(p)).toEqual(NEITHER_KEPT);
    },
  );

  it.each([".card-menu", "[data-handy]"])(
    "the control and the menu agree after Not handy anymore from %s, and after a refusal",
    async (where) => {
      const p = runPage(keepSearch(true), keepAnswer);
      p.dispatch(p.$(`${where} button[data-act=not-handy]`), "click");
      await p.settle();
      expect(rows(p)).toEqual(NEITHER_KEPT);
      const refused = runPage(keepSearch(true), () => ({ status: 409, body: { message: "No." } }));
      refused.dispatch(refused.$(`${where} button[data-act=not-handy]`), "click");
      await refused.settle();
      expect(rows(refused)).toEqual(BOTH_KEPT);
      expect(refused.$("#results-error").textContent).toBe("No.");
    },
  );
});
