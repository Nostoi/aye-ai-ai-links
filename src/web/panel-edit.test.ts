import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { renderCard } from "./ai-card.js";
import { allPage } from "./all-page.js";
import { ASK_KEY, type Ask } from "./ask-panel.js";
import { connectionsPage } from "./connections-page.js";
import { homePage } from "./home-page.js";
import { type Answer, type Post, runAskPage, stubDialog } from "./opened-test-kit.js";
import { searchPage } from "./pages.js";
import { profilePage } from "./profile-page.js";
import { olderInvalidPage } from "./show-older.js";
import { spaceMissingPage, spacePage } from "./space-page.js";
import { tagsPage } from "./tags-page.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const ASK: Ask = { ai: "Claude", place: "the page", owner: "o1" };
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
const link = (id: string): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  why: null,
  tags: [],
  savedAt: NOW,
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});

const list = {
  order: "newest" as const,
  older: null,
  catalog: [KITCHEN],
  images: new Map(),
  handy: new Map(),
  now: NOW,
  ask: ASK,
};
const space = {
  tag: KITCHEN,
  catalog: [KITCHEN],
  older: null,
  images: new Map(),
  handy: new Map(),
  now: NOW,
  ask: ASK,
};
const ONE = [link("1")];

const variants: Record<string, () => string> = {
  home: () =>
    homePage({
      worth: {
        links: [{ link: link("1"), reasons: [] }],
        images: new Map(),
        now: NOW,
        catalog: [KITCHEN],
        gone: null,
        goneCopy: null,
      },
      shelf: "",
      spaces: "",
      ask: ASK,
    }),
  all: () => allPage({ ...list, links: ONE, done: false }),
  "all-done": () => allPage({ ...list, links: ONE, done: true }),
  "search-empty": () => searchPage({ query: "", links: [], now: NOW, ask: ASK }),
  "search-results": () => searchPage({ query: "k", links: ONE, now: NOW, ask: ASK }),
  space: () => spacePage({ ...space, links: ONE, done: false }),
  "space-done": () => spacePage({ ...space, links: ONE, done: true }),
  "space-missing": () => spaceMissingPage(ASK),
  "older-invalid": () => olderInvalidPage("Open it again.", ASK),
  tags: () => tagsPage({ tags: [KITCHEN], ask: ASK }),
  profile: () => profilePage({ notes: [], focus: [], now: NOW, ask: ASK }),
  connections: () =>
    connectionsPage({
      connections: [],
      keys: [],
      now: NOW,
      bookmarklet: "javascript:void(0)",
      exportView: { state: "idle" },
      ask: ASK,
    }),
};

describe("with the AI on, every menu page has one edit dialog and one edit script", () => {
  for (const [name, render] of Object.entries(variants)) {
    it(`${name}: one dialog#edit-link as a body child, one script reading it, the Undo bar, and all scripts run together`, () => {
      const html = render();
      const { document } = parseHTML(html);
      expect(document.querySelectorAll("#edit-link")).toHaveLength(1);
      expect(document.querySelector("#edit-link")?.parentElement?.tagName).toBe("BODY");
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
      expect(scripts.filter((s) => s.includes('getElementById("edit-link")'))).toHaveLength(1);
      expect(document.querySelector("#undo-bar")).not.toBeNull();
      expect(() => runAskPage(html)).not.toThrow();
    });
  }
});

describe("the AI-on All page's edit dialog", () => {
  const opened = (phone = false) => {
    const html = allPage({
      ...list,
      links: ONE,
      done: false,
      pictures: new Map([["1", { own: false, pageVersion: null, pageFit: null }]]),
    });
    const page = runAskPage(
      html,
      (sent) =>
        sent.url === "/links/edit"
          ? {
              status: 200,
              body: {
                title: "Renamed",
                url: "https://ex.com/1",
                initials: "R",
                version: null,
                fit: null,
                picture: { own: false, pageVersion: null, pageFit: null },
                editId: "e1",
              },
            }
          : { status: 204 },
      { phone },
    );
    return { page, dialog: stubDialog(page) };
  };
  const openFromCard = (page: ReturnType<typeof runAskPage>) =>
    page.dispatch(page.$('[data-id="1"] button[data-act=edit]'), "click");

  it("opens filled from the card, saves with exactly one request, updates the card and offers Undo", async () => {
    const { page, dialog } = opened();
    openFromCard(page);
    expect(dialog.open).toBe(true);
    expect((page.$("#edit-title") as HTMLInputElement).value).toBe("Link 1");
    (page.$("#edit-title") as HTMLInputElement).value = "Renamed";
    page.dispatch(page.$("#edit-link form"), "submit");
    await page.settle();
    expect(page.sent.filter((s) => s.url === "/links/edit")).toHaveLength(1);
    expect(page.$('[data-id="1"] h3').textContent).toBe("Renamed");
    expect(page.$("#undo-bar span").textContent).toBe("Link updated");
  });

  it("shows Delete link, which calls /links/delete", async () => {
    const { page } = opened();
    openFromCard(page);
    expect(page.$(".edit-delete-row").hidden).toBe(false);
    page.dispatch(page.$("[data-edit=delete]"), "click");
    await page.settle();
    expect(page.sent.map((s) => s.url)).toEqual(["/links/delete"]);
  });

  it("on the phone sheet leaves the dialog and the Undo bar usable and the page behind inert", async () => {
    const { page } = opened(true);
    page.dispatch(page.$("#ask-open"), "click");
    const body = [...page.document.body.children];
    const wrapper = body.find((el) => el.querySelector("#undo-bar"));
    expect(page.$(".column").hasAttribute("inert")).toBe(true);
    expect(page.$("#edit-link").hasAttribute("inert")).toBe(false);
    expect(wrapper?.hasAttribute("inert")).toBe(false);
  });
});

describe("the AI-on pages' CSS", () => {
  it("puts the Undo bar above the panel", async () => {
    const { askCss } = await import("./theme.js");
    expect(askCss).toMatch(/\.undo-bar\{z-index:31\}/);
  });
});

/** A panel card as the server renders it, with the edit dialog's data. */
const panelCard = (id: string, title: string, version: string) =>
  renderCard(
    { ...link(id), title },
    { version, fit: "cover" },
    { own: false, pageVersion: null, pageFit: null },
    [KITCHEN],
  );
const editAnswer = (title: string, editId: string | null = "e1") => ({
  title,
  url: "https://ex.com/1",
  initials: title.slice(0, 1),
  version: null,
  fit: null,
  picture: { own: false, pageVersion: null, pageFit: null },
  editId,
});
/** The panel's stored state: link 1 saved by the AI, with its card under the line. */
const savedOne = () => ({
  v: 1,
  owner: ASK.owner,
  open: true,
  entries: [
    { kind: "me", text: "save it" },
    { kind: "reply", segments: [{ text: "Saved." }] },
    {
      kind: "changes",
      lines: [
        {
          text: "Saved.",
          linkId: "1",
          undo: { kind: "save", url: "/links/delete", body: { id: "1" } },
        },
      ],
      cards: { "1": panelCard("1", "Link 1", "v1") },
    },
  ],
  history: [],
  pending: null,
});
type Route = Answer | ((sent: Post) => Answer);
type Page = ReturnType<typeof runAskPage>;
/** Answers each request by its URL; anything not routed gets a 204. */
const onPage = (html: string, routes: Record<string, Route>, stored: unknown = savedOne()) => {
  const page = runAskPage(
    html,
    (sent) => {
      const r = routes[sent.url];
      return (typeof r === "function" ? r(sent) : r) ?? { status: 204 };
    },
    { stored },
  );
  return { page, dialog: stubDialog(page) };
};
const savedTwo = () => {
  const state = savedOne();
  (state.entries as unknown[]).push({
    kind: "changes",
    lines: [
      {
        text: "Saved.",
        linkId: "2",
        undo: { kind: "save", url: "/links/delete", body: { id: "2" } },
      },
    ],
    cards: { "2": panelCard("2", "Link 2", "v1") },
  });
  return state;
};
const freshFor = (id: string, title: string, version = "v2"): Answer => ({
  status: 200,
  body: { card: panelCard(id, title, version) },
});
const editFor = (page: Page, id: string) =>
  page.$(`#ask-messages .ask-edit[data-id="${id}"]`) as HTMLElement;
const postedId = (page: Page) => {
  const sent = page.sent.filter((s) => s.url === "/links/edit").at(-1);
  return (sent?.body as FormData | undefined)?.get("id");
};
const home = () => (variants.home as () => string)();
const allOne = () =>
  allPage({
    ...list,
    links: ONE,
    done: false,
    pictures: new Map([["1", { own: false, pageVersion: null, pageFit: null }]]),
  });
const fresh = (title = "Fresh", version = "v2"): Answer => ({
  status: 200,
  body: { card: panelCard("1", title, version) },
});
const editButton = (page: Page) => page.$("#ask-messages .ask-edit");
const note = (page: Page) => page.$("#ask-messages .ask-note");
const panelTitle = (page: Page) => page.$('#ask-messages .ask-card[data-id="1"] h3').textContent;
const storedCard = (page: Page) =>
  JSON.parse(page.items.get(ASK_KEY) as string).entries[2].cards["1"];
const pressEdit = async (page: Page) => {
  page.dispatch(editButton(page), "click");
  await page.settle();
};
const urls = (page: Page) => page.sent.map((s) => s.url);
const titleField = (page: Page) => page.$("#edit-title") as HTMLInputElement;
const cancel = (page: Page) => page.dispatch(page.$(".edit-foot [data-edit=cancel]"), "click");
const save = async (page: Page, title: string) => {
  titleField(page).value = title;
  page.dispatch(page.$("#edit-link form"), "submit");
  await page.settle();
};
const held = () => {
  let release = () => {};
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, release };
};
const REFUSED = { code: "invalid_input", message: "A title can be at most 200 characters." };
const CONFLICT = { code: "conflict", message: "This link changed since. Your edit stays." };
const REFRESH_FAILED = "This card couldn't be refreshed. Reload to see the change.";

describe("Edit in the panel, on Home", () => {
  it("reads the card again first, then opens the dialog on it, without Delete", async () => {
    const { page, dialog } = onPage(home(), { "/ai/card/1": fresh() });
    await pressEdit(page);
    expect(urls(page)).toEqual(["/ai/card/1"]);
    expect(dialog.open).toBe(true);
    expect(titleField(page).value).toBe("Fresh");
    expect(page.$(".edit-preview img").getAttribute("src")).toBe("/images/1?v=v2");
    expect(page.$(".edit-delete-row").hidden).toBe(true);
    expect(panelTitle(page)).toBe("Fresh");
  });

  it("puts focus back on Edit when the dialog is cancelled", async () => {
    const { page, dialog } = onPage(home(), { "/ai/card/1": fresh() });
    await pressEdit(page);
    cancel(page);
    expect(dialog.open).toBe(false);
    expect(page.focused().at(-1)).toBe(editButton(page));
  });

  it("says it couldn't load the link, and leaves the dialog closed, when the card can't be read", async () => {
    const { page, dialog } = onPage(home(), { "/ai/card/1": { status: 500 } });
    await pressEdit(page);
    expect(dialog.open).toBeFalsy();
    expect(note(page).textContent).toBe("Couldn't load this link. Try again.");
    expect(editButton(page)).not.toBeNull();
  });

  it("says the link was deleted, removes its Edit and leaves the dialog closed, when the card is gone", async () => {
    const { page, dialog } = onPage(home(), {
      "/ai/card/1": { status: 404, body: { code: "not_found" } },
    });
    await pressEdit(page);
    expect(dialog.open).toBeFalsy();
    expect(note(page).textContent).toBe("This link was deleted.");
    expect(page.document.querySelectorAll(".ask-edit")).toHaveLength(0);
  });

  it("saves, reads the card again into the panel and the stored state, and offers Undo, which reads it again", async () => {
    let reads = 0;
    const { page } = onPage(home(), {
      "/ai/card/1": () => {
        reads += 1;
        return reads === 1 ? fresh() : reads === 2 ? fresh("New", "v3") : fresh("Back", "v4");
      },
      "/links/edit": { status: 200, body: editAnswer("New") },
      "/links/edit/undo": { status: 200, body: editAnswer("Fresh", null) },
    });
    await pressEdit(page);
    await save(page, "New");
    expect(urls(page)).toEqual(["/ai/card/1", "/links/edit", "/ai/card/1"]);
    const form = page.sent[1]?.body as FormData;
    expect([...form.keys()]).toEqual(["id", "title"]);
    expect(form.get("id")).toBe("1");
    expect(form.get("title")).toBe("New");
    expect(panelTitle(page)).toBe("New");
    expect(storedCard(page)).toBe(panelCard("1", "New", "v3"));
    expect(page.$("#undo-bar span").textContent).toBe("Link updated");
    page.dispatch(page.$("#undo-bar button"), "click");
    await page.settle();
    expect(urls(page).slice(3)).toEqual(["/links/edit/undo", "/ai/card/1"]);
    expect(page.sent[3]?.body).toEqual({ id: "1", editId: "e1" });
    expect(panelTitle(page)).toBe("Back");
  });

  it("shows a refusal that comes after the dialog closed in the line's note", async () => {
    const { wait, release } = held();
    const { page } = onPage(home(), {
      "/ai/card/1": fresh(),
      "/links/edit": { status: 400, body: REFUSED, wait },
    });
    await pressEdit(page);
    await save(page, "New");
    cancel(page);
    release();
    await page.settle();
    expect(note(page).textContent).toBe(REFUSED.message);
  });

  it("shows an Undo that fails in the line's note", async () => {
    const { page } = onPage(home(), {
      "/ai/card/1": fresh(),
      "/links/edit": { status: 200, body: editAnswer("New") },
      "/links/edit/undo": { status: 409, body: CONFLICT },
    });
    await pressEdit(page);
    await save(page, "New");
    page.dispatch(page.$("#undo-bar button"), "click");
    await page.settle();
    expect(note(page).textContent).toBe(CONFLICT.message);
  });

  it("keeps a refusal while the dialog is open in the dialog", async () => {
    const { page, dialog } = onPage(home(), {
      "/ai/card/1": fresh(),
      "/links/edit": { status: 400, body: REFUSED },
    });
    await pressEdit(page);
    await save(page, "New");
    expect(dialog.open).toBe(true);
    expect(page.$("#edit-error").textContent).toBe(REFUSED.message);
    expect(note(page).textContent).toBe("");
  });
});

describe("Edit in the panel, on the AI-on All page", () => {
  it("updates the page's own card for the same link too", async () => {
    const { page } = onPage(allOne(), {
      "/ai/card/1": fresh(),
      "/links/edit": { status: 200, body: editAnswer("New") },
    });
    await pressEdit(page);
    await save(page, "New");
    expect(page.$('#all-links [data-id="1"] h3').textContent).toBe("New");
  });

  it("shows Delete again when the dialog is next opened from a page card", async () => {
    const { page } = onPage(allOne(), { "/ai/card/1": fresh() });
    await pressEdit(page);
    cancel(page);
    page.dispatch(page.$('#all-links [data-id="1"] button[data-act=edit]'), "click");
    expect(page.$(".edit-delete-row").hidden).toBe(false);
  });

  it("shows an Undo-bar refusal for a panel edit in the line's note, not the page's alert", async () => {
    const { page } = onPage(allOne(), {
      "/ai/card/1": fresh(),
      "/links/edit": { status: 200, body: editAnswer("New") },
      "/links/edit/undo": { status: 409, body: CONFLICT },
    });
    await pressEdit(page);
    await save(page, "New");
    page.dispatch(page.$("#undo-bar button"), "click");
    await page.settle();
    expect(note(page).textContent).toBe(CONFLICT.message);
    expect(page.$("#all-error").textContent).toBe("");
  });

  it("an edit from a page card's ⋯ reads the panel's card for that link again", async () => {
    const { page } = onPage(allOne(), {
      "/ai/card/1": fresh("New", "v3"),
      "/links/edit": { status: 200, body: editAnswer("New") },
    });
    page.dispatch(page.$('#all-links [data-id="1"] button[data-act=edit]'), "click");
    await save(page, "New");
    expect(urls(page)).toEqual(["/links/edit", "/ai/card/1"]);
    expect(panelTitle(page)).toBe("New");
  });
});

describe("Edit with the page awareness of #159", () => {
  const elsewhere = (entries: Record<string, unknown>[]) => ({
    ...savedOne(),
    entries: entries.map((e) => ({ ...e, path: "/tags", place: "Tags" })),
  });
  const saveLine = {
    text: "Saved.",
    linkId: "1",
    undo: { kind: "save", url: "/links/delete", body: { id: "1" } },
  };

  it("opens the dialog from a line behind the Earlier line, and swaps the card there", async () => {
    const { page, dialog } = onPage(
      home(),
      { "/ai/card/1": fresh() },
      elsewhere(savedOne().entries as Record<string, unknown>[]),
    );
    const box = page.$("#ask-messages .ask-earlier-entries");
    page.dispatch(page.$("#ask-messages .ask-earlier"), "click");
    expect(box.hidden).toBe(false);
    page.dispatch(box.querySelector(".ask-edit") as Element, "click");
    await page.settle();
    expect(dialog.open).toBe(true);
    expect(titleField(page).value).toBe("Fresh");
    expect(box.querySelector('.ask-card[data-id="1"] h3')?.textContent).toBe("Fresh");
  });

  it("opens the Earlier box again to show a refusal for a line inside it", async () => {
    const { page } = onPage(
      home(),
      {
        "/ai/card/1": fresh(),
        "/links/edit": { status: 200, body: editAnswer("New") },
        "/links/edit/undo": { status: 409, body: CONFLICT },
      },
      elsewhere(savedOne().entries as Record<string, unknown>[]),
    );
    const toggle = page.$("#ask-messages .ask-earlier");
    const box = page.$("#ask-messages .ask-earlier-entries");
    page.dispatch(toggle, "click");
    page.dispatch(box.querySelector(".ask-edit") as Element, "click");
    await page.settle();
    await save(page, "New");
    page.dispatch(toggle, "click");
    expect(box.hidden).toBe(true);
    page.dispatch(page.$("#undo-bar button"), "click");
    await page.settle();
    expect(box.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(box.querySelector(".ask-note")?.textContent).toBe(CONFLICT.message);
  });

  const foldedWhileWaiting = async (url: string, answer: Answer, button: string) => {
    const { wait, release } = held();
    const { page } = onPage(
      home(),
      { [url]: { ...answer, wait } },
      elsewhere(savedOne().entries as Record<string, unknown>[]),
    );
    const toggle = page.$("#ask-messages .ask-earlier");
    const box = page.$("#ask-messages .ask-earlier-entries");
    page.dispatch(toggle, "click");
    page.dispatch(box.querySelector(button) as Element, "click");
    await page.settle();
    page.dispatch(toggle, "click");
    expect(box.hidden).toBe(true);
    release();
    await page.settle();
    expect(box.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    return box.querySelector(".ask-note")?.textContent;
  };

  it("opens the folded Earlier box to show a panel Undo's refusal", async () => {
    const said = await foldedWhileWaiting(
      "/links/delete",
      { status: 409, body: CONFLICT },
      ".ask-undo",
    );
    expect(said).toBe(CONFLICT.message);
  });

  it("opens the folded Earlier box to say an Edit's link was deleted", async () => {
    const said = await foldedWhileWaiting(
      "/ai/card/1",
      { status: 404, body: { code: "not_found" } },
      ".ask-edit",
    );
    expect(said).toBe("This link was deleted.");
  });

  it("opens the folded Earlier box to say an Edit's link couldn't be loaded", async () => {
    const said = await foldedWhileWaiting("/ai/card/1", { status: 500 }, ".ask-edit");
    expect(said).toBe("Couldn't load this link. Try again.");
  });

  it("leaves an open Earlier box open when a refusal comes for a line inside it", async () => {
    const { page } = onPage(
      home(),
      {
        "/ai/card/1": fresh(),
        "/links/edit": { status: 200, body: editAnswer("New") },
        "/links/edit/undo": { status: 409, body: CONFLICT },
      },
      elsewhere(savedOne().entries as Record<string, unknown>[]),
    );
    const toggle = page.$("#ask-messages .ask-earlier");
    const box = page.$("#ask-messages .ask-earlier-entries");
    page.dispatch(toggle, "click");
    page.dispatch(box.querySelector(".ask-edit") as Element, "click");
    await page.settle();
    await save(page, "New");
    page.dispatch(page.$("#undo-bar button"), "click");
    await page.settle();
    expect(box.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(box.querySelector(".ask-note")?.textContent).toBe(CONFLICT.message);
  });

  it("opens the Earlier box again to show a failed card read for a line inside it", async () => {
    let reads = 0;
    const { page } = onPage(
      home(),
      {
        "/ai/card/1": () => {
          reads += 1;
          return reads === 1 ? fresh() : { status: 500 };
        },
        "/links/edit": { status: 200, body: editAnswer("New") },
      },
      elsewhere(savedOne().entries as Record<string, unknown>[]),
    );
    const toggle = page.$("#ask-messages .ask-earlier");
    const box = page.$("#ask-messages .ask-earlier-entries");
    page.dispatch(toggle, "click");
    page.dispatch(box.querySelector(".ask-edit") as Element, "click");
    await page.settle();
    page.dispatch(toggle, "click");
    expect(box.hidden).toBe(true);
    await save(page, "New");
    expect(reads).toBe(2);
    expect(box.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(box.querySelector(".ask-note")?.textContent).toBe(REFRESH_FAILED);
  });

  it("gives Edit to a line behind the Earlier line whose card is only in its reply", async () => {
    const { page } = onPage(
      home(),
      {},
      elsewhere([
        { kind: "reply", segments: [{ card: panelCard("1", "Link 1", "v1") }] },
        { kind: "changes", lines: [saveLine], cards: {} },
      ]),
    );
    const box = page.$("#ask-messages .ask-earlier-entries");
    expect(box.querySelectorAll(".ask-edit")).toHaveLength(1);
  });

  it("keeps the page's fade when Edit swaps the panel's card and Save updates the page's", async () => {
    const html = allPage({
      ...list,
      links: [link("1"), link("2")],
      done: false,
      pictures: new Map([
        ["1", { own: false, pageVersion: null, pageFit: null }],
        ["2", { own: false, pageVersion: null, pageFit: null }],
      ]),
    });
    const change = {
      kind: "link",
      tool: "update_link",
      linkId: "1",
      created: false,
      fields: [],
      editId: "e9",
    };
    const { page } = onPage(
      html,
      {
        "/ai/chat": {
          status: 200,
          body: {
            ok: true,
            ai: "Fake",
            segments: [{ text: "This one." }, { card: panelCard("1", "Link 1", "v1") }],
            remember: "This one.",
            cards: {},
            changes: [change],
          },
        },
        "/ai/card/1": fresh(),
        "/links/edit": { status: 200, body: editAnswer("New") },
      },
      { ...savedOne(), entries: [] },
    );
    (page.$("#ask-text") as HTMLTextAreaElement).value = "which one?";
    page.dispatch(page.$("#ask-form"), "submit");
    await page.settle();
    const pageCard = (id: string) => page.$(`#all-links [data-id="${id}"]`);
    expect(pageCard("2").classList.contains("ask-dim")).toBe(true);
    expect(pageCard("1").classList.contains("ask-dim")).toBe(false);
    await pressEdit(page);
    await save(page, "New");
    expect(pageCard("1").querySelector("h3")?.textContent).toBe("New");
    expect(pageCard("2").classList.contains("ask-dim")).toBe(true);
    expect(pageCard("1").classList.contains("ask-dim")).toBe(false);
    expect(page.document.querySelectorAll("#ask-messages .ask-dim")).toHaveLength(0);
  });
});

describe("the panel's card reads, per link", () => {
  it("keeps the latest read when two answer out of order, on the page and in the stored state", async () => {
    const releases: (() => void)[] = [];
    let reads = 0;
    const { page } = onPage(home(), {
      "/ai/card/1": () => {
        reads += 1;
        const { wait, release } = held();
        releases.push(release);
        return { ...fresh(`Read ${reads}`, `v${reads}`), wait };
      },
    });
    page.dispatch(editButton(page), "click");
    page.dispatch(editButton(page), "click");
    await page.settle();
    releases[1]?.();
    await page.settle();
    releases[0]?.();
    await page.settle();
    expect(panelTitle(page)).toBe("Read 2");
    expect(storedCard(page)).toBe(panelCard("1", "Read 2", "v2"));
    expect(titleField(page).value).toBe("Read 2");
  });

  it("drops a read still on its way when the save is undone: the card stays faded and the dialog ends closed", async () => {
    const { wait, release } = held();
    const { page, dialog } = onPage(home(), { "/ai/card/1": { ...fresh(), wait } });
    page.dispatch(editButton(page), "click");
    page.dispatch(page.$("#ask-messages .ask-undo"), "click");
    await page.settle();
    expect(urls(page)).toEqual(["/ai/card/1", "/links/delete"]);
    release();
    await page.settle();
    expect(dialog.open).toBeFalsy();
    expect(panelTitle(page)).toBe("Link 1");
    expect(page.$('#ask-messages .ask-card[data-id="1"]').classList.contains("ask-faded")).toBe(
      true,
    );
    expect(storedCard(page)).toBe(panelCard("1", "Link 1", "v1"));
  });

  it("a late panel read never takes over a dialog opened from a page card's ⋯ after the busy one was cancelled", async () => {
    const { wait, release } = held();
    const html = allPage({
      ...list,
      links: [link("1"), link("2")],
      done: false,
      pictures: new Map([
        ["1", { own: false, pageVersion: null, pageFit: null }],
        ["2", { own: false, pageVersion: null, pageFit: null }],
      ]),
    });
    const { page, dialog } = onPage(html, {
      "/ai/card/1": { ...fresh(), wait },
      "/links/edit": { status: 200, body: editAnswer("Two") },
    });
    page.dispatch(editButton(page), "click");
    expect(dialog.open).toBe(true);
    cancel(page);
    page.dispatch(page.$('#all-links [data-id="2"] button[data-act=edit]'), "click");
    titleField(page).value = "Two";
    release();
    await page.settle();
    expect(dialog.open).toBe(true);
    expect(titleField(page).value).toBe("Two");
    expect(page.$(".edit-delete-row").hidden).toBe(false);
    page.dispatch(page.$("#edit-link form"), "submit");
    await page.settle();
    expect(postedId(page)).toBe("2");
  });

  it("a late read for one row never takes over the dialog a later Edit opened on another", async () => {
    const { wait, release } = held();
    const { page, dialog } = onPage(
      home(),
      {
        "/ai/card/1": { ...fresh("One"), wait },
        "/ai/card/2": freshFor("2", "Two"),
        "/links/edit": { status: 200, body: editAnswer("Two edited") },
      },
      savedTwo(),
    );
    page.dispatch(editFor(page, "1"), "click");
    page.dispatch(editFor(page, "2"), "click");
    await page.settle();
    expect(titleField(page).value).toBe("Two");
    release();
    await page.settle();
    expect(dialog.open).toBe(true);
    expect(titleField(page).value).toBe("Two");
    await save(page, "Two edited");
    expect(postedId(page)).toBe("2");
  });

  it("a late read for an earlier press opens nothing, even once a later press's dialog closed", async () => {
    const { wait, release } = held();
    const { page, dialog } = onPage(
      home(),
      { "/ai/card/1": { ...fresh("One"), wait }, "/ai/card/2": freshFor("2", "Two") },
      savedTwo(),
    );
    page.dispatch(editFor(page, "1"), "click");
    page.dispatch(editFor(page, "2"), "click");
    await page.settle();
    cancel(page);
    release();
    await page.settle();
    expect(dialog.open).toBe(false);
    expect(titleField(page).value).toBe("Two");
  });

  it("a press whose read was overtaken opens on the newer read", async () => {
    const save1 = held();
    const read2 = held();
    let reads = 0;
    const { page, dialog } = onPage(home(), {
      "/ai/card/1": () => {
        reads += 1;
        const answer = fresh(`Read ${reads}`, `v${reads}`);
        return reads === 2 ? { ...answer, wait: read2.wait } : answer;
      },
      "/links/edit": { status: 200, body: editAnswer("New"), wait: save1.wait },
    });
    await pressEdit(page);
    await save(page, "New");
    cancel(page);
    page.dispatch(editButton(page), "click");
    await page.settle();
    save1.release();
    await page.settle();
    expect(reads).toBe(3);
    read2.release();
    await page.settle();
    expect(dialog.open).toBe(true);
    expect(titleField(page).value).toBe("Read 3");
    expect(panelTitle(page)).toBe("Read 3");
  });

  it("says the card couldn't be refreshed when a Save worked but the read after it failed", async () => {
    let reads = 0;
    const { page } = onPage(home(), {
      "/ai/card/1": () => {
        reads += 1;
        return reads === 1 ? fresh() : { status: 500 };
      },
      "/links/edit": { status: 200, body: editAnswer("New") },
    });
    await pressEdit(page);
    await save(page, "New");
    expect(page.$("#undo-bar span").textContent).toBe("Link updated");
    expect(note(page).textContent).toBe(REFRESH_FAILED);
  });

  it("says the card couldn't be refreshed, without saying Saved, when an Undo worked but the read after it failed", async () => {
    let reads = 0;
    const { page } = onPage(home(), {
      "/ai/card/1": () => {
        reads += 1;
        return reads < 3 ? fresh() : { status: 500 };
      },
      "/links/edit": { status: 200, body: editAnswer("New") },
      "/links/edit/undo": { status: 200, body: editAnswer("Fresh", null) },
    });
    await pressEdit(page);
    await save(page, "New");
    expect(note(page).textContent).toBe("");
    page.dispatch(page.$("#undo-bar button"), "click");
    await page.settle();
    expect(reads).toBe(3);
    expect(note(page).textContent).toBe(REFRESH_FAILED);
  });

  it("a ⋯ Edit opened on the page cancels a panel Edit still waiting for its read", async () => {
    const { wait, release } = held();
    const html = allPage({
      ...list,
      links: [link("1"), link("2")],
      done: false,
      pictures: new Map([
        ["1", { own: false, pageVersion: null, pageFit: null }],
        ["2", { own: false, pageVersion: null, pageFit: null }],
      ]),
    });
    const { page, dialog } = onPage(html, { "/ai/card/1": { ...fresh(), wait } });
    page.dispatch(editButton(page), "click");
    page.dispatch(page.$('#all-links [data-id="2"] button[data-act=edit]'), "click");
    expect(dialog.open).toBe(true);
    cancel(page);
    release();
    await page.settle();
    expect(dialog.open).toBe(false);
  });

  it("offers a late Save's Undo for its link after the dialog moved to another link and closed", async () => {
    const { wait, release } = held();
    let reads = 0;
    const { page, dialog } = onPage(
      home(),
      {
        "/ai/card/1": () => {
          reads += 1;
          return fresh(`Read ${reads}`, `v${reads}`);
        },
        "/ai/card/2": freshFor("2", "Two"),
        "/links/edit": { status: 200, body: editAnswer("New"), wait },
      },
      savedTwo(),
    );
    page.dispatch(editFor(page, "1"), "click");
    await page.settle();
    const target = page.$('#ask-messages .ask-card[data-id="1"]');
    await save(page, "New");
    cancel(page);
    page.dispatch(editFor(page, "2"), "click");
    await page.settle();
    expect(titleField(page).value).toBe("Two");
    release();
    await page.settle();
    expect(target.isConnected).toBe(false);
    expect(panelTitle(page)).toBe("Read 2");
    expect(dialog.open).toBe(true);
    cancel(page);
    expect(page.$("#undo-bar").hidden).toBe(false);
    page.dispatch(page.$("#undo-bar button"), "click");
    await page.settle();
    const undo = page.sent.find((s) => s.url === "/links/edit/undo");
    expect(undo?.body).toEqual({ id: "1", editId: "e1" });
  });

  it("offers a late Save's Undo after its card was read again and the dialog closed", async () => {
    const { wait, release } = held();
    let reads = 0;
    const { page, dialog } = onPage(home(), {
      "/ai/card/1": () => {
        reads += 1;
        return fresh(`Read ${reads}`, `v${reads}`);
      },
      "/links/edit": { status: 200, body: editAnswer("New"), wait },
    });
    await pressEdit(page);
    const target = page.$('#ask-messages .ask-card[data-id="1"]');
    await save(page, "New");
    cancel(page);
    await pressEdit(page);
    expect(dialog.open).toBe(true);
    release();
    await page.settle();
    expect(target.isConnected).toBe(false);
    expect(page.$("#undo-bar").hidden).toBe(true);
    cancel(page);
    expect(page.$("#undo-bar").hidden).toBe(false);
    page.dispatch(page.$("#undo-bar button"), "click");
    await page.settle();
    const undo = page.sent.find((s) => s.url === "/links/edit/undo");
    expect(undo?.body).toEqual({ id: "1", editId: "e1" });
  });
});

describe("Edit opens the dialog at once and waits for the card (E7)", () => {
  const busy = (page: Page) => ({
    save: (page.$("#edit-link [data-edit=save].primary") as HTMLButtonElement).disabled,
    readonly: titleField(page).hasAttribute("readonly"),
    choose: (page.$("[data-edit=choose]") as HTMLButtonElement).disabled,
  });
  const pressHeld = (answer: Answer, stored: unknown = savedOne()) => {
    const { wait, release } = held();
    const { page, dialog } = onPage(home(), { "/ai/card/1": { ...answer, wait } }, stored);
    let edits = 0;
    page.document.addEventListener("aye-edit", () => {
      edits += 1;
    });
    page.dispatch(editButton(page), "click");
    return { page, dialog, release, edits: () => edits };
  };

  it("opens busy on the press, then fills from the card and saves that link", async () => {
    const { page, dialog, release } = pressHeld(fresh());
    expect(dialog.open).toBe(true);
    expect(busy(page)).toEqual({ save: true, readonly: true, choose: true });
    expect(page.$(".edit-delete-row").hidden).toBe(true);
    release();
    await page.settle();
    expect(dialog.open).toBe(true);
    expect(titleField(page).value).toBe("Fresh");
    expect(busy(page)).toEqual({ save: false, readonly: false, choose: false });
    await save(page, "New");
    expect(postedId(page)).toBe("1");
  });

  it("opens nothing when the busy dialog was cancelled before the card came", async () => {
    const { page, dialog, release, edits } = pressHeld(fresh());
    expect(dialog.open).toBe(true);
    cancel(page);
    expect(dialog.open).toBe(false);
    release();
    await page.settle();
    expect(dialog.open).toBe(false);
    expect(edits()).toBe(1);
    expect(page.focused().at(-1)).toBe(editButton(page));
  });

  it("closes again when the card can't be read, and the line says why", async () => {
    const { page, dialog, release } = pressHeld({ status: 500 });
    expect(dialog.open).toBe(true);
    release();
    await page.settle();
    expect(dialog.open).toBe(false);
    expect(note(page).textContent).toBe("Couldn't load this link. Try again.");
    expect(page.focused().at(-1)).toBe(editButton(page));
  });

  it("closes again when the link is gone, removes its Edit, and the line says so", async () => {
    const { page, dialog, release } = pressHeld({ status: 404, body: { code: "not_found" } });
    expect(dialog.open).toBe(true);
    release();
    await page.settle();
    expect(dialog.open).toBe(false);
    expect(note(page).textContent).toBe("This link was deleted.");
    expect(page.document.querySelectorAll(".ask-edit")).toHaveLength(0);
    expect(page.focused().at(-1)).toBe(page.$("#ask-text"));
  });

  it("Esc while busy closes the dialog, not the panel, and the late card opens nothing", async () => {
    const { page, dialog, release } = pressHeld(fresh());
    expect(dialog.open).toBe(true);
    page.dispatch(titleField(page), "keydown", { key: "Escape" });
    dialog.close();
    expect(page.$("#ask-panel").hidden).toBe(false);
    release();
    await page.settle();
    expect(dialog.open).toBe(false);
  });

  it("a page ⋯ edit whose card read fails writes no line note and leaves a folded box folded", async () => {
    let reads = 0;
    const html = allPage({
      ...list,
      links: ONE,
      done: false,
      pictures: new Map([["1", { own: false, pageVersion: null, pageFit: null }]]),
    });
    const stored = {
      ...savedOne(),
      entries: (savedOne().entries as Record<string, unknown>[]).map((e) => ({
        ...e,
        path: "/tags",
        place: "Tags",
      })),
    };
    const { page } = onPage(
      html,
      {
        "/ai/card/1": () => {
          reads += 1;
          return reads === 1 ? fresh() : { status: 500 };
        },
        "/links/edit": { status: 200, body: editAnswer("New") },
      },
      stored,
    );
    const toggle = page.$("#ask-messages .ask-earlier");
    const box = page.$("#ask-messages .ask-earlier-entries");
    page.dispatch(toggle, "click");
    page.dispatch(box.querySelector(".ask-edit") as Element, "click");
    await page.settle();
    cancel(page);
    page.dispatch(toggle, "click");
    expect(box.hidden).toBe(true);
    page.dispatch(page.$('#all-links [data-id="1"] button[data-act=edit]'), "click");
    await save(page, "New");
    expect(reads).toBe(2);
    expect(box.hidden).toBe(true);
    expect(box.querySelector(".ask-note")?.textContent).toBe("");
  });
});
