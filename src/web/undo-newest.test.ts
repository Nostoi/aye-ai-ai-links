import { describe, expect, it } from "vitest";
import type { ShelfItem } from "../core/tools.js";
import type { Link } from "../core/types.js";
import { handyShelf } from "./handy-shelf.js";
import { homePage, type WorthCards } from "./home-page.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { searchPage } from "./pages.js";

/**
 * The Undo bar offers the Undo of the action pressed last (#324): an offer from an action started
 * before the newest offer the bar has shown is dropped, whichever order the answers come in. Each
 * test presses Undo and checks the route and id it sent.
 */

const NOW = new Date("2026-10-16T00:00:00Z");
const link = (id: string): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  summarySource: null,
  why: { text: `because ${id}`, source: "stated" },
  tags: [],
  savedAt: NOW,
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});
const ROW = {
  status: "kept",
  source: "stated",
  since: "2026-10-01T00:00:00.000Z",
  answeredAt: null,
  waitDays: 30,
} as const;
const MOVED = { tool: { ...ROW, status: "declined" }, previous: ROW };
const CHANGE = {
  before: { state: "active", putAwayAt: null, snoozedUntil: null },
  after: { state: "archived", putAwayAt: null, snoozedUntil: null },
};
const tile = (id: string): ShelfItem => ({
  link: link(id),
  tool: { ...ROW, since: new Date(ROW.since) },
  due: false,
  gone: false,
});
const NO_WORTH: WorthCards = { links: [], images: new Map(), now: NOW, catalog: [], gone: null };

/** Home with these Handy tiles and, when given, `featured` as Worth a look's featured card. */
const home = (tiles: string[], featured?: string) =>
  homePage({
    worth: featured ? { ...NO_WORTH, links: [{ link: link(featured), reasons: [] }] } : NO_WORTH,
    shelf: handyShelf({
      items: tiles.map(tile),
      suggestions: [],
      catalog: [],
      images: new Map(),
    }),
    spaces: "",
  });

const gate = () => {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

const idOf = (s: Post) => (s.body as { id?: string } | undefined)?.id;

/**
 * Home whose posts answer through `post` (by default Not handy anymore's rows, Done with it's
 * change and 204 for an Undo), and whose shelf refreshes take the next of `refreshes`, then home.
 */
const homeRun = (
  html: string,
  refreshes: Answer[],
  post: (s: Post) => Answer | undefined = () => undefined,
) => {
  const queue = [...refreshes];
  return runPage(html, (s) => {
    if (s.body === undefined) return queue.shift() ?? { status: 200, text: html };
    const own = post(s);
    if (own) return own;
    if (s.url === "/home/archive") return { status: 200, body: CHANGE };
    if (s.url === "/tools/not-handy") return { status: 200, body: MOVED };
    return { status: 204 };
  });
};
type Run = ReturnType<typeof runPage>;
const notHandy = async (p: Run, id: string) => {
  p.dispatch(p.$(`#handy [data-id="${id}"] button[data-act=not-handy]`), "click");
  await p.settle();
};
const pressUndo = async (p: Run) => {
  p.dispatch(p.$("#undo-bar button"), "click");
  await p.settle();
};
/** Every Undo route the page sent, with the id it sent. */
const undos = (p: Run) =>
  p.sent
    .filter((s) =>
      ["/tools/undo", "/home/undo-state", "/links/restore", "/links/edit/undo"].includes(s.url),
    )
    .map((s) => `${s.url} ${idOf(s)}`);

describe("the Undo bar keeps the newest action's Undo (#324)", () => {
  it("P1: a tile's dropped refresh answering last does not replace a newer tile's Undo", async () => {
    const g = gate();
    const p = homeRun(home(["1", "2"]), [{ status: 200, text: home(["1", "2"]), wait: g.wait }]);
    await notHandy(p, "1");
    await notHandy(p, "2");
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
    g.open();
    await p.settle();
    await pressUndo(p);
    expect(undos(p)).toEqual(["/tools/undo 2"]);
  });

  it("P2: a slow post whose refresh is the newest does not replace a newer tile's Undo", async () => {
    const g = gate();
    const p = homeRun(home(["1", "2"]), [], (s) =>
      s.url === "/tools/not-handy" && idOf(s) === "1"
        ? { status: 200, body: MOVED, wait: g.wait }
        : undefined,
    );
    await notHandy(p, "1");
    await notHandy(p, "2");
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
    g.open();
    await p.settle();
    await pressUndo(p);
    expect(undos(p)).toEqual(["/tools/undo 2"]);
  });

  it("P3: when the older action answers first, the newer one's Undo still replaces it", async () => {
    const [g1, g2] = [gate(), gate()];
    const html = home(["1", "2"]);
    const p = homeRun(html, [
      { status: 200, text: html, wait: g1.wait },
      { status: 200, text: html, wait: g2.wait },
    ]);
    await notHandy(p, "1");
    await notHandy(p, "2");
    g1.open();
    await p.settle();
    expect(p.$("#undo-bar").hidden).toBe(false);
    g2.open();
    await p.settle();
    await pressUndo(p);
    expect(undos(p)).toEqual(["/tools/undo 2"]);
  });

  it("P4: a tile's late Undo does not replace the featured card's Done with it, pressed after", async () => {
    const g = gate();
    const html = home(["1"], "8");
    const p = homeRun(html, [{ status: 200, text: html, wait: g.wait }]);
    await notHandy(p, "1");
    p.dispatch(p.$(".feature-quiet button[data-act=archive]"), "click");
    await p.settle();
    expect(p.$("#undo-bar strong").textContent).toBe("Done with it.");
    g.open();
    await p.settle();
    expect(p.$("#undo-bar strong")?.textContent).toBe("Done with it.");
    await pressUndo(p);
    expect(undos(p)).toEqual(["/home/undo-state 8"]);
  });

  it("P5: once a newer action's bar has shown, an older action's late Undo is dropped, even after that bar closed", async () => {
    const g = gate();
    const html = home(["1", "2"]);
    const p = homeRun(html, [{ status: 200, text: html, wait: g.wait }]);
    await notHandy(p, "1");
    await notHandy(p, "2");
    await pressUndo(p);
    expect(p.$("#undo-bar").hidden).toBe(true);
    const focusedBefore = p.focused().length;
    g.open();
    await p.settle();
    expect(p.$("#undo-bar").hidden).toBe(true);
    expect(p.focused().slice(focusedBefore)).not.toContain(p.$("#undo-bar button"));
    await pressUndo(p);
    expect(undos(p)).toEqual(["/tools/undo 2"]);
  });

  it("P7: when the newer action is refused, the older action's Undo still shows", async () => {
    const g = gate();
    const html = home(["1", "2"]);
    const p = homeRun(html, [{ status: 200, text: html, wait: g.wait }], (s) =>
      s.url === "/tools/not-handy" && idOf(s) === "2"
        ? { status: 409, body: { code: "conflict", message: "No." } }
        : undefined,
    );
    await notHandy(p, "1");
    await notHandy(p, "2");
    expect(p.$("#undo-bar").hidden).toBe(true);
    g.open();
    await p.settle();
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
    await pressUndo(p);
    expect(undos(p)).toEqual(["/tools/undo 1"]);
  });

  it("P8: Done with it pressed first and answering first gives way to a tile pressed after it", async () => {
    const [archive, refresh] = [gate(), gate()];
    const html = home(["1"], "8");
    const p = homeRun(html, [{ status: 200, text: html, wait: refresh.wait }], (s) =>
      s.url === "/home/archive" ? { status: 200, body: CHANGE, wait: archive.wait } : undefined,
    );
    p.dispatch(p.$(".feature-quiet button[data-act=archive]"), "click");
    await p.settle();
    await notHandy(p, "1");
    archive.open();
    await p.settle();
    expect(p.$("#undo-bar strong").textContent).toBe("Done with it.");
    refresh.open();
    await p.settle();
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
    await pressUndo(p);
    expect(undos(p)).toEqual(["/tools/undo 1"]);
  });

  it("P9: an edit saved after a delete was pressed offers its Undo when the delete answers first", async () => {
    const [deleting, saving] = [gate(), gate()];
    const edited = {
      title: "Edited",
      shown: "Edited",
      url: "https://ex.com/8",
      initials: "E",
      version: "v",
      fit: "cover",
      picture: { own: false, pageVersion: "v", pageFit: "cover" },
      editId: "e1",
    };
    const p = runPage(searchPage({ query: "", links: [link("7"), link("8")], now: NOW }), (s) =>
      s.url === "/links/delete"
        ? { status: 204, wait: deleting.wait }
        : s.url === "/links/edit"
          ? { status: 200, body: edited, wait: saving.wait }
          : { status: 204 },
    );
    stubDialog(p);
    p.dispatch(p.$("[data-id='7'] button[data-act=delete-link]"), "click");
    await p.settle();
    p.dispatch(p.$("[data-id='8'] button[data-act=edit]"), "click");
    (p.$("#edit-title") as HTMLInputElement).value = "Edited";
    p.dispatch(p.$("#edit-link form"), "submit");
    await p.settle();
    deleting.open();
    await p.settle();
    expect(p.$("#undo-bar span").textContent).toBe("Link deleted.");
    saving.open();
    await p.settle();
    expect(p.$("#undo-bar span").textContent).toBe("Link updated");
    await pressUndo(p);
    expect(undos(p)).toEqual(["/links/edit/undo 8"]);
    expect(p.sent.at(-1)?.body).toMatchObject({ id: "8", editId: "e1" });
  });
});
