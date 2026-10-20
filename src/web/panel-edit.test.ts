import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import type { Ask } from "./ask-panel.js";
import { connectionsPage } from "./connections-page.js";
import { homePage } from "./home-page.js";
import { runAskPage, stubDialog } from "./opened-test-kit.js";
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
