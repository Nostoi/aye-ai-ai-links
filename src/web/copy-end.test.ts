import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { CopyView } from "../core/copy-reading.js";
import type { HandyView } from "../core/tools.js";
import type { Link } from "../core/types.js";
import { copyPage } from "./copy-page.js";
import { ARCHIVE_ITEM, ARCHIVE_UNDO, BRING_BACK_ITEM, BRING_BACK_UNDO } from "./done-link.js";
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

const ARCHIVED = { state: "archived" } as const;

describe("the end of the saved copy", () => {
  it("asks Finished with this link? and offers the menu's items in the menu's order on an active link", () => {
    const d = dom(render());
    expect(squash(d.querySelector("#copy-end .copy-end-label"))).toBe("Finished with this link?");
    expect(visibleActs(render())).toEqual([
      [ARCHIVE_ITEM.act, ARCHIVE_ITEM.text],
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
      [ARCHIVE_ITEM.act, ARCHIVE_ITEM.text],
      [NOT_HANDY.act, NOT_HANDY.text],
    ]);
    const keep = dom(html).querySelector("#copy-end button[data-act=keep]") as HTMLElement;
    expect(keep.hidden).toBe(true);
  });

  it("an archived link shows only its marker and Bring it back", () => {
    const html = render(ARCHIVED);
    const d = dom(html);
    expect((d.querySelector("#copy-end-active") as HTMLElement).hidden).toBe(true);
    expect([...d.querySelectorAll("#copy-end .card-line > span")].map((s) => squash(s))).toEqual([
      "Archived",
    ]);
    expect(visibleActs(html)).toEqual([[BRING_BACK_ITEM.act, BRING_BACK_ITEM.text]]);
    expect(d.querySelector("#copy-end-active button[data-act=keep]")).not.toBeNull();
  });

  it.each([
    ["active", {}],
    ["archived", ARCHIVED],
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
    expect(visibleActs(html).map(([act]) => act)).toEqual(["archive", "keep"]);
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

const ACTIVE = { state: "active", snoozedUntil: null } as const;
const ARCHIVE_CHANGE = { before: ACTIVE, after: { state: "archived" } };
const BRING_CHANGE = {
  before: { state: "archived", snoozedUntil: null },
  after: { state: "active" },
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

describe("Archive at the end of the copy", () => {
  const act = "archive";
  const route = "/home/archive";
  const change = ARCHIVE_CHANGE;
  const undo = ARCHIVE_UNDO;
  const marker = "Archived";
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
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "keep"] });
    expect(p.focused().at(-1)).toBe(p.$(ACTIVE_LINE));
  });

  it("a refusal says why in an alert, changes nothing and offers no Undo", async () => {
    const p = load(() => REFUSED("This link is already archived."));
    await click(p, ACT(act));
    expect(squash(p.$("#copy-end-error"))).toBe("This link is already archived.");
    expect(p.$("#copy-end-error").getAttribute("role")).toBe("alert");
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "keep"] });
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
    runPage(render(ARCHIVED), (s) => (s.url === "/home/undo-state" ? { status: 204 } : answer(s)));

  it("posts /home/bring-back, shows the active row with Keep handy and offers Undo, which restores Archived", async () => {
    const p = load();
    await click(p, ACT("bring-back"));
    expect(p.sent).toEqual([post("/home/bring-back", { id: "7" })]);
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "keep"] });
    expect(barText(p)).toBe(BRING_BACK_UNDO.title);
    await click(p, UNDO);
    expect(p.sent[1]).toEqual(post("/home/undo-state", { id: "7", change: BRING_CHANGE }));
    expect(row(p)).toEqual({ group: "out: Archived", acts: ["bring-back"] });
  });

  it("shows the state the route returned: a Bring it back that changed nothing, then Undo, leaves the row active", async () => {
    const noOp = { before: { ...ACTIVE }, after: { state: "active" } };
    const p = load(() => ({ status: 200, body: noOp }));
    await click(p, ACT("bring-back"));
    expect(row(p).group).toBe("active");
    await click(p, UNDO);
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "keep"] });
  });

  it("takes no other action until its Undo has been answered", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = runPage(render(ARCHIVED), (s) =>
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
    expect(row(p).group).toBe("out: Archived");
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
    expect(row(p).acts).toEqual(["archive", "not-handy"]);
    expect(barText(p)).toBe("Kept on your Handy shelf.");
    await click(p, UNDO);
    expect(p.sent[1]).toEqual(post("/tools/undo", { id: "7", tool: KEPT_ROW, previous: null }));
    expect(row(p).acts).toEqual(["archive", "keep"]);
  });

  it("Not handy anymore posts /tools/not-handy, swaps to Keep handy, and Undo swaps back", async () => {
    const p = runPage(render({}, KEPT), answer);
    await click(p, ACT("not-handy"));
    expect(p.sent).toEqual([post("/tools/not-handy", { id: "7" })]);
    expect(row(p).acts).toEqual(["archive", "keep"]);
    expect(barText(p)).toBe("Not handy anymore.");
    await click(p, UNDO);
    expect(row(p).acts).toEqual(["archive", "not-handy"]);
  });

  it("a refusal says why in the row's alert", async () => {
    const p = runPage(render(), () => REFUSED("Keep handy changed."));
    await click(p, ACT("keep"));
    expect(squash(p.$("#copy-end-error"))).toBe("Keep handy changed.");
    expect(row(p).acts).toEqual(["archive", "keep"]);
  });
});

it("takes one action at a time: while Archive waits, nothing else is sent", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const p = runPage(render(), () => ({ status: 200, body: ARCHIVE_CHANGE, wait: held }));
  p.dispatch(p.$(ACT("archive")), "click");
  p.dispatch(p.$(ACT("keep")), "click");
  p.dispatch(p.$(ACT("archive")), "click");
  await p.settle();
  expect(p.sent).toEqual([post("/home/archive", { id: "7" })]);
  release();
  await p.settle();
  expect(p.sent).toHaveLength(1);
});

describe("opening the link from the end-of-copy page", () => {
  const OPEN = "a[data-open]";
  const load = (over: Partial<Link>, answer: (s: Post) => Answer = () => ({ status: 204 })) =>
    runPage(render(over), answer);

  it("leaves an archived row archived, with no bar and no focus moved", async () => {
    const p = load(ARCHIVED);
    await click(p, OPEN);
    expect(p.sent).toEqual([opened("7")]);
    expect(row(p)).toEqual({ group: "out: Archived", acts: ["bring-back"] });
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect(p.focused()).toEqual([]);
  });

  it.each([
    ["a refusal", { status: 409, body: { message: "no" } }],
    ["a failed request", { status: 204, networkFails: true }],
  ] as [string, Answer][])("leaves an archived row archived after %s", async (_, answer) => {
    const p = load(ARCHIVED, () => answer);
    await click(p, OPEN);
    expect(row(p)).toEqual({ group: "out: Archived", acts: ["bring-back"] });
  });

  it("changes nothing on an active page", async () => {
    const p = load({});
    await click(p, OPEN);
    expect(row(p)).toEqual({ group: "active", acts: ["archive", "keep"] });
    expect(p.focused()).toEqual([]);
  });

  it("Archive, then Open: the row stays archived, and Undo still brings it back", async () => {
    const p = runPage(render(), (s) =>
      s.url === "/home/archive" ? { status: 200, body: ARCHIVE_CHANGE } : { status: 204 },
    );
    await click(p, ACT("archive"));
    await click(p, OPEN);
    expect(row(p).group).toBe("out: Archived");
    await click(p, UNDO);
    expect(row(p).group).toBe("active");
  });
});

describe("the end of the copy, slow to answer (#314)", () => {
  const CASES: [string, string, () => string, Answer["body"], string][] = [
    ["Archive", "archive", () => render(), ARCHIVE_CHANGE, "Archiving…"],
    ["Keep handy", "keep", () => render(), { tool: KEPT_ROW, previous: null }, "Keeping handy…"],
    ["Bring it back", "bring-back", () => render(ARCHIVED), BRING_CHANGE, "Bringing back…"],
    [
      "Not handy anymore",
      "not-handy",
      () => render({}, KEPT),
      { tool: { ...KEPT_ROW, status: "declined" }, previous: KEPT_ROW },
      "Taking it off…",
    ],
  ];

  it.each(CASES)(
    "%s: dims the row, not the frame, and says its working word after 300ms",
    async (_n, act, html, body, word) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const p = runPage(html(), () => ({ status: 200, body, wait: gate }));
      const button = p.$(ACT(act));
      const rest = button.textContent;
      const rowEl = button.closest(".copy-end-acts") as Element;
      p.dispatch(button, "click");
      await p.settle();
      expect(p.timers.pending(300)).toBe(1);
      expect(rowEl.hasAttribute("data-busy")).toBe(false);
      p.timers.fire();
      expect(rowEl.hasAttribute("data-busy")).toBe(true);
      expect(p.$("#copy-frame").hasAttribute("data-busy")).toBe(false);
      expect(button.textContent).toBe(word);
      release();
      await p.settle();
      expect(p.document.querySelector("[data-busy]")).toBeNull();
      expect(button.textContent).toBe(rest);
    },
  );

  it("a second press while one is out sends nothing and changes no label", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = runPage(render(), () => ({ status: 200, body: ARCHIVE_CHANGE, wait: gate }));
    await click(p, ACT("archive"));
    await click(p, ACT("keep"));
    p.timers.fire();
    expect(p.$(ACT("keep")).textContent).toBe("Keep handy");
    expect(p.sent).toHaveLength(1);
    release();
    await p.settle();
  });
});
