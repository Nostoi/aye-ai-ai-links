import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { COPY_HEADERS, copyScripts } from "./copy-page.js";
import { FIND_FAILED } from "./find-dialog.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { page } from "./page.js";
import { quickFind } from "./quick-find.js";
import { spacePage } from "./space-page.js";

/** The quick-find dialog (#360): its place on every menu page, and what its script does. */

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

const link = (n: number): Link => ({
  id: String(n),
  url: `https://example.com/${n}`,
  urlKey: `example.com/${n}`,
  title: `Title ${n}`,
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-03-12T10:00:00Z"),
  savedBy: "claude",
  lastOpenedAt: null,
  intent: "explore",
  intentSource: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});

const fragment = (receipt?: string, n = 3) =>
  quickFind({
    query: "solar",
    links: Array.from({ length: n }, (_, i) => link(i + 1)),
    images: new Map(),
    catalog: [],
    ask: false,
    receipt,
  });

const dom = (html: string) => parseHTML(html).document;
const plain = () =>
  page("t", `<main data-receipt="page-receipt"><button id="other">x</button></main>`, {
    menu: true,
  });

type Opts = { answer?: (sent: Post) => Answer; html?: string };

/** A menu page with the dialog's script running, and a fetch that answers quick-find asks. */
function start({ answer, html = plain() }: Opts = {}) {
  const asked: Post[] = [];
  const p = runPage(html, (sent) => {
    if (sent.url.startsWith("/search/quick")) {
      asked.push(sent);
      return answer?.(sent) ?? { status: 200, text: fragment("rcpt") };
    }
    return answer?.(sent) ?? { status: 204 };
  });
  const dialog = p.$("#find-dialog") as HTMLElement & { open?: boolean };
  const field = p.$("#find-q") as HTMLInputElement;
  const type = (text: string) => {
    field.value = text;
    p.dispatch(field, "input");
  };
  const key = (name: string, init: Record<string, unknown> = {}) =>
    p.dispatch(field, "keydown", { key: name, ...init });
  const open = (init: Record<string, unknown> = {}) =>
    p.dispatch(p.$("a.menu-search"), "click", { button: 0, ...init });
  const reports = () => p.sent.filter((s) => s.url === "/search/log").map((s) => s.body);
  const opens = () => p.sent.filter((s) => s.url === "/links/opened").map((s) => s.body);
  return { p, asked, dialog, field, type, key, open, reports, opens };
}

describe("the dialog on a page", () => {
  it("is a body child of every page with the menu, outside the page's column, and of no other", () => {
    const withMenu = dom(plain());
    const found = withMenu.querySelector("dialog#find-dialog");
    expect(found?.parentElement?.tagName).toBe("BODY");
    expect(found?.closest(".column, main")).toBeNull();
    expect(dom(page("t", "<main></main>")).querySelector("#find-dialog")).toBeNull();
    expect(
      dom(page("t", "<main></main>", { home: true })).querySelector("#find-dialog"),
    ).toBeNull();
  });

  it("holds a combobox field that names its listbox, and starts collapsed", () => {
    const field = dom(plain()).querySelector("#find-q");
    expect(field?.getAttribute("role")).toBe("combobox");
    expect(field?.getAttribute("aria-expanded")).toBe("false");
    expect(field?.getAttribute("aria-controls")).toBe("find-list");
    expect(field?.getAttribute("aria-autocomplete")).toBe("list");
    expect(dom(plain()).querySelector('label[for="find-q"]')).not.toBeNull();
  });

  it("keeps the bar's magnifier a link to /search, marked to open the dialog", () => {
    const a = dom(plain()).querySelector("a.menu-search");
    expect(a?.getAttribute("href")).toBe("/search");
    expect(a?.hasAttribute("data-find-open")).toBe(true);
  });

  it("is not on Home's bar twice: Home has its own field, so the dialog still loads but the magnifier does not", () => {
    const home = dom(page("t", "<main></main>", { menu: true, here: "home" }));
    expect(home.querySelector("a.menu-search")).toBeNull();
    expect(home.querySelector("#find-dialog")).not.toBeNull();
  });

  it("carries no chip off a space page, and the space's chip on one", () => {
    expect(dom(plain()).querySelector(".find-chip, #find-dialog[data-space]")).toBeNull();
    const space = dom(spacePage({ ...spaceInput() }));
    const dialog = space.querySelector("#find-dialog");
    expect(dialog?.getAttribute("data-space")).toBe("kitchen");
    expect(dialog?.querySelector(".find-chip")?.textContent).toContain("in Kitchen");
    expect(dialog?.querySelector(".find-chip")?.classList.contains("space-clay")).toBe(true);
    const search = space.querySelector("a.search-instead");
    expect(search?.hasAttribute("data-find-open")).toBe(true);
    expect(search?.getAttribute("href")).toBe("/search?q=&tag=kitchen");
  });

  it("is on All links, which no longer offers Search instead", () => {
    const html = allPage({
      order: "newest",
      links: [],
      older: null,
      catalog: [],
      images: new Map(),
      handy: new Map(),
      now: new Date(),
      done: false,
    });
    expect(dom(html).querySelector("#find-dialog")).not.toBeNull();
    expect(html).not.toContain("Search instead");
  });

  it("has its script and the dialog's opening script on the copy page's CSP list", () => {
    const own = copyScripts.filter((s) => s.includes("/search/quick"));
    expect(own).toHaveLength(1);
    expect(own[0]).toContain('getElementById("find-dialog")');
    expect(own[0]).toContain('fetch("/links/opened"');
    const hash = `'sha256-${createHash("sha256")
      .update(own[0] ?? "")
      .digest("base64")}'`;
    expect(COPY_HEADERS["Content-Security-Policy"]).toContain(hash);
  });
});

describe("opening it", () => {
  it("opens on an unmodified click on the magnifier, which stays a link for the rest", () => {
    const { dialog, open, field, p } = start();
    const click = open();
    expect(click.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    expect(p.focused().at(-1)).toBe(field);
  });

  it.each([["ctrlKey"], ["metaKey"], ["shiftKey"], ["altKey"]])(
    "does not open on a click with %s held",
    (mod) => {
      const { dialog, open } = start();
      expect(open({ [mod]: true }).defaultPrevented).toBe(false);
      expect(dialog.open).toBeFalsy();
    },
  );

  it("does not open on a middle click", () => {
    const { dialog, open } = start();
    expect(open({ button: 1 }).defaultPrevented).toBe(false);
    expect(dialog.open).toBeFalsy();
  });

  it("opens on the / key where the page has no search field", () => {
    const html = page("t", '<main><button id="other">x</button></main>', { menu: true });
    const { p, dialog } = start({ html });
    p.dispatch(p.$("#other"), "keydown", { key: "/" });
    // The menu's own script is not run by this kit; its event is what the dialog listens for.
    p.dispatch(p.document.body, "aye-find-open");
    expect(dialog.open).toBe(true);
  });

  it("always starts with an empty field and nothing shown", async () => {
    const { p, dialog, field, type, open, key } = start();
    open();
    type("solar");
    p.timers.fire();
    await p.settle();
    expect(p.document.querySelectorAll("[role=option]")).toHaveLength(3);
    key("Escape");
    expect(dialog.open).toBe(false);
    open();
    expect(field.value).toBe("");
    expect(p.document.querySelectorAll("[role=option]")).toHaveLength(0);
  });

  it("gives focus back to the opener when it closes", () => {
    const { p, open, key } = start();
    open();
    key("Escape");
    expect(p.focused().at(-1)).toBe(p.$("a.menu-search"));
  });
});

describe("asking as you type", () => {
  it("waits 250ms after the last key, then asks once with the words", async () => {
    const { p, asked, open, type } = start();
    open();
    type("sol");
    type("solar roof");
    expect(asked).toEqual([]);
    expect(p.timers.pending(250)).toBe(1);
    p.timers.fire();
    await p.settle();
    expect(asked.map((a) => a.url)).toEqual(["/search/quick?q=solar+roof"]);
    expect(asked[0]?.redirect).toBe("manual");
  });

  it("asks nothing for a blank field, and clears what was shown", async () => {
    const { p, asked, open, type, field } = start();
    open();
    type("solar");
    p.timers.fire();
    await p.settle();
    expect(p.document.querySelectorAll("[role=option]")).toHaveLength(3);
    type("   ");
    expect(p.timers.pending()).toBe(0);
    expect(asked).toHaveLength(1);
    expect(p.document.querySelectorAll("[role=option]")).toHaveLength(0);
    expect(field.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the answer as a listbox, the first row highlighted and named by the field", async () => {
    const { p, open, type, field } = start();
    open();
    type("solar");
    p.timers.fire();
    await p.settle();
    const rows = [...p.document.querySelectorAll("[role=option]")];
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(field.getAttribute("aria-expanded")).toBe("true");
    expect(field.getAttribute("aria-activedescendant")).toBe("find-opt-0");
  });

  it("shows only the answer of the latest input, whatever order the answers arrive in", async () => {
    let freeFirst: (value?: unknown) => void = () => {};
    const first = new Promise((resolve) => {
      freeFirst = resolve;
    });
    const { p, open, type } = start({
      answer: (sent) =>
        sent.url === "/search/quick?q=sol"
          ? { status: 200, text: fragment("old", 1), wait: first }
          : { status: 200, text: fragment("new", 2) },
    });
    open();
    type("sol");
    p.timers.fire();
    type("solar");
    p.timers.fire();
    await p.settle();
    freeFirst();
    await p.settle();
    expect(p.document.querySelectorAll("[role=option]")).toHaveLength(2);
    const reported = p.sent.filter((s) => s.url === "/search/log").map((s) => s.body);
    expect(reported).toEqual([{ receipt: "new" }]);
  });

  it("drops an answer that arrives after the dialog closed, and does not report it", async () => {
    let free: (value?: unknown) => void = () => {};
    const wait = new Promise((resolve) => {
      free = resolve;
    });
    const { p, dialog, open, type, key } = start({
      answer: () => ({ status: 200, text: fragment("late"), wait }),
    });
    open();
    type("solar");
    p.timers.fire();
    key("Escape");
    expect(dialog.open).toBe(false);
    open();
    free();
    await p.settle();
    expect(p.document.querySelectorAll("[role=option]")).toHaveLength(0);
    expect(p.sent.filter((s) => s.url === "/search/log")).toEqual([]);
  });

  it("drops a pending ask when the dialog closes", () => {
    const { p, asked, open, type, key } = start();
    open();
    type("solar");
    key("Escape");
    p.timers.fire();
    expect(asked).toEqual([]);
  });

  it.each([
    ["a refusal", { status: 404, text: "<p>not here</p>" }],
    ["a failure", { status: 500 }],
    ["a sign-out's redirect", { status: 0, type: "opaqueredirect" }],
    ["no network", { status: 0, networkFails: true }],
    ["an unreadable body", { status: 200, textFails: true }],
  ])("shows nothing but a line to press Enter after %s", async (_name, answer) => {
    const { p, open, type, field } = start({ answer: () => answer as Answer });
    open();
    type("solar");
    p.timers.fire();
    await p.settle();
    expect(p.document.querySelectorAll("[role=option]")).toHaveLength(0);
    expect(p.$(".find-error").textContent).toBe(FIND_FAILED);
    expect(field.getAttribute("aria-expanded")).toBe("false");
    expect(p.document.body.innerHTML).not.toContain("not here");
  });
});

describe("reporting what it shows", () => {
  it("reports each answer shown that has a receipt, at once and once", async () => {
    const { p, open, type, reports } = start({
      answer: (sent) => ({ status: 200, text: fragment(sent.url.endsWith("a") ? "r1" : "r2") }),
    });
    open();
    type("a");
    p.timers.fire();
    await p.settle();
    expect(reports()).toEqual([{ receipt: "r1" }]);
    type("b");
    p.timers.fire();
    await p.settle();
    expect(reports()).toEqual([{ receipt: "r1" }, { receipt: "r2" }]);
    const log = p.sent.find((s) => s.url === "/search/log");
    expect(log).toMatchObject({ redirect: "manual", keepalive: true });
  });

  it("reports a nothing-matched answer too, and reports nothing for an answer with no receipt", async () => {
    const empty = quickFind({
      query: "zz",
      links: [],
      images: new Map(),
      catalog: [],
      ask: false,
      receipt: "rz",
    });
    const a = start({ answer: () => ({ status: 200, text: empty }) });
    a.open();
    a.type("zz");
    a.p.timers.fire();
    await a.p.settle();
    expect(a.reports()).toEqual([{ receipt: "rz" }]);
    const b = start({ answer: () => ({ status: 200, text: fragment() }) });
    b.open();
    b.type("solar");
    b.p.timers.fire();
    await b.p.settle();
    expect(b.reports()).toEqual([]);
  });

  it("sends the dialog's receipt with an opening, not the page's", async () => {
    const { p, open, type, opens } = start();
    open();
    type("solar");
    p.timers.fire();
    await p.settle();
    p.dispatch(p.$("[role=option]"), "click");
    await p.settle();
    expect(opens()).toEqual([{ id: "1", receipt: "rcpt" }]);
  });
});

describe("the keyboard", () => {
  async function shown() {
    const s = start();
    s.open();
    s.type("solar");
    s.p.timers.fire();
    await s.p.settle();
    return s;
  }
  const selected = (p: ReturnType<typeof start>["p"]) =>
    [...p.document.querySelectorAll("[role=option]")].findIndex(
      (o) => o.getAttribute("aria-selected") === "true",
    );

  it("moves the highlight with the arrows, round the ends, and keeps the field's name for it", async () => {
    const { p, key, field } = await shown();
    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect([selected(p), field.getAttribute("aria-activedescendant")]).toEqual([1, "find-opt-1"]);
    key("ArrowDown");
    key("ArrowDown");
    expect(selected(p)).toBe(0);
    key("ArrowUp");
    expect([selected(p), field.getAttribute("aria-activedescendant")]).toEqual([2, "find-opt-2"]);
    expect(p.document.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  });

  it("follows the pointer", async () => {
    const { p } = await shown();
    p.dispatch(p.document.querySelectorAll("[role=option]")[2] as Element, "pointermove");
    expect(selected(p)).toBe(2);
  });

  it("opens the highlighted link on Enter by clicking it, so the opening is recorded, and closes", async () => {
    const { p, key, dialog, opens } = await shown();
    key("ArrowDown");
    const row = p.document.querySelectorAll("[role=option]")[1] as HTMLElement;
    let clicked = 0;
    row.addEventListener("click", () => clicked++);
    expect(key("Enter").defaultPrevented).toBe(true);
    await p.settle();
    expect(clicked).toBe(1);
    expect(opens()).toEqual([{ id: "2", receipt: "rcpt" }]);
    expect(dialog.open).toBe(false);
  });

  it("does not open a row on Enter while the field has moved on from the answer shown", async () => {
    const { p, key, type, dialog, opens } = await shown();
    type("solar roof");
    expect(key("Enter").defaultPrevented).toBe(false);
    await p.settle();
    expect(opens()).toEqual([]);
    expect(dialog.open).toBe(true);
  });

  it("leaves Enter to the form when nothing matched, and while composing", async () => {
    const empty = quickFind({ query: "zz", links: [], images: new Map(), catalog: [], ask: false });
    const s = start({ answer: () => ({ status: 200, text: empty }) });
    s.open();
    s.type("zz");
    s.p.timers.fire();
    await s.p.settle();
    expect(s.key("Enter").defaultPrevented).toBe(false);
    const t = await shown();
    expect(t.key("Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(t.key("ArrowDown", { isComposing: true }).defaultPrevented).toBe(false);
  });

  it("closes on Escape from the field, and on Cancel", async () => {
    const a = await shown();
    a.key("Escape");
    expect(a.dialog.open).toBe(false);
    const b = start();
    b.open();
    b.p.dispatch(b.p.$(".find-cancel"), "click");
    expect(b.dialog.open).toBe(false);
  });

  it("closes on a click on its backdrop, but not on a press that began inside", () => {
    const { p, dialog, open } = start();
    open();
    p.dispatch(p.$("#find-q"), "pointerdown");
    p.dispatch(dialog, "click");
    expect(dialog.open).toBe(true);
    p.dispatch(dialog, "pointerdown");
    p.dispatch(dialog, "click");
    expect(dialog.open).toBe(false);
  });

  it("closes when a row is clicked, after recording its opening", async () => {
    const { p, dialog, opens } = await shown();
    p.dispatch(p.document.querySelectorAll("[role=option]")[1] as Element, "click");
    await p.settle();
    expect(dialog.open).toBe(false);
    expect(opens()).toEqual([{ id: "2", receipt: "rcpt" }]);
  });

  it("closes for Ask AI, whose panel would sit behind the modal", async () => {
    const empty = quickFind({ query: "zz", links: [], images: new Map(), catalog: [], ask: true });
    const s = start({ answer: () => ({ status: 200, text: empty }) });
    s.open();
    s.type("zz");
    s.p.timers.fire();
    await s.p.settle();
    s.p.dispatch(s.p.$("[data-ask-text]"), "click");
    expect(s.dialog.open).toBe(false);
  });
});

describe("on a space page", () => {
  const html = () => spacePage({ ...spaceInput() });
  const chip = (p: ReturnType<typeof start>["p"]) => p.$(".find-chip") as HTMLElement;
  const tagField = (p: ReturnType<typeof start>["p"]) =>
    p.$('#find-dialog input[name="tag"]') as HTMLInputElement;

  it("starts every opener inside the space, chip showing, and asks within it", async () => {
    const s = start({ html: html() });
    s.open();
    expect(chip(s.p).hidden).toBe(false);
    expect(tagField(s.p).disabled).toBe(false);
    s.type("solar");
    s.p.timers.fire();
    await s.p.settle();
    expect(s.asked.map((a) => a.url)).toEqual(["/search/quick?q=solar&tag=kitchen"]);
  });

  it("opens inside the space from Search this space and from the / key too", () => {
    const s = start({ html: html() });
    s.p.dispatch(s.p.$("a.search-instead"), "click", { button: 0 });
    expect(s.dialog.open).toBe(true);
    expect(chip(s.p).hidden).toBe(false);
    s.key("Escape");
    s.p.dispatch(s.p.document.body, "aye-find-open");
    expect(s.dialog.open).toBe(true);
    expect(chip(s.p).hidden).toBe(false);
  });

  it("drops the space when its cross is pressed, asks again without it, and restores it next time", async () => {
    const s = start({ html: html() });
    s.open();
    s.type("solar");
    s.p.timers.fire();
    await s.p.settle();
    s.p.dispatch(s.p.$(".find-chip-x"), "click");
    await s.p.settle();
    expect(chip(s.p).hidden).toBe(true);
    expect(tagField(s.p).disabled).toBe(true);
    expect(s.asked.map((a) => a.url)).toEqual([
      "/search/quick?q=solar&tag=kitchen",
      "/search/quick?q=solar",
    ]);
    s.key("Escape");
    s.open();
    expect(chip(s.p).hidden).toBe(false);
    expect(tagField(s.p).disabled).toBe(false);
  });

  it("asks nothing when the cross is pressed on a blank field", async () => {
    const s = start({ html: html() });
    s.open();
    s.p.dispatch(s.p.$(".find-chip-x"), "click");
    await s.p.settle();
    expect(s.asked).toEqual([]);
  });

  it("drops an answer for the space once the cross is pressed", async () => {
    let free: (value?: unknown) => void = () => {};
    const wait = new Promise((resolve) => {
      free = resolve;
    });
    const s = start({
      html: html(),
      answer: (sent) =>
        sent.url.includes("tag=")
          ? { status: 200, text: fragment("scoped", 1), wait }
          : { status: 200, text: fragment("all", 2) },
    });
    s.open();
    s.type("solar");
    s.p.timers.fire();
    s.p.dispatch(s.p.$(".find-chip-x"), "click");
    await s.p.settle();
    free();
    await s.p.settle();
    expect(s.p.document.querySelectorAll("[role=option]")).toHaveLength(2);
    expect(s.reports()).toEqual([{ receipt: "all" }]);
  });
});

function spaceInput() {
  return {
    tag: KITCHEN,
    catalog: [KITCHEN],
    order: "newest" as const,
    links: [] as Link[],
    older: null,
    images: new Map(),
    handy: new Map(),
    now: new Date("2026-10-14T12:00:00Z"),
    done: false,
  };
}
