import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PictureInfo, ShownPicture } from "../core/image-store.js";
import { png } from "../core/image-test-kit.js";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { cardMenu, DIVIDER } from "./card-menu.js";
import { deleteLinkItem, deleteLinkScript } from "./delete-link.js";
import { BRING_BACK_ITEM, DONE_ITEM } from "./done-link.js";
import { EDIT_ITEM, editData, editDialog, editLinkScript, editMenu } from "./edit-link.js";
import { handyShelf } from "./handy-shelf.js";
import { NOT_HANDY } from "./keep-handy.js";
import { linkTitle } from "./open-link.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { page } from "./page.js";
import { searchPage, tile } from "./pages.js";
import { spacePage } from "./space-page.js";
import { CARD_FETCH } from "./tell-why.js";

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
  summarySource: null,
  why: null,
  tags: [
    { key: "kitchen", name: "Kitchen", source: "stated", kind: "topic", kindSource: "stated" },
  ],
  savedAt: NOW,
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: SNAPSHOT,
  ...over,
});
const KITCHEN_TAGS = '[{"key":"kitchen","name":"Kitchen","source":"stated"}]';
const OWN = "own0000000000000";
const PAGE = "page000000000000";

type Pages = {
  links: Link[];
  pictures?: Map<string, PictureInfo>;
  images?: Map<string, ShownPicture>;
};
/** The three pages with the edit menu, each showing `links`. */
const pages = ({
  links,
  pictures = new Map([["1", { own: true, pageVersion: PAGE, pageFit: "cover" }]]),
  images = new Map([["1", { version: OWN, fit: "cover" }]]),
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
  const labels = (html: string) =>
    [...parseHTML(html).document.querySelectorAll(".card-menu-list > *")].map((e) =>
      e.tagName === "HR"
        ? "—"
        : `${e.tagName} ${e.getAttribute("data-act")} ${e.textContent}${e.hasAttribute("hidden") ? " (hidden)" : ""}`,
    );
  const KEPT = { status: "kept", source: "stated", due: false } as const;

  it("puts It's stale first, then Keep handy, Edit, Remove saved copy and Delete link last", () => {
    expect(labels(editMenu(link("7")))).toEqual([
      "BUTTON archive It's stale",
      "BUTTON put-away Put it away",
      "BUTTON keep Keep handy",
      "BUTTON not-handy Not handy anymore (hidden)",
      "—",
      "BUTTON edit Edit link…",
      "—",
      "BUTTON delete-link Delete link",
    ]);
    const withCopy = editMenu(link("7"), { copy: { madeAt: new Date(0) } });
    expect(labels(withCopy)).toEqual([
      "BUTTON archive It's stale",
      "BUTTON put-away Put it away",
      "BUTTON keep Keep handy",
      "BUTTON not-handy Not handy anymore (hidden)",
      "—",
      "BUTTON edit Edit link…",
      "BUTTON remove-copy Remove saved copy",
      "—",
      "BUTTON delete-link Delete link",
    ]);
    const rows = parseHTML(withCopy).document.querySelectorAll(".card-menu-list > :not(hr)");
    for (const row of rows) expect(row.querySelector("svg"), row.textContent ?? "").not.toBeNull();
    // The menu stays neutral: no row carries a class, Delete link included.
    expect(parseHTML(withCopy).document.querySelector(".card-menu-list")?.innerHTML).not.toContain(
      "class=",
    );
  });

  it("shows Not handy anymore in Keep handy's place once the link is kept", () => {
    expect(labels(editMenu(link("7"), { handy: KEPT })).slice(0, 4)).toEqual([
      "BUTTON archive It's stale",
      "BUTTON put-away Put it away",
      "BUTTON keep Keep handy (hidden)",
      "BUTTON not-handy Not handy anymore",
    ]);
  });

  it("adds Not now after It's stale on Home's rows: the one six-row menu (#195)", () => {
    expect(labels(editMenu(link("7"), { copy: { madeAt: new Date(0) }, notNow: true }))).toEqual([
      "BUTTON archive It's stale",
      "BUTTON put-away Put it away",
      "BUTTON snooze Not now",
      "BUTTON keep Keep handy",
      "BUTTON not-handy Not handy anymore (hidden)",
      "—",
      "BUTTON edit Edit link…",
      "BUTTON remove-copy Remove saved copy",
      "—",
      "BUTTON delete-link Delete link",
    ]);
    const svg = parseHTML(editMenu(link("7"), { notNow: true })).document.querySelector(
      "[data-act=snooze] svg",
    );
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("leaves out It's stale and Not now, not Put it away, when the card shows them as buttons (#195)", () => {
    expect(labels(editMenu(link("7"), { onCard: true, notNow: true }))).toEqual([
      "BUTTON put-away Put it away",
      "BUTTON keep Keep handy",
      "BUTTON not-handy Not handy anymore (hidden)",
      "—",
      "BUTTON edit Edit link…",
      "—",
      "BUTTON delete-link Delete link",
    ]);
  });

  it("starts an archived link's menu at Edit, then Bring it back, Remove saved copy and Delete link", () => {
    expect(
      labels(
        editMenu(link("7", { state: "archived" }), { copy: { madeAt: new Date(0) }, handy: KEPT }),
      ),
    ).toEqual([
      "BUTTON edit Edit link…",
      "BUTTON bring-back Bring it back",
      "BUTTON remove-copy Remove saved copy",
      "—",
      "BUTTON delete-link Delete link",
    ]);
  });

  it("gives an archived card on Home (the came-back lead) the same menu, with Bring it back", () => {
    const put = link("7", { state: "archived", putAwayAt: new Date(0) });
    expect(labels(editMenu(put, { onCard: true }))).toEqual([
      "BUTTON edit Edit link…",
      "BUTTON bring-back Bring it back",
      "—",
      "BUTTON delete-link Delete link",
    ]);
  });

  it.each(["search", "all", "space"] as const)(
    "gives every card on %s the menu with Edit link…, and what the dialog needs",
    (name) => {
      const [first, second] = cards(
        pages({ links: [link("1"), link("2", { title: null, snapshot: null })] })[name],
      );
      const item = first?.querySelector("details.card-menu .card-menu-list button[data-act=edit]");
      expect(item?.textContent).toBe("Edit link…");
      expect(item?.querySelector("svg")).not.toBeNull();
      expect(first?.querySelector("details.card-menu summary .visually-hidden")?.textContent).toBe(
        "More for Link 1",
      );
      expect(data(first)).toEqual({
        "data-id": "1",
        "data-title": "Link 1",
        "data-page-title": "The page's title",
        "data-version": OWN,
        "data-fit": "cover",
        "data-own": "1",
        "data-page-version": PAGE,
        "data-page-fit": "cover",
        "data-initials": "L1",
        "data-tags": KITCHEN_TAGS,
      });
      expect(data(second)).toEqual({
        "data-id": "2",
        "data-title": "",
        "data-page-title": "",
        "data-version": "",
        "data-fit": "",
        "data-own": "0",
        "data-page-version": "",
        "data-page-fit": "",
        "data-initials": "EC",
        "data-tags": KITCHEN_TAGS,
      });
    },
  );

  it("carries the link's tags in order with their sources, a hostile name kept as text", () => {
    const tag = (name: string, source: "stated" | "inferred") => ({
      key: name.toLowerCase(),
      name,
      source,
      kind: "topic" as const,
      kindSource: "inferred" as const,
    });
    const attr = (tags: ReturnType<typeof tag>[]) => {
      const html = `<li${editData(link("1", { tags }), undefined, undefined)}></li>`;
      expect(html).not.toContain("<img");
      const value = parseHTML(html).document.querySelector("li")?.getAttribute("data-tags");
      return JSON.parse(value ?? "");
    };
    expect(attr([tag(HOSTILE, "inferred"), tag('Say "hi" & bye', "stated")])).toEqual([
      { key: HOSTILE.toLowerCase(), name: HOSTILE, source: "inferred" },
      { key: 'say "hi" & bye', name: 'Say "hi" & bye', source: "stated" },
    ]);
    expect(attr([])).toEqual([]);
  });

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

  it("leaves out a page title longer than a title can be, counted in code points after trimming", () => {
    const pageTitle = (n: number) => {
      const html = pages({
        links: [link("1", { snapshot: { ...SNAPSHOT, title: ` ${"🍳".repeat(n)} ` } })],
      }).search;
      return cards(html)[0]?.getAttribute("data-page-title");
    };
    expect(pageTitle(200)).toBe(` ${"🍳".repeat(200)} `);
    expect(pageTitle(201)).toBe("");
  });

  it("gives an archived link in search results the menu too, since search lists every state", () => {
    const [card] = cards(pages({ links: [link("1", { state: "archived" })] }).search);
    expect(card?.querySelector("button[data-act=edit]")).not.toBeNull();
  });

  it("puts the menu and the data on the done pages too", () => {
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
      expect(card?.querySelector("details.card-menu")).not.toBeNull();
      expect(card?.hasAttribute("data-title")).toBe(true);
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
      items: [{ link: link("1"), tool, due: false, gone: false }],
      suggestions: [],
      catalog: [KITCHEN],
      images: new Map(),
    });
    const shelfMenu = parseHTML(html).document.querySelector("details.card-menu")?.outerHTML;
    expect(shelfMenu).toBe(
      parseHTML(cardMenu("More for Link 1", [DONE_ITEM, NOT_HANDY])).document.querySelector(
        "details",
      )?.outerHTML,
    );
    expect(editMenu(link("1", { state: "archived" }))).toBe(
      cardMenu("More for Link 1", [EDIT_ITEM, BRING_BACK_ITEM, DIVIDER, deleteLinkItem]),
    );
  });
});

describe("the edit dialog", () => {
  const dialogs = (html: string) => parseHTML(html).document.querySelectorAll("dialog#edit-link");

  it("is on each page with the menu once, done pages included", () => {
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
    expect(dialogs(allPage({ ...done, order: "newest", catalog: [KITCHEN] }))).toHaveLength(1);
    expect(dialogs(spacePage({ ...done, tag: KITCHEN, catalog: [KITCHEN] }))).toHaveLength(1);
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
  fit: "cover",
  picture: { own: false, pageVersion: PAGE, pageFit: "cover" },
  editId: null,
  ...over,
  shown: over.shown ?? over.title ?? "Link 1",
});
/** The search page with the dialog, `<dialog>`'s two methods stood in for (linkedom has neither). */
function opened(
  reply: (sent: Post) => Answer = () => ({ status: 200, body: answer() }),
  pictures: Map<string, PictureInfo> = new Map([
    ["1", { own: false, pageVersion: PAGE, pageFit: "cover" }],
  ]),
  images: Map<string, ShownPicture> = new Map([["1", { version: PAGE, fit: "cover" }]]),
  links: Link[] = [link("1")],
  where: "search" | "all" | "space" = "search",
) {
  const html = pages({ links, pictures, images })[where];
  const page = runPage(html, reply);
  const dialog = stubDialog(page);
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

  it("leaves a stored title with line breaks alone on a picture-only Save, though the field drops them", async () => {
    fakeImages([{ width: 64, height: 48 }]);
    const p = opened(undefined, undefined, undefined, [link("1", { title: "Two\nlines" })]);
    let shown = "";
    Object.defineProperty(p.title, "value", {
      get: () => shown,
      set: (v: string) => {
        shown = v.replace(/[\r\n]/g, "");
      },
    });
    p.open();
    expect(p.title.value).toBe("Twolines");
    p.pick(SHOT);
    await p.settle();
    p.submit();
    await p.settle();
    expect([...p.form().keys()]).toEqual(["id", "picture"]);
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

  it("lets text with an image beside it paste into the title, and still takes an image alone pasted there", async () => {
    fakeImages([{ width: 64, height: 48 }]);
    const p = opened();
    p.open();
    const both = { types: ["text/plain", "Files"], files: [SHOT] };
    const text = p.dispatch(p.title, "paste", { clipboardData: both });
    await p.settle();
    expect(text.defaultPrevented).toBe(false);
    expect(p.$(".edit-chip").hidden).toBe(true);
    expect(p.$("[data-edit=remove]").hidden).toBe(true);
    p.dispatch(p.title, "paste", { clipboardData: { types: ["Files"], files: [SHOT] } });
    await p.settle();
    expect(p.$(".edit-chip").textContent).toBe("New · not saved yet");
  });

  it("with the owner's picture over a page picture, offers Use the page's picture, previews it and sends page", async () => {
    const p = opened(
      undefined,
      new Map([["1", { own: true, pageVersion: PAGE, pageFit: "cover" }]]),
      new Map([["1", { version: OWN, fit: "cover" }]]),
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
      new Map([["1", { own: true, pageVersion: null, pageFit: null }]]),
      new Map([["1", { version: OWN, fit: "cover" }]]),
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
              shown: HOSTILE,
              version: OWN,
              picture: { own: true, pageVersion: PAGE, pageFit: "cover" },
              editId: "e1",
            }),
          }
        : {
            status: 200,
            body: answer({
              title: null,
              shown: "Ex 1 — ex.com",
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
    expect(card.querySelector("h2 a")?.textContent).toBe("Ex 1 — ex.com");
    expect(card.getAttribute("data-title")).toBe("");
    expect(card.querySelector(".tile")?.tagName).toBe("DIV");
    expect(card.querySelector(".tile")?.getAttribute("class")).toBe("tile initials-box");
    expect(card.querySelector(".tile")?.getAttribute("aria-hidden")).toBe("true");
    expect(card.getAttribute("data-initials")).toBe("EC");
    expect(card.querySelector(".card-menu summary .visually-hidden")?.textContent).toBe(
      "More for Ex 1 — ex.com",
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

  /** A Save on card 1 whose answer waits, then Cancel and the dialog reopened for card 2. */
  async function reopenedDuringSave(reply: Answer) {
    let release = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = opened(
      (sent) => (sent.url === "/links/edit" ? { ...reply, wait } : { status: 200, body: answer() }),
      undefined,
      undefined,
      [link("1"), link("2")],
    );
    p.open();
    p.title.value = "Edited";
    p.submit();
    await p.settle();
    p.dispatch(p.$(".edit-foot [data-edit=cancel]"), "click");
    p.dispatch(p.$('[data-id="2"] button[data-act=edit]'), "click");
    release();
    await p.settle();
    return p;
  }

  it("a Save answered after the dialog was reopened for another card updates its own card and leaves the dialog alone", async () => {
    const p = await reopenedDuringSave({
      status: 200,
      body: answer({ title: "Edited", editId: "e1" }),
    });
    expect(p.$('[data-id="1"] h2 a').textContent).toBe("Edited");
    expect(p.$('[data-id="1"]').getAttribute("data-title")).toBe("Edited");
    expect(p.$('[data-id="2"] h2 a').textContent).toBe("Link 2");
    expect(p.$('[data-id="2"]').getAttribute("data-title")).toBe("Link 2");
    expect(p.dialog.open).toBe(true);
    expect(p.title.value).toBe("Link 2");
    expect(p.$("#results-error").textContent).toBe("");
  });

  it("holds a late answer's Undo while the dialog is open, and offers it for its own card once it closes", async () => {
    const p = await reopenedDuringSave({
      status: 200,
      body: answer({ title: "Edited", editId: "e1" }),
    });
    expect(p.$("#undo-bar").hidden).toBe(true);
    p.dispatch(p.$(".edit-foot [data-edit=cancel]"), "click");
    expect(p.$("#undo-bar").hidden).toBe(false);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({ url: "/links/edit/undo", body: { id: "1", editId: "e1" } });
    p.open();
    p.dispatch(p.$(".edit-foot [data-edit=cancel]"), "click");
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("drops a held Undo when a newer Save offers its own first", async () => {
    let release = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = opened(
      (sent) => {
        const id = sent.body instanceof FormData ? sent.body.get("id") : null;
        if (id === "1") return { status: 200, wait, body: answer({ editId: "e1" }) };
        if (id === "2") return { status: 200, body: answer({ title: "Link 2", editId: "e2" }) };
        return { status: 200, body: answer() };
      },
      undefined,
      undefined,
      [link("1"), link("2")],
    );
    p.open();
    p.title.value = "Edited";
    p.submit();
    await p.settle();
    p.dispatch(p.$(".edit-foot [data-edit=cancel]"), "click");
    p.dispatch(p.$('[data-id="2"] button[data-act=edit]'), "click");
    release();
    await p.settle();
    let fireClose = () => {};
    p.dialog.close = () => {
      p.dialog.open = false;
      fireClose = () => p.dispatch(p.dialog, "close");
    };
    p.title.value = "Edited 2";
    p.submit();
    await p.settle();
    fireClose();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[2]).toMatchObject({ url: "/links/edit/undo", body: { id: "2", editId: "e2" } });
    p.open();
    p.dispatch(p.$(".edit-foot [data-edit=cancel]"), "click");
    fireClose();
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("a refusal answered after the dialog was reopened shows in the page's alert, not in the dialog", async () => {
    const p = await reopenedDuringSave({
      status: 400,
      body: { code: "invalid_input", message: "A title can be at most 200 characters." },
    });
    expect(p.dialog.open).toBe(true);
    expect(p.$("#edit-error").textContent).toBe("");
    expect(p.$("#results-error").textContent).toBe("A title can be at most 200 characters.");
    expect(p.$('[data-id="1"] h2 a').textContent).toBe("Link 1");
  });

  it("while a Save is pending, a paste or Remove keeps Save disabled, so a second press sends nothing", async () => {
    fakeImages([{ width: 64, height: 48 }]);
    let release = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = opened(() => ({ status: 200, wait, body: answer({ title: "Edited" }) }));
    p.open();
    p.title.value = "Edited";
    p.submit();
    await p.settle();
    p.dispatch(p.dialog, "paste", { clipboardData: { files: [SHOT] } });
    await p.settle();
    expect(p.saves().every((b) => b.disabled)).toBe(true);
    p.submit();
    await p.settle();
    p.dispatch(p.$("[data-edit=remove]"), "click");
    expect(p.saves().every((b) => b.disabled)).toBe(true);
    p.submit();
    await p.settle();
    expect(p.sent).toHaveLength(1);
    release();
    await p.settle();
    expect(p.dialog.open).toBe(false);
  });

  it("a drag that entered while a Save was pending still shows the drop hint once it is answered", async () => {
    let release = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const refused = { code: "invalid_input", message: "A title can be at most 200 characters." };
    const p = opened(() => ({ status: 400, wait, body: refused }));
    const files = { dataTransfer: { types: ["Files"], files: [SHOT] } };
    p.open();
    p.title.value = "Edited";
    p.submit();
    await p.settle();
    p.dispatch(p.dialog, "dragenter", files);
    expect(p.$(".edit-preview").classList.contains("dropping")).toBe(false);
    release();
    await p.settle();
    p.dispatch(p.dialog, "dragenter", files);
    p.dispatch(p.dialog, "dragleave", files);
    expect(p.$(".edit-preview").classList.contains("dropping")).toBe(true);
  });

  it("while a Save is pending, the fields are off and a paste or drop is ignored, until it is answered or closed", async () => {
    fakeImages([
      { width: 64, height: 48 },
      { width: 64, height: 48 },
    ]);
    let release = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const waits = [wait, new Promise<void>(() => {})];
    const refused = { code: "invalid_input", message: "A title can be at most 200 characters." };
    const p = opened(
      () => ({ status: 400, wait: waits.shift(), body: refused }),
      new Map([["1", { own: true, pageVersion: PAGE, pageFit: "cover" }]]),
      new Map([["1", { version: OWN, fit: "cover" }]]),
    );
    const fields = () => [
      p.title.hasAttribute("readonly"),
      ...["[data-edit=choose]", "[data-edit=remove]", "[data-edit=use-title]"].map(
        (s) => (p.$(s) as HTMLButtonElement).disabled,
      ),
    ];
    p.open();
    expect(fields()).toEqual([false, false, false, false]);
    p.title.value = "Edited";
    p.submit();
    await p.settle();
    expect(fields()).toEqual([true, true, true, true]);
    expect(p.title.disabled).toBe(false);
    p.dispatch(p.dialog, "dragenter", { dataTransfer: { types: ["Files"], files: [SHOT] } });
    expect(p.$(".edit-preview").classList.contains("dropping")).toBe(false);
    p.dispatch(p.dialog, "paste", { clipboardData: { types: ["Files"], files: [SHOT] } });
    const drop = p.dispatch(p.dialog, "drop", {
      dataTransfer: { types: ["Files"], files: [SHOT] },
    });
    await p.settle();
    expect(drop.defaultPrevented).toBe(true);
    expect(p.$(".edit-chip").hidden).toBe(true);
    expect(p.$("[data-edit=remove]").textContent).toBe("Use the page's picture");
    release();
    await p.settle();
    expect(p.$("#edit-error").textContent).toBe(refused.message);
    expect(fields()).toEqual([false, false, false, false]);
    p.submit();
    await p.settle();
    expect(fields()).toEqual([true, true, true, true]);
    p.dispatch(p.$(".edit-foot [data-edit=cancel]"), "click");
    expect(fields()).toEqual([false, false, false, false]);
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

/** Tag, sorted classes, other attributes and children, so DOM-built and server-built boxes compare. */
const shape = (e: Element): unknown => ({
  tag: e.tagName,
  cls: [...e.classList].sort(),
  attrs: Object.fromEntries(
    [...e.attributes].filter((a) => a.name !== "class").map((a) => [a.name, a.value]),
  ),
  text: e.children.length === 0 ? e.textContent : undefined,
  kids: [...e.children].map(shape),
});
const SHAPES = {
  cover: {
    picture: { version: OWN, fit: "cover" },
    answer: {
      version: OWN,
      fit: "cover",
      picture: { own: true, pageVersion: PAGE, pageFit: "contain" },
    },
  },
  contain: {
    picture: { version: PAGE, fit: "contain" },
    answer: {
      version: PAGE,
      fit: "contain",
      picture: { own: false, pageVersion: PAGE, pageFit: "contain" },
    },
  },
  none: {
    picture: undefined,
    answer: { version: null, fit: null, picture: { own: false, pageVersion: null, pageFit: null } },
  },
} as const;
const pairs = (["cover", "contain", "none"] as const).flatMap((a) =>
  (["cover", "contain", "none"] as const).filter((b) => b !== a).map((b) => [a, b] as const),
);
const startInfo = new Map([["1", { own: false, pageVersion: PAGE, pageFit: "contain" as const }]]);
/** The box tile() draws on the server for this picture, as a parsed element. */
const serverBox = (picture: ShownPicture | undefined, cls: string) =>
  parseHTML(`<html><body>${tile(link("1"), picture, cls)}</body></html>`).document.querySelector(
    `.${cls}`,
  ) as Element;
describe.each([
  ["search", "tile"],
  ["all", "row-pic"],
  ["space", "row-pic"],
] as const)("on %s cards", (page, cls) => {
  it.each(pairs)("a Save from %s to %s draws exactly tile()'s box", async (from, to) => {
    const start = SHAPES[from].picture;
    const p = opened(
      () => ({ status: 200, body: answer({ ...SHAPES[to].answer, shown: "Saved title" }) }),
      startInfo,
      new Map(start ? [["1", start]] : []),
      [link("1")],
      page,
    );
    p.open();
    p.title.value = "x";
    p.submit();
    await p.settle();
    expect(shape(p.$(`[data-id="1"] .${cls}`))).toEqual(shape(serverBox(SHAPES[to].picture, cls)));
    expect(p.$('[data-id="1"]').getAttribute("data-fit")).toBe(SHAPES[to].answer.fit ?? "");
    expect(p.$('[data-id="1"] [data-card-title] a').textContent).toBe("Saved title");
  });
});
it("an Undo back to an icon draws tile()'s icon box again", async () => {
  const p = opened(
    (sent) => ({
      status: 200,
      body:
        sent.url === "/links/edit"
          ? answer({ ...SHAPES.cover.answer, editId: "e1" })
          : answer(SHAPES.contain.answer),
    }),
    startInfo,
    new Map([["1", SHAPES.contain.picture]]),
  );
  p.open();
  p.title.value = "x";
  p.submit();
  await p.settle();
  p.dispatch(p.$("#undo-bar button"), "click");
  await p.settle();
  expect(shape(p.$('[data-id="1"] .tile'))).toEqual(
    shape(serverBox(SHAPES.contain.picture, "tile")),
  );
});
it("over an icon, the owner's picture offers Use the site's icon, and previews the icon whole", () => {
  const p = opened(
    undefined,
    new Map([["1", { own: true, pageVersion: PAGE, pageFit: "contain" }]]),
    new Map([["1", { version: OWN, fit: "cover" }]]),
  );
  p.open();
  expect(p.$(".edit-preview").classList.contains("fit-contain")).toBe(false);
  expect(p.$("[data-edit=remove]").textContent).toBe("Use the site's icon");
  p.dispatch(p.$("[data-edit=remove]"), "click");
  expect(p.$(".edit-preview").classList.contains("fit-contain")).toBe(true);
  expect(p.$(".edit-preview img")?.getAttribute("class")).toBe("site-icon");
  expect(p.$(".edit-preview img")?.getAttribute("src")).toBe(`/images/1?page=1&v=${PAGE}`);
});

describe("a card the dialog knows only by its markers", () => {
  /** A card with none of the known layout classes: its title is `data-card-title`, its picture `tile()`'s. */
  const markedPage = (picture: boolean) =>
    page(
      "Cards",
      `<p id="cards-error" role="alert"></p>
<ul id="cards"><li data-id="1"${editData(link("1"), SHAPES.cover.picture, undefined)}>
${picture ? `<div class="frame">${tile(link("1"), SHAPES.cover.picture, "odd-pic")}</div>\n` : ""}<p><strong data-card-title>${linkTitle(link("1"))}</strong></p>
${editMenu(link("1"))}
</li></ul>
${editDialog()}
<script>
${CARD_FETCH}
${editLinkScript("cards", "cards-error")}
${deleteLinkScript("cards", "cards-error")}
</script>`,
      { menu: true, undo: true },
    );
  const save = async (p: ReturnType<typeof runPage>, title: string) => {
    p.dispatch(p.$('[data-id="1"] button[data-act=edit]'), "click");
    (p.$("#edit-title") as HTMLInputElement).value = title;
    p.dispatch(p.$("#edit-link form"), "submit");
    await p.settle();
  };

  it("shows each Save's title and picture, the second Save included", async () => {
    const replies = [SHAPES.none.answer, SHAPES.contain.answer];
    const p = runPage(markedPage(true), () => ({
      status: 200,
      body: answer({ ...replies.shift(), title: "First", shown: "First" }),
    }));
    stubDialog(p);
    await save(p, "First");
    expect(p.$("[data-card-title]").textContent).toBe("First");
    expect(shape(p.$(".frame > *"))).toEqual(shape(serverBox(SHAPES.none.picture, "odd-pic")));
    await save(p, "Second");
    expect(shape(p.$(".frame > *"))).toEqual(shape(serverBox(SHAPES.contain.picture, "odd-pic")));
  });

  it("shows the title on a card with no picture", async () => {
    const p = runPage(markedPage(false), () => ({
      status: 200,
      body: answer({ title: "Renamed", shown: "Renamed" }),
    }));
    stubDialog(p);
    await save(p, "Renamed");
    expect(p.$("[data-card-title] a").textContent).toBe("Renamed");
    expect(p.$('[data-id="1"]').getAttribute("data-title")).toBe("Renamed");
    expect(p.$("#cards-error").textContent).toBe("");
  });
});
