import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { CopyView } from "../core/copy-reading.js";
import type { HandyView } from "../core/tools.js";
import type { Link } from "../core/types.js";
import { copyPage } from "./copy-page.js";
import {
  BRING_BACK_ITEM,
  BRING_BACK_UNDO,
  DONE_ITEM,
  PUT_AWAY_ITEM,
  PUT_AWAY_UNDO,
  STALE_UNDO,
} from "./done-link.js";
import { KEEP_ITEM, NOT_HANDY } from "./keep-handy.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";

const NOW = new Date("2026-10-21T12:00:00Z");
const MADE = new Date("2026-10-01T00:00:00Z");
const BACK = { label: "Kitchen", href: "/spaces?tag=kitchen" };
const KEPT: HandyView = { status: "kept", source: "stated", due: false };

const link = (over: Partial<Link> = {}): Link => ({
  id: "7",
  url: "https://a.example/the-page",
  urlKey: "a.example/the-page",
  title: "Quokka",
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-09-01T00:00:00Z"),
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

const READABLE = {
  markdown: "A paragraph.",
  madeAt: MADE,
  finished: true,
  nonce: null,
  images: new Map(),
};

const render = (
  over: Partial<Link> = {},
  handy: HandyView | null = null,
  copy: CopyView["copy"] = READABLE,
) => copyPage({ link: link(over), madeAt: MADE, copy } satisfies CopyView, NOW, BACK, handy);

const dom = (html: string) => parseHTML(html).document;
const shown = (el: Element) => el.closest("[hidden]") === null;
const squash = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();
const visibleActs = (html: string) =>
  [...dom(html).querySelectorAll("#copy-end button[data-act]")]
    .filter(shown)
    .map((b) => [b.getAttribute("data-act"), squash(b)]);

const PUT_AWAY = { state: "archived", putAwayAt: new Date("2026-10-20T00:00:00Z") } as const;
const STALE = { state: "archived", putAwayAt: null } as const;

describe("the end of the saved copy", () => {
  it("asks Finished with this link? and offers the menu's items in the menu's order on an active link", () => {
    const d = dom(render());
    expect(squash(d.querySelector("#copy-end .copy-end-label"))).toBe("Finished with this link?");
    expect(visibleActs(render())).toEqual([
      [DONE_ITEM.act, DONE_ITEM.text],
      [PUT_AWAY_ITEM.act, PUT_AWAY_ITEM.text],
      [KEEP_ITEM.act, KEEP_ITEM.text],
    ]);
    const notHandy = d.querySelector("#copy-end .handy-on button[data-act=not-handy]");
    expect(squash(notHandy)).toBe(NOT_HANDY.text);
    expect(notHandy && shown(notHandy)).toBe(false);
    expect(d.querySelector("#copy-end .primary")).toBeNull();
    for (const b of d.querySelectorAll("#copy-end button")) {
      expect(b.getAttribute("type")).toBe("button");
    }
    const out = d.querySelector("#copy-end-out") as HTMLElement;
    expect(out.hidden).toBe(true);
  });

  it("shows Not handy anymore instead of Keep handy on a kept link", () => {
    const html = render({}, KEPT);
    expect(visibleActs(html)).toEqual([
      [DONE_ITEM.act, DONE_ITEM.text],
      [PUT_AWAY_ITEM.act, PUT_AWAY_ITEM.text],
      [NOT_HANDY.act, NOT_HANDY.text],
    ]);
    const keep = dom(html).querySelector("#copy-end button[data-act=keep]") as HTMLElement;
    expect(keep.hidden).toBe(true);
  });

  it.each([
    ["put away", PUT_AWAY, "Put away"],
    ["stale", STALE, "Stale"],
  ])("a %s link shows Out of your lists, its marker and only Bring it back", (_, over, marker) => {
    const html = render(over);
    const d = dom(html);
    expect((d.querySelector("#copy-end-active") as HTMLElement).hidden).toBe(true);
    expect([...d.querySelectorAll("#copy-end .card-line > span")].map((s) => squash(s))).toEqual([
      "Out of your lists",
      marker,
    ]);
    expect(visibleActs(html)).toEqual([[BRING_BACK_ITEM.act, BRING_BACK_ITEM.text]]);
    expect(d.querySelector("#copy-end-active button[data-act=keep]")).not.toBeNull();
  });

  it.each([
    ["active", {}],
    ["put away", PUT_AWAY],
    ["stale", STALE],
  ])("repeats Back after the row, to the same place as the top one (%s)", (_, over) => {
    const d = dom(render(over));
    const top = d.querySelector(".copy-nav a.back-link");
    const end = d.querySelector("#copy-end a.back-link");
    expect(end?.getAttribute("href")).toBe(BACK.href);
    expect(end?.getAttribute("href")).toBe(top?.getAttribute("href"));
    expect(squash(end)).toBe(squash(top));
    expect(end?.previousElementSibling?.matches("#copy-end-error")).toBe(true);
  });

  it("sits after the article inside the frame, with one grey line, the Undo bar in its live region and no style attributes", () => {
    const d = dom(render());
    const end = d.querySelector("main#copy-frame > #copy-end") as Element;
    const article = d.querySelector("main#copy-frame > article") as Element;
    expect(end).not.toBeNull();
    expect(article.nextElementSibling).toBe(end);
    expect(end.querySelectorAll(".card-line")).toHaveLength(1);
    expect(d.querySelector("[role=status] #undo-bar")).not.toBeNull();
    expect(d.querySelectorAll("[style]")).toHaveLength(0);
    const error = d.querySelector("#copy-end-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(squash(error)).toBe("");
  });

  it.each([
    ["missing", "missing" as const],
    ["unreadable", "unreadable" as const],
  ])("still shows the row when the copy is %s", (_, copy) => {
    const html = render({}, null, copy);
    expect(visibleActs(html).map(([act]) => act)).toEqual(["archive", "put-away", "keep"]);
  });
});

const post = (url: string, body: unknown): Post => ({
  url,
  body,
  redirect: "manual",
  keepalive: undefined,
});
const opened = (id: string): Post => ({
  url: "/links/opened",
  body: { id },
  redirect: "manual",
  keepalive: true,
});

const ACTIVE = { state: "active", putAwayAt: null, snoozedUntil: null } as const;
const STALE_CHANGE = { before: ACTIVE, after: { state: "archived", putAwayAt: null } };
const PUT_CHANGE = {
  before: ACTIVE,
  after: { state: "archived", putAwayAt: "2026-10-21T12:00:00.000Z" },
};
const BRING_CHANGE = {
  before: { state: "archived", putAwayAt: "2026-10-20T00:00:00.000Z", snoozedUntil: null },
  after: { state: "active", putAwayAt: null },
};
const KEPT_ROW = {
  status: "kept",
  source: "stated",
  since: "2026-10-01T10:00:00.000Z",
  answeredAt: null,
  waitDays: 30,
};
const REFUSED = (message: string): Answer => ({ status: 409, body: { code: "conflict", message } });

/** What the row shows now: the group, its marker when out, and the visible buttons. */
const row = (p: ReturnType<typeof runPage>) => {
  const out = shown(p.$("#copy-end-out"));
  return {
    group: out ? `out: ${squash(p.$("#copy-end-out .card-line > :last-child"))}` : "active",
    acts: [...p.document.querySelectorAll("#copy-end button[data-act]")]
      .filter(shown)
      .map((b) => b.getAttribute("data-act")),
  };
};
const click = async (p: ReturnType<typeof runPage>, selector: string) => {
  p.dispatch(p.$(selector), "click");
  await p.settle();
};
const ACT = (act: string) => `#copy-end button[data-act=${act}]`;
const UNDO = "#undo-bar button";
const barText = (p: ReturnType<typeof runPage>) => squash(p.$("#undo-bar span"));
const OUT_LINE = "#copy-end-out .copy-end-line";
const ACTIVE_LINE = "#copy-end-active .copy-end-label";

describe.each([
  ["It's stale", "archive", "/home/archive", STALE_CHANGE, STALE_UNDO, "Stale"],
  ["Put it away", "put-away", "/home/put-away", PUT_CHANGE, PUT_AWAY_UNDO, "Put away"],
])("%s at the end of the copy", (_, act, route, change, undo, marker) => {
  const load = (answer: (s: Post) => Answer = () => ({ status: 200, body: change })) =>
    runPage(render(), (s) => (s.url === "/home/undo-state" ? { status: 204 } : answer(s)));

  it(`posts ${route} alone, shows ${marker}, offers Undo and moves focus to the row, then the bar`, async () => {
    const p = load();
    await click(p, ACT(act));
    expect(p.sent).toEqual([post(route, { id: "7" })]);
    expect(row(p)).toEqual({ group: `out: ${marker}`, acts: ["bring-back"] });
    expect(barText(p)).toBe(`${undo.title} ${undo.text}`);
    expect(p.focused().slice(-2)).toEqual([p.$(OUT_LINE), p.$(UNDO)]);
  });

  it("Undo sends the change it received, shows the active row again and puts focus on it", async () => {
    const p = load();
    await click(p, ACT(act));
    await click(p, UNDO);
    expect(p.sent[1]).toEqual(post("/home/undo-state", { id: "7", change }));
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "put-away", "keep"] });
    expect(p.focused().at(-1)).toBe(p.$(ACTIVE_LINE));
  });

  it("a refusal says why in an alert, changes nothing and offers no Undo", async () => {
    const p = load(() => REFUSED("That link is already done."));
    await click(p, ACT(act));
    expect(squash(p.$("#copy-end-error"))).toBe("That link is already done.");
    expect(p.$("#copy-end-error").getAttribute("role")).toBe("alert");
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "put-away", "keep"] });
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("a refused Undo says why and leaves the row out", async () => {
    const p = runPage(render(), (s) =>
      s.url === "/home/undo-state" ? REFUSED("It changed since.") : { status: 200, body: change },
    );
    await click(p, ACT(act));
    await click(p, UNDO);
    expect(squash(p.$("#copy-end-error"))).toBe("It changed since.");
    expect(row(p).group).toBe(`out: ${marker}`);
  });
});

describe("Bring it back at the end of the copy", () => {
  const load = (answer: (s: Post) => Answer = () => ({ status: 200, body: BRING_CHANGE })) =>
    runPage(render(PUT_AWAY), (s) => (s.url === "/home/undo-state" ? { status: 204 } : answer(s)));

  it("posts /home/bring-back, shows the active row with Keep handy and offers Undo, which restores Put away", async () => {
    const p = load();
    await click(p, ACT("bring-back"));
    expect(p.sent).toEqual([post("/home/bring-back", { id: "7" })]);
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "put-away", "keep"] });
    expect(barText(p)).toBe(BRING_BACK_UNDO.title);
    await click(p, UNDO);
    expect(p.sent[1]).toEqual(post("/home/undo-state", { id: "7", change: BRING_CHANGE }));
    expect(row(p)).toEqual({ group: "out: Put away", acts: ["bring-back"] });
  });

  it("shows the state the route returned: a Bring it back that changed nothing, then Undo, leaves the row active", async () => {
    const noOp = { before: { ...ACTIVE }, after: { state: "active", putAwayAt: null } };
    const p = load(() => ({ status: 200, body: noOp }));
    await click(p, ACT("bring-back"));
    expect(row(p).group).toBe("active");
    await click(p, UNDO);
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "put-away", "keep"] });
  });

  it("takes no other action until its Undo has been answered", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = runPage(render(PUT_AWAY), (s) =>
      s.url === "/home/undo-state"
        ? { status: 204, wait: held }
        : { status: 200, body: BRING_CHANGE },
    );
    await click(p, ACT("bring-back"));
    await click(p, UNDO);
    await click(p, ACT("archive"));
    expect(p.sent.map((s) => s.url)).toEqual(["/home/bring-back", "/home/undo-state"]);
    release();
    await p.settle();
    expect(p.sent.map((s) => s.url)).toEqual(["/home/bring-back", "/home/undo-state"]);
    expect(row(p).group).toBe("out: Put away");
  });
});

describe("Keep handy at the end of the copy", () => {
  const answer = (s: Post): Answer =>
    s.url === "/tools/undo"
      ? { status: 204 }
      : s.url === "/tools/keep"
        ? { status: 200, body: { tool: KEPT_ROW, previous: null } }
        : { status: 200, body: { tool: { ...KEPT_ROW, status: "declined" }, previous: KEPT_ROW } };

  it("Keep handy posts /tools/keep, swaps to Not handy anymore, and Undo swaps back", async () => {
    const p = runPage(render(), answer);
    await click(p, ACT("keep"));
    expect(p.sent).toEqual([post("/tools/keep", { id: "7" })]);
    expect(row(p).acts).toEqual(["archive", "put-away", "not-handy"]);
    expect(barText(p)).toBe("Kept on your Handy shelf.");
    await click(p, UNDO);
    expect(p.sent[1]).toEqual(post("/tools/undo", { id: "7", tool: KEPT_ROW, previous: null }));
    expect(row(p).acts).toEqual(["archive", "put-away", "keep"]);
  });

  it("Not handy anymore posts /tools/not-handy, swaps to Keep handy, and Undo swaps back", async () => {
    const p = runPage(render({}, KEPT), answer);
    await click(p, ACT("not-handy"));
    expect(p.sent).toEqual([post("/tools/not-handy", { id: "7" })]);
    expect(row(p).acts).toEqual(["archive", "put-away", "keep"]);
    expect(barText(p)).toBe("Not handy anymore.");
    await click(p, UNDO);
    expect(row(p).acts).toEqual(["archive", "put-away", "not-handy"]);
  });

  it("a refusal says why in the row's alert", async () => {
    const p = runPage(render(), () => REFUSED("Keep handy changed."));
    await click(p, ACT("keep"));
    expect(squash(p.$("#copy-end-error"))).toBe("Keep handy changed.");
    expect(row(p).acts).toEqual(["archive", "put-away", "keep"]);
  });
});

it("takes one action at a time: while Put it away waits, nothing else is sent", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const p = runPage(render(), () => ({ status: 200, body: PUT_CHANGE, wait: held }));
  p.dispatch(p.$(ACT("put-away")), "click");
  p.dispatch(p.$(ACT("keep")), "click");
  p.dispatch(p.$(ACT("archive")), "click");
  await p.settle();
  expect(p.sent).toEqual([post("/home/put-away", { id: "7" })]);
  release();
  await p.settle();
  expect(p.sent).toHaveLength(1);
});

describe("opening the link from the end-of-copy page", () => {
  const OPEN = "a[data-open]";
  const load = (over: Partial<Link>, answer: (s: Post) => Answer = () => ({ status: 204 })) =>
    runPage(render(over), answer);

  it("brings a put-away row back to the active row, with no bar and no focus moved", async () => {
    const p = load(PUT_AWAY);
    await click(p, OPEN);
    expect(p.sent).toEqual([opened("7")]);
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "put-away", "keep"] });
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect(p.focused()).toEqual([]);
  });

  it("leaves a Stale row Stale", async () => {
    const p = load(STALE);
    await click(p, OPEN);
    expect(row(p)).toEqual({ group: "out: Stale", acts: ["bring-back"] });
  });

  it.each([
    ["a refusal", { status: 409, body: { message: "no" } }],
    ["a failed request", { status: 204, networkFails: true }],
  ] as [string, Answer][])("leaves a put-away row put away after %s", async (_, answer) => {
    const p = load(PUT_AWAY, () => answer);
    await click(p, OPEN);
    expect(row(p)).toEqual({ group: "out: Put away", acts: ["bring-back"] });
  });

  it("changes nothing on an active page", async () => {
    const p = load({});
    await click(p, OPEN);
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "put-away", "keep"] });
    expect(p.focused()).toEqual([]);
  });

  it("Put it away, then Open: the row is active, and the Undo that follows is refused and leaves it active", async () => {
    const p = runPage(render(), (s) =>
      s.url === "/home/put-away"
        ? { status: 200, body: PUT_CHANGE }
        : s.url === "/links/opened"
          ? { status: 204 }
          : REFUSED("It changed since."),
    );
    await click(p, ACT("put-away"));
    await click(p, OPEN);
    expect(row(p).group).toBe("active");
    await click(p, UNDO);
    expect(squash(p.$("#copy-end-error"))).toBe("It changed since.");
    expect(row(p).group).toBe("active");
  });
});
