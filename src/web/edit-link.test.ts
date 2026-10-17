import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { PictureInfo } from "../core/image-store.js";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { cardMenu } from "./card-menu.js";
import { EDIT_ITEM, editDialog, editMenu } from "./edit-link.js";
import { handyShelf, NOT_HANDY } from "./handy-shelf.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { searchPage } from "./pages.js";
import { spacePage } from "./space-page.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const HOSTILE = `<img src=x onerror=alert(1)>`;
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
const SNAPSHOT = {
  status: "ok",
  fetchedAt: NOW,
  title: "The page's title",
  description: null,
  imageUrl: null,
} as const;
const link = (id: string, over: Partial<Link> = {}): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  why: null,
  tags: [
    { key: "kitchen", name: "Kitchen", source: "stated", kind: "topic", kindSource: "stated" },
  ],
  savedAt: NOW,
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: SNAPSHOT,
  ...over,
});
const OWN = "own0000000000000";
const PAGE = "page000000000000";

type Pages = { links: Link[]; pictures?: Map<string, PictureInfo>; images?: Map<string, string> };
/** The three pages with the edit menu, each showing `links`. */
const pages = ({
  links,
  pictures = new Map([["1", { own: true, pageVersion: PAGE }]]),
  images = new Map([["1", OWN]]),
}: Pages) => ({
  search: searchPage({ query: "", links, now: NOW, images, catalog: [KITCHEN], pictures }),
  all: allPage({
    order: "newest",
    links,
    older: null,
    catalog: [KITCHEN],
    images,
    handy: new Map(),
    now: NOW,
    done: false,
    pictures,
  }),
  space: spacePage({
    tag: KITCHEN,
    catalog: [KITCHEN],
    links,
    older: null,
    images,
    handy: new Map(),
    now: NOW,
    done: false,
    pictures,
  }),
});
const cards = (html: string) =>
  [...parseHTML(html).document.querySelectorAll("li[data-id]")] as HTMLElement[];
const data = (el: Element | undefined) =>
  Object.fromEntries(
    [...(el?.attributes ?? [])]
      .filter((a) => a.name.startsWith("data-"))
      .map((a) => [a.name, a.value]),
  );

describe("the card menu and the card data", () => {
  it.each(["search", "all", "space"] as const)(
    "gives every card on %s the menu with Edit title and picture…, and what the dialog needs",
    (name) => {
      const [first, second] = cards(
        pages({ links: [link("1"), link("2", { title: null, snapshot: null })] })[name],
      );
      const item = first?.querySelector("details.card-menu .card-menu-list button[data-act=edit]");
      expect(item?.textContent).toBe("Edit title and picture…");
      expect(item?.querySelector("svg")).not.toBeNull();
      expect(first?.querySelector("details.card-menu summary .visually-hidden")?.textContent).toBe(
        "More for Link 1",
      );
      expect(data(first)).toEqual({
        "data-id": "1",
        "data-title": "Link 1",
        "data-page-title": "The page's title",
        "data-version": OWN,
        "data-own": "1",
        "data-page-version": PAGE,
        "data-initials": "L1",
      });
      expect(data(second)).toEqual({
        "data-id": "2",
        "data-title": "",
        "data-page-title": "",
        "data-version": "",
        "data-own": "0",
        "data-page-version": "",
        "data-initials": "EC",
      });
    },
  );

  it("puts the menu in a search card's body, and straight on the picture of All links and space cards", () => {
    const html = pages({ links: [link("1")] });
    expect(
      cards(html.search)[0]?.querySelector("details.card-menu")?.parentElement?.className,
    ).toBe("result-body");
    for (const name of ["all", "space"] as const) {
      const [card] = cards(html[name]);
      expect(card?.querySelector("details.card-menu")?.parentElement, name).toBe(card);
    }
  });

  it("keeps a hostile title as text in the data and the menu's label", () => {
    const html = pages({
      links: [link("1", { title: HOSTILE, snapshot: { ...SNAPSHOT, title: HOSTILE } })],
    }).search;
    expect(html).not.toContain(HOSTILE);
    const [card] = cards(html);
    expect(card?.getAttribute("data-title")).toBe(HOSTILE);
    expect(card?.getAttribute("data-page-title")).toBe(HOSTILE);
    expect(card?.querySelector(".card-menu summary .visually-hidden")?.textContent).toBe(
      `More for ${HOSTILE}`,
    );
  });

  it("gives an archived link in search results the menu too, since search lists every state", () => {
    const [card] = cards(pages({ links: [link("1", { state: "archived" })] }).search);
    expect(card?.querySelector("button[data-act=edit]")).not.toBeNull();
  });

  it("leaves the menu and the data off the done pages", () => {
    const done = {
      links: [link("1")],
      older: null,
      images: new Map(),
      handy: new Map(),
      now: NOW,
      done: true,
    };
    for (const html of [
      allPage({ ...done, order: "newest", catalog: [KITCHEN] }),
      spacePage({ ...done, tag: KITCHEN, catalog: [KITCHEN] }),
    ]) {
      const [card] = cards(html);
      expect(card?.querySelector("details.card-menu")).toBeNull();
      expect(card?.hasAttribute("data-title")).toBe(false);
    }
  });

  it("builds the Handy tiles' menu and the cards' menu with the one builder", () => {
    const tool = {
      status: "kept",
      source: "stated",
      since: NOW,
      answeredAt: null,
      waitDays: 30,
    } as const;
    const html = handyShelf({
      items: [{ link: link("1"), tool, due: false }],
      suggestions: [],
      catalog: [KITCHEN],
      images: new Map(),
    });
    const shelfMenu = parseHTML(html).document.querySelector("details.card-menu")?.outerHTML;
    expect(shelfMenu).toBe(
      parseHTML(cardMenu("More for Link 1", [NOT_HANDY])).document.querySelector("details")
        ?.outerHTML,
    );
    expect(editMenu(link("1"))).toBe(cardMenu("More for Link 1", [EDIT_ITEM]));
  });
});

describe("the edit dialog", () => {
  const dialogs = (html: string) => parseHTML(html).document.querySelectorAll("dialog#edit-link");

  it("is on each page with the menu once, and on no done page", () => {
    for (const html of Object.values(pages({ links: [link("1")] })))
      expect(dialogs(html)).toHaveLength(1);
    const done = {
      links: [link("1")],
      older: null,
      images: new Map(),
      handy: new Map(),
      now: NOW,
      done: true,
    };
    expect(dialogs(allPage({ ...done, order: "newest", catalog: [KITCHEN] }))).toHaveLength(0);
    expect(dialogs(spacePage({ ...done, tag: KITCHEN, catalog: [KITCHEN] }))).toHaveLength(0);
  });

  it("has the canvas's heading, fields, picture controls and buttons", () => {
    const d = parseHTML(editDialog()).document.querySelector("dialog") as Element;
    const $ = (s: string) => d.querySelector(s);
    const words = (s: string) => [...d.querySelectorAll(s)].map((b) => b.textContent?.trim());
    expect(d.getAttribute("aria-labelledby")).toBe("edit-link-title");
    expect($("#edit-link-title")?.textContent).toBe("Edit link");
    expect($("label[for=edit-title]")?.textContent).toBe("Title");
    expect($("input#edit-title")).not.toBeNull();
    expect($(".edit-page-title")?.hasAttribute("hidden")).toBe(true);
    expect($("[data-edit=use-title]")?.textContent).toBe("Use it");
    expect($(".edit-picture legend")?.textContent).toBe("Picture");
    expect($("[data-edit=choose]")?.textContent).toBe("Choose a picture…");
    expect($("input[type=file]")?.getAttribute("accept")).toBe(
      "image/png,image/jpeg,image/gif,image/webp",
    );
    expect($("[data-edit=remove]")?.hasAttribute("hidden")).toBe(true);
    expect($(".edit-hint")?.textContent).toBe(
      "Or paste a screenshot (⌘V), or drop a picture here.",
    );
    expect($(".edit-hint-phone")?.textContent).toBe("Opens Photos, Files or the camera.");
    expect($(".edit-types")?.textContent).toBe(
      "PNG, JPEG, GIF or WebP. Big pictures are shrunk to fit.",
    );
    expect($("#edit-error")?.getAttribute("role")).toBe("alert");
    expect(words(".edit-head button")).toEqual(["Cancel", "Save", "Close"]);
    expect(words(".edit-foot button")).toEqual(["Cancel", "Save"]);
    expect(d.querySelectorAll("button[data-edit=save][type=submit]")).toHaveLength(2);
  });

  it("makes no outside request", () => {
    expect(outsideRefs(pages({ links: [link("1")] }).search)).toEqual([]);
  });
});
