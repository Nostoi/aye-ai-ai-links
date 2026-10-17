import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PictureInfo } from "../core/image-store.js";
import { png } from "../core/image-test-kit.js";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { cardMenu } from "./card-menu.js";
import { EDIT_ITEM, editDialog, editMenu } from "./edit-link.js";
import { handyShelf, NOT_HANDY } from "./handy-shelf.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
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

type Decode = { width: number; height: number; fail?: boolean; wait?: Promise<void> };
/** Stands in for the browser's `Image`: each decode takes the next entry of `decodes`. */
function fakeImages(decodes: Decode[]) {
  class FakeImage {
    src = "";
    naturalWidth = 0;
    naturalHeight = 0;
    async decode() {
      const d = decodes.shift();
      if (!d) throw new Error("no decode queued");
      if (d.wait) await d.wait;
      if (d.fail) throw new Error("EncodingError");
      this.naturalWidth = d.width;
      this.naturalHeight = d.height;
    }
  }
  vi.stubGlobal("Image", FakeImage);
}
afterEach(() => vi.unstubAllGlobals());

const SHOT = new File([png(64, 48, Buffer.from("shot"))], "shot.png", { type: "image/png" });
const answer = (over: Record<string, unknown> = {}) => ({
  title: "Link 1",
  url: "https://ex.com/1",
  initials: "L1",
  version: PAGE,
  picture: { own: false, pageVersion: PAGE },
  editId: null,
  ...over,
});
/** The search page with the dialog, `<dialog>`'s two methods stood in for (linkedom has neither). */
function opened(
  reply: (sent: Post) => Answer = () => ({ status: 200, body: answer() }),
  pictures: Map<string, PictureInfo> = new Map([["1", { own: false, pageVersion: PAGE }]]),
  images: Map<string, string> = new Map([["1", PAGE]]),
) {
  const html = searchPage({
    query: "",
    links: [link("1")],
    now: NOW,
    images,
    catalog: [KITCHEN],
    pictures,
  });
  const page = runPage(html, reply);
  const dialog = page.$("#edit-link") as HTMLElement & {
    open?: boolean;
    showModal(): void;
    close(): void;
  };
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    if (!dialog.open) return;
    dialog.open = false;
    page.dispatch(dialog, "close");
  };
  const open = () => page.dispatch(page.$('[data-id="1"] button[data-act=edit]'), "click");
  const pick = (file: File) => {
    const input = page.$("[data-edit=file]");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    page.dispatch(input, "change");
  };
  const submit = () => page.dispatch(page.$("#edit-link form"), "submit");
  const saves = () =>
    [...page.document.querySelectorAll("[data-edit=save]")] as HTMLButtonElement[];
  const title = page.$("#edit-title") as HTMLInputElement;
  /** The form the `i`th request sent; throws if it sent none. */
  const form = (i = 0) => {
    const body = page.sent[i]?.body;
    if (!(body instanceof FormData)) throw new Error(`request ${i} sent no form`);
    return body;
  };
  return { ...page, dialog, open, pick, submit, saves, title, form };
}

describe("the edit dialog's script", () => {
  it("opens from a card's menu, filled from the card, in its space's color, with focus in the title", () => {
    const p = opened();
    p.open();
    expect(p.dialog.open).toBe(true);
    expect(p.title.value).toBe("Link 1");
    expect(p.$(".edit-page-title").hidden).toBe(false);
    expect(p.$("#edit-link [data-page-title]").textContent).toBe("The page's title");
    expect(p.$(".edit-preview img").getAttribute("src")).toBe(`/images/1?v=${PAGE}`);
    expect(p.$(".edit-preview").className).toBe("edit-preview space-clay");
    expect(p.$("[data-edit=remove]").hidden).toBe(true);
    expect(p.focused().at(-1)).toBe(p.title);
  });

  it("Use it copies the page's title into the field", () => {
    const p = opened();
    p.open();
    p.dispatch(p.$("[data-edit=use-title]"), "click");
    expect(p.title.value).toBe("The page's title");
  });

  it("Save sends nothing when nothing changed, and only the title when only the title did", async () => {
    const p = opened();
    p.open();
    p.submit();
    await p.settle();
    expect(p.sent).toEqual([]);
    expect(p.dialog.open).toBe(false);
    p.open();
    p.title.value = "New";
    p.submit();
    await p.settle();
    expect(p.sent[0]?.url).toBe("/links/edit");
    const body = p.form();
    expect([...body.keys()]).toEqual(["id", "title"]);
    expect(body.get("id")).toBe("1");
    expect(body.get("title")).toBe("New");
  });

  it("sends a small kept picture as chosen, previewed as New · not saved yet", async () => {
    fakeImages([{ width: 64, height: 48 }]);
    const p = opened();
    p.open();
    p.pick(SHOT);
    await p.settle();
    expect(p.$(".edit-chip").textContent).toBe("New · not saved yet");
    expect(p.$(".edit-preview img").getAttribute("src")).toMatch(/^blob:/);
    expect(p.$("[data-edit=remove]").hidden).toBe(false);
    expect(p.$("[data-edit=remove]").textContent).toBe("Use the page's picture");
    p.submit();
    await p.settle();
    const body = p.form();
    expect([...body.keys()]).toEqual(["id", "picture"]);
    const sentFile = body.get("picture") as File;
    expect(
      Buffer.from(await sentFile.arrayBuffer()).equals(Buffer.from(await SHOT.arrayBuffer())),
    ).toBe(true);
  });

  it.each([
    ["a PNG over 1600px", 3200, 2400, "image/png", [1600, 1200]],
    ["a HEIC the browser can open", 800, 600, "image/heic", [800, 600]],
  ] as const)(
    "re-encodes %s at most 1600px on its longest side, taking the type the browser gives",
    async (_, w, h, type, size) => {
      fakeImages([{ width: w, height: h }]);
      const p = opened();
      const drawn: number[][] = [];
      const create = p.document.createElement.bind(p.document);
      p.document.createElement = ((name: string) =>
        name === "canvas"
          ? {
              width: 0,
              height: 0,
              getContext: () => ({ drawImage: () => {} }),
              toBlob(done: (b: Blob) => void, asked: string) {
                drawn.push([this.width, this.height]);
                expect(asked).toBe("image/webp");
                done(new Blob([png(this.width, this.height)], { type: "image/png" }));
              },
            }
          : create(name)) as typeof p.document.createElement;
      p.open();
      p.pick(new File([Buffer.alloc(16)], "big", { type }));
      await p.settle();
      p.submit();
      await p.settle();
      expect(drawn).toEqual([size]);
      expect((p.form().get("picture") as File).type).toBe("image/png");
    },
  );

  it("keeps the latest pick: a slow first pick that finishes after a fast second is dropped", async () => {
    let release = () => {};
    fakeImages([
      {
        width: 64,
        height: 48,
        wait: new Promise<void>((r) => {
          release = r;
        }),
      },
      { width: 32, height: 32 },
    ]);
    const second = png(32, 32, Buffer.from("second"));
    const p = opened();
    p.open();
    p.pick(new File([png(64, 48, Buffer.from("first"))], "a.png", { type: "image/png" }));
    p.pick(new File([second], "b.png", { type: "image/png" }));
    await p.settle();
    release();
    await p.settle();
    p.submit();
    await p.settle();
    const sentFile = p.form().get("picture") as File;
    expect(Buffer.from(await sentFile.arrayBuffer()).equals(second)).toBe(true);
  });

  it("while a pick is prepared, Save is disabled and the preview says Preparing…", async () => {
    let release = () => {};
    fakeImages([
      {
        width: 64,
        height: 48,
        wait: new Promise<void>((r) => {
          release = r;
        }),
      },
    ]);
    const p = opened();
    p.open();
    p.pick(SHOT);
    await p.settle();
    expect(p.$(".edit-chip").textContent).toBe("Preparing…");
    expect(p.saves().every((b) => b.disabled)).toBe(true);
    p.submit();
    await p.settle();
    expect(p.sent).toEqual([]);
    release();
    await p.settle();
    expect(p.saves().every((b) => !b.disabled)).toBe(true);
  });

  it("says so when the browser can't open a file, and keeps the previous preview", async () => {
    fakeImages([
      { width: 64, height: 48 },
      { width: 0, height: 0, fail: true },
    ]);
    const p = opened();
    p.open();
    p.pick(SHOT);
    await p.settle();
    const before = p.$(".edit-preview img").getAttribute("src");
    p.pick(new File([Buffer.from("not a picture")], "x.heic", { type: "image/heic" }));
    await p.settle();
    expect(p.$("#edit-error").textContent).toBe(
      "That file can't be opened as a picture. Try a PNG, JPEG, GIF or WebP.",
    );
    expect(p.$(".edit-preview img").getAttribute("src")).toBe(before);
    expect(p.$(".edit-chip").textContent).toBe("New · not saved yet");
    expect(p.saves().every((b) => !b.disabled)).toBe(true);
  });

  it("takes a pasted screenshot and a dropped picture, outlining the preview while a file is dragged over", async () => {
    fakeImages([
      { width: 64, height: 48 },
      { width: 64, height: 48 },
    ]);
    const p = opened();
    p.open();
    const text = p.dispatch(p.dialog, "paste", { clipboardData: { files: [] } });
    expect(text.defaultPrevented).toBe(false);
    p.dispatch(p.dialog, "paste", { clipboardData: { files: [SHOT] } });
    await p.settle();
    expect(p.$(".edit-chip").textContent).toBe("New · not saved yet");
    p.dispatch(p.dialog, "dragenter", { dataTransfer: { types: ["Files"], files: [] } });
    expect(p.$(".edit-preview").classList.contains("dropping")).toBe(true);
    expect(p.$(".edit-chip").textContent).toBe("Drop to use this picture");
    p.dispatch(p.dialog, "drop", { dataTransfer: { types: ["Files"], files: [SHOT] } });
    await p.settle();
    expect(p.$(".edit-preview").classList.contains("dropping")).toBe(false);
    expect(p.$(".edit-chip").textContent).toBe("New · not saved yet");
  });

  it("with the owner's picture over a page picture, offers Use the page's picture, previews it and sends page", async () => {
    const p = opened(
      undefined,
      new Map([["1", { own: true, pageVersion: PAGE }]]),
      new Map([["1", OWN]]),
    );
    p.open();
    const remove = p.$("[data-edit=remove]");
    expect(remove.hidden).toBe(false);
    expect(remove.textContent).toBe("Use the page's picture");
    p.dispatch(remove, "click");
    expect(p.$(".edit-preview img").getAttribute("src")).toBe(`/images/1?page=1&v=${PAGE}`);
    expect(remove.hidden).toBe(true);
    p.submit();
    await p.settle();
    expect(p.form().get("picture")).toBe("page");
  });

  it("with the owner's picture and no page picture, offers Remove picture, and the preview falls back to the initials", () => {
    const p = opened(
      undefined,
      new Map([["1", { own: true, pageVersion: null }]]),
      new Map([["1", OWN]]),
    );
    p.open();
    expect(p.$("[data-edit=remove]").textContent).toBe("Remove picture");
    p.dispatch(p.$("[data-edit=remove]"), "click");
    expect(p.$(".edit-preview img")).toBeNull();
    expect(p.$(".edit-preview .edit-initials").textContent).toBe("L1");
  });

  it("on success shows the answer on the card, closes, gives focus back to the ⋯ and offers Undo, which shows its own answer", async () => {
    const p = opened((sent) =>
      sent.url === "/links/edit"
        ? {
            status: 200,
            body: answer({
              title: HOSTILE,
              version: OWN,
              picture: { own: true, pageVersion: PAGE },
              editId: "e1",
            }),
          }
        : {
            status: 200,
            body: answer({
              title: null,
              version: null,
              initials: "EC",
              picture: { own: false, pageVersion: null },
            }),
          },
    );
    p.open();
    p.title.value = "x";
    p.submit();
    await p.settle();
    const card = p.$('[data-id="1"]');
    expect(card.querySelector("h2 a")?.textContent).toBe(HOSTILE);
    expect(card.querySelector("h2 img")).toBeNull();
    expect(card.querySelector(".tile")?.tagName).toBe("IMG");
    expect(card.querySelector(".tile")?.getAttribute("src")).toBe(`/images/1?v=${OWN}`);
    expect(card.getAttribute("data-title")).toBe(HOSTILE);
    expect(card.getAttribute("data-own")).toBe("1");
    expect(p.dialog.open).toBe(false);
    expect(p.focused()).toContain(card.querySelector(".card-menu summary"));
    expect(p.$("#undo-bar").hidden).toBe(false);
    expect(p.$("#undo-bar span").textContent).toBe("Link updated");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({ url: "/links/edit/undo", body: { id: "1", editId: "e1" } });
    expect(card.querySelector("h2 a")?.textContent).toBe("https://ex.com/1");
    expect(card.querySelector(".tile")?.tagName).toBe("DIV");
    expect(card.querySelector(".tile")?.getAttribute("aria-hidden")).toBe("true");
    expect(card.getAttribute("data-initials")).toBe("EC");
    expect(card.querySelector(".card-menu summary .visually-hidden")?.textContent).toBe(
      "More for https://ex.com/1",
    );
  });

  it("shows no Undo for an answer with no edit id", async () => {
    const p = opened();
    p.open();
    p.title.value = "Same once trimmed ";
    p.submit();
    await p.settle();
    expect(p.dialog.open).toBe(false);
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("shows an Undo conflict's message in the page's alert and leaves the card as edited", async () => {
    const conflict = {
      code: "conflict",
      message: "This link changed since, so nothing was undone.",
    };
    const p = opened((sent) =>
      sent.url === "/links/edit"
        ? { status: 200, body: answer({ title: "Edited", editId: "e1" }) }
        : { status: 409, body: conflict },
    );
    p.open();
    p.title.value = "Edited";
    p.submit();
    await p.settle();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.$("#results-error").textContent).toBe(conflict.message);
    const card = p.$('[data-id="1"]');
    expect(card.querySelector("h2 a")?.textContent).toBe("Edited");
    expect(card.getAttribute("data-title")).toBe("Edited");
    expect(p.$("#undo-bar").hidden).toBe(true);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent.map((s) => s.url)).toEqual(["/links/edit", "/links/edit/undo"]);
  });

  it("clears the page's alert when a later Save goes ahead, as Keep handy does", async () => {
    const conflict = {
      code: "conflict",
      message: "This link changed since, so nothing was undone.",
    };
    const p = opened((sent) =>
      sent.url === "/links/edit"
        ? { status: 200, body: answer({ title: "Edited", editId: "e1" }) }
        : { status: 409, body: conflict },
    );
    p.open();
    p.title.value = "Edited";
    p.submit();
    await p.settle();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    p.open();
    p.submit();
    await p.settle();
    expect(p.$("#results-error").textContent).toBe(conflict.message);
    p.open();
    p.title.value = "Again";
    p.submit();
    await p.settle();
    expect(p.$("#results-error").textContent).toBe("");
  });

  it("shows a refusal inside the dialog and keeps it open", async () => {
    const p = opened(() => ({
      status: 400,
      body: { code: "invalid_input", message: "A title can be at most 200 characters." },
    }));
    p.open();
    p.title.value = "a".repeat(201);
    p.submit();
    await p.settle();
    expect(p.$("#edit-error").textContent).toBe("A title can be at most 200 characters.");
    expect(p.dialog.open).toBe(true);
    expect(p.saves().every((b) => !b.disabled)).toBe(true);
  });

  it("Cancel closes without sending and gives focus back to the ⋯", () => {
    const p = opened();
    p.open();
    p.title.value = "Not kept";
    p.dispatch(p.$(".edit-foot [data-edit=cancel]"), "click");
    expect(p.dialog.open).toBe(false);
    expect(p.sent).toEqual([]);
    expect(p.focused().at(-1)).toBe(p.$('[data-id="1"] .card-menu summary'));
  });

  it("opens on a card that Show older links appended to All links", async () => {
    const first = allPage({
      order: "newest",
      links: [link("1")],
      older: "1.1",
      catalog: [KITCHEN],
      images: new Map(),
      handy: new Map(),
      now: NOW,
      done: false,
    });
    const next = allPage({
      order: "newest",
      links: [link("2", { title: "Appended" })],
      older: null,
      catalog: [KITCHEN],
      images: new Map(),
      handy: new Map(),
      now: NOW,
      done: false,
      later: true,
    });
    const page = runPage(first, () => ({ status: 200, text: next }));
    const dialog = page.$("#edit-link") as HTMLElement & { showModal(): void };
    dialog.showModal = () => {};
    page.dispatch(page.$("#older"), "click");
    await page.settle();
    page.dispatch(page.$('[data-id="2"] button[data-act=edit]'), "click");
    expect((page.$("#edit-title") as HTMLInputElement).value).toBe("Appended");
  });
});
