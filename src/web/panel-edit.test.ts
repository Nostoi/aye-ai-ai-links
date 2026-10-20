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
const onPage = (html: string, routes: Record<string, Route>) => {
  const page = runAskPage(
    html,
    (sent) => {
      const r = routes[sent.url];
      return (typeof r === "function" ? r(sent) : r) ?? { status: 204 };
    },
    { stored: savedOne() },
  );
  return { page, dialog: stubDialog(page) };
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

  it("says it couldn't load the link, and opens nothing, when the card can't be read", async () => {
    const { page, dialog } = onPage(home(), { "/ai/card/1": { status: 500 } });
    await pressEdit(page);
    expect(dialog.open).toBeFalsy();
    expect(note(page).textContent).toBe("Couldn't load this link. Try again.");
    expect(editButton(page)).not.toBeNull();
  });

  it("says the link was deleted, removes its Edit and opens nothing, when the card is gone", async () => {
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

  it("drops a read still on its way when the save is undone: the card stays faded and no dialog opens", async () => {
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
