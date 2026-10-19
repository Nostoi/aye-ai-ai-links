import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { searchPage } from "./pages.js";
import { spacePage } from "./space-page.js";

const NOW = new Date("2026-10-17T12:00:00Z");
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
const link = (id: string, savedAt = NOW): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  why: { text: `because ${id}`, source: "stated" },
  tags: [
    { key: "kitchen", name: "Kitchen", source: "stated", kind: "topic", kindSource: "stated" },
  ],
  savedAt,
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});
const TOO_LATE = {
  code: "not_found",
  message: "It's too late to undo: the link was deleted for good.",
};
const post = (url: string, body: unknown): Post => ({
  url,
  body,
  redirect: "manual",
  keepalive: undefined,
});
const DELETE = "[data-id='7'] button[data-act=delete-link]";

/** A search page with cards "7" then "8". */
const load = (answer: (sent: Post) => Answer = () => ({ status: 204 })) => {
  const p = runPage(searchPage({ query: "", links: [link("7"), link("8")], now: NOW }), answer);
  return { ...p, dialog: stubDialog(p) };
};
const click = async (p: ReturnType<typeof runPage>, selector: string) => {
  p.dispatch(p.$(selector), "click");
  await p.settle();
};

describe("Delete link from the ⋯ menu", () => {
  it("the menu row posts the delete, removes the card, focuses the next card's ⋯ and offers Undo", async () => {
    const p = load();
    const menu = p.$("[data-id='7'] details.card-menu") as HTMLDetailsElement;
    menu.open = true;
    await click(p, DELETE);
    expect(p.sent).toEqual([post("/links/delete", { id: "7" })]);
    expect(p.$("[data-id='7']")).toBeNull();
    // The next card's ⋯ takes focus before the bar's Undo, so the bar hands it back there.
    expect(p.focused().at(-2)).toBe(p.$("[data-id='8'] .card-menu summary"));
    expect(p.focused().at(-1)).toBe(p.$("#undo-bar button"));
    expect(p.$("#undo-bar").hidden).toBe(false);
    expect(p.$("#undo-bar span").textContent).toBe("Link deleted.");
  });

  it("sends one request for a second click while the first is waiting", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = load(() => ({ status: 204, wait }));
    const button = p.$(DELETE);
    p.dispatch(button, "click");
    p.dispatch(button, "click");
    release();
    await p.settle();
    expect(p.sent).toEqual([post("/links/delete", { id: "7" })]);
  });

  it("Undo posts the restore and puts the same card back where it was", async () => {
    const p = load();
    const card = p.$("[data-id='7']");
    await click(p, DELETE);
    await click(p, "#undo-bar button");
    expect(p.sent[1]).toEqual(post("/links/restore", { id: "7" }));
    expect(p.$("[data-id='7']")).toBe(card);
    expect(card.nextElementSibling).toBe(p.$("[data-id='8']"));
    expect(p.$("#results-error").textContent).toBe("");
  });

  it("a too-late Undo shows the refusal's message and leaves the card out", async () => {
    const p = load((s) =>
      s.url === "/links/restore" ? { status: 404, body: TOO_LATE } : { status: 204 },
    );
    await click(p, DELETE);
    await click(p, "#undo-bar button");
    expect(p.$("#results-error").textContent).toBe(TOO_LATE.message);
    expect(p.$("[data-id='7']")).toBeNull();
  });

  it("a refused delete leaves the card and shows the message", async () => {
    const message = "That link is not there any more. Reload the page.";
    const p = load(() => ({ status: 404, body: { code: "not_found", message } }));
    await click(p, DELETE);
    expect(p.$("#results-error").textContent).toBe(message);
    expect(p.$("[data-id='7']")).not.toBeNull();
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("deleting the only card of a month hides the month and Undo shows it again", async () => {
    const html = allPage({
      order: "newest",
      links: [link("7"), link("8", new Date("2026-09-10T12:00:00Z"))],
      older: null,
      catalog: [KITCHEN],
      images: new Map(),
      handy: new Map(),
      now: NOW,
      done: false,
    });
    const p = runPage(html);
    const month = p.$("[data-id='7']").closest("section.month") as HTMLElement;
    const other = p.$("[data-id='8']").closest("section.month") as HTMLElement;
    expect(month).not.toBe(other);
    await click(p, DELETE);
    expect(month.hidden).toBe(true);
    expect(other.hidden).toBe(false);
    await click(p, "#undo-bar button");
    expect(month.hidden).toBe(false);
    expect(month.querySelector("[data-id='7']")).not.toBeNull();
  });

  it("focuses the heading when the last card is deleted", async () => {
    const p = load();
    await click(p, "[data-id='8'] button[data-act=delete-link]");
    const h1 = p.$("h1");
    expect(h1.getAttribute("tabindex")).toBe("-1");
    expect(p.focused().at(-2)).toBe(h1);
  });
});

describe("Delete link in the edit dialog", () => {
  const open = (p: ReturnType<typeof load>) =>
    p.dispatch(p.$("[data-id='7'] button[data-act=edit]"), "click");

  it("the dialog's Delete discards the edit, closes the dialog and deletes the card", async () => {
    const p = load();
    open(p);
    expect(p.dialog.open).toBe(true);
    (p.$("#edit-title") as HTMLInputElement).value = "Unsaved";
    await click(p, "#edit-link [data-edit=delete]");
    expect(p.dialog.open).toBe(false);
    expect(p.sent).toEqual([post("/links/delete", { id: "7" })]);
    expect(p.$("[data-id='7']")).toBeNull();
    expect(p.$("#undo-bar span").textContent).toBe("Link deleted.");
  });

  it("the dialog's Delete is disabled while a Save is answered", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = load((s) => (s.url === "/links/edit" ? { status: 409, wait } : { status: 204 }));
    open(p);
    (p.$("#edit-title") as HTMLInputElement).value = "New";
    p.dispatch(p.$("#edit-link form"), "submit");
    await p.settle();
    const button = p.$("#edit-link [data-edit=delete]") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await click(p, "#edit-link [data-edit=delete]");
    expect(p.sent.map((s) => s.url)).toEqual(["/links/edit"]);
    expect(p.dialog.open).toBe(true);
    release();
    await p.settle();
    expect(button.disabled).toBe(false);
  });

  it("the dialog's Delete is outside .edit-foot", () => {
    const p = load();
    expect(p.$("#edit-link .edit-foot [data-edit=delete]")).toBeNull();
    expect(p.$("#edit-link [data-edit=delete]")?.textContent).toBe("Delete link");
  });
});

describe("the menu's Delete link row", () => {
  const lastRows = (html: string) =>
    [...runPage(html).document.querySelectorAll(".card-menu-list")].map((list) => {
      const last = list.lastElementChild;
      return `${last?.tagName} ${last?.getAttribute("data-act")} ${last?.textContent}`;
    });
  const copies = new Map([["7", { madeAt: NOW }]]);
  const links = [link("7"), link("8")];
  const common = { links, older: null, images: new Map(), handy: new Map(), now: NOW, done: false };

  it.each([
    ["search", searchPage({ query: "", links, now: NOW, copies })],
    ["all", allPage({ ...common, order: "newest", catalog: [KITCHEN], copies })],
    ["space", spacePage({ ...common, tag: KITCHEN, catalog: [KITCHEN], copies })],
  ])("the menu's last row is Delete link on every card page (%s)", (_, html) => {
    expect(lastRows(html)).toEqual([
      "BUTTON delete-link Delete link",
      "BUTTON delete-link Delete link",
    ]);
  });
});
