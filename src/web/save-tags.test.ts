import { afterEach, describe, expect, it, vi } from "vitest";
import type { Link } from "../core/types.js";
import { allPage } from "./all-page.js";
import { type Answer, type Post, runAskPage, runPage } from "./opened-test-kit.js";
import { page } from "./page.js";

/** The Save dialog's Tags field (#352), with the page's real scripts running in linkedom. */

const NOW = new Date("2026-10-14T12:00:00Z");
const NEWS = "https://news.example/a";
const NAMES = ["Work", "Work habits", "Workplace", "Kitchen", "Garden"];

const link = (id: string): Link => ({
  id,
  url: `https://example.com/${id}`,
  urlKey: `example.com/${id}`,
  title: `Title ${id}`,
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt: NOW,
  savedBy: "t",
  lastOpenedAt: null,
  intent: "explore",
  intentSource: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});

const LIST = {
  order: "newest" as const,
  older: null,
  catalog: [],
  images: new Map(),
  handy: new Map(),
  now: NOW,
  done: false,
};

const NEW_LINK = {
  id: "7",
  created: true,
  whyKept: true,
  state: "active",
  savedAt: "2026-03-03T12:00:00.000Z",
  savedOn: "March 3",
  title: "A story",
  url: NEWS,
  why: null,
  whySource: null,
  initials: "AS",
  tagsAdded: [] as string[],
  tagsHad: [] as string[],
};
const ALREADY = { ...NEW_LINK, created: false, tagsAdded: ["meetings"], tagsHad: ["Work"] };

type Page = ReturnType<typeof start>;

/** All links with its scripts running; `/save` answers `body`, and `/tags/names` answers NAMES. */
function start(
  body: unknown = NEW_LINK,
  html = allPage({ ...LIST, links: [link("1")] }),
  status = 200,
  others: Record<string, Answer> = {},
) {
  const answer = (sent: Post): Answer =>
    sent.url === "/save" ? { status, body } : (others[sent.url] ?? { status: 204 });
  const p = runPage(html, answer, () => ({ status: 200, body: { names: NAMES } }));
  const $s = (selector: string) => p.$(`#save-dialog ${selector}`);
  const chips = () =>
    [...p.document.querySelectorAll("#save-dialog .edit-tag")].map((c) => c.textContent?.trim());
  const suggestions = () =>
    [...p.document.querySelectorAll("#save-dialog .edit-suggest-item")].map((b) => b.textContent);
  const field = () => $s("#save-tag-input") as HTMLInputElement;
  const type = (text: string) => {
    field().value = text;
    p.dispatch(field(), "input");
  };
  const press = (key: string) => p.dispatch(field(), "keydown", { key });
  const open = async () => {
    p.dispatch(p.$("nav.menu a.menu-save"), "click", { button: 0 });
    await p.settle();
  };
  const fill = () => {
    ($s("#save-url") as HTMLInputElement).value = NEWS;
    ($s("#save-title") as HTMLInputElement).value = "A story";
  };
  const save = async () => {
    p.dispatch($s("form"), "submit");
    await p.settle();
  };
  const saves = () => p.sent.filter((s) => s.url === "/save");
  return { ...p, $s, chips, suggestions, field, type, press, open, fill, save, saves };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Save dialog's Tags field", () => {
  it("sits under the why, as the Edit link dialog's picker with its own field", () => {
    const p = start();
    const set = p.$s("fieldset.edit-tags");
    expect(set.querySelector("legend")?.textContent).toBe("Tags (optional)");
    expect(p.$s("#save-why").compareDocumentPosition(set) & 4, "after the why").toBeTruthy();
    expect(set.closest("[data-save-part=fields]"), "with the fields").not.toBeNull();
    const input = p.field();
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(set.querySelector("label")?.getAttribute("for")).toBe("save-tag-input");
    expect(set.querySelector("label")?.textContent).toBe("Add a tag");
    expect(p.document.querySelector("#edit-link #edit-tag-input")).not.toBeNull();
  });

  it("reads the owner's tag names when the dialog opens, and suggests them as you type", async () => {
    const p = start();
    expect(p.names).toHaveLength(0);
    await p.open();
    expect(p.names).toHaveLength(1);
    p.type("wor");
    expect(p.suggestions()).toEqual(["Work", "Work habits", "Workplace"]);
    p.type("zzz");
    expect(p.suggestions()).toEqual([]);
  });

  it("a click on a suggestion adds it, Enter adds the typed text, a repeat is ignored, x removes", async () => {
    const p = start();
    await p.open();
    p.type("kit");
    p.dispatch(p.$s(".edit-suggest-item"), "click");
    expect(p.chips()).toEqual(["Kitchen"]);
    expect(p.field().value).toBe("");
    p.type("  new   tag ");
    const enter = p.press("Enter");
    expect(enter.defaultPrevented, "Enter adds a tag and does not send the form").toBe(true);
    p.type("KITCHEN");
    p.press("Enter");
    expect(p.chips()).toEqual(["Kitchen", "new tag"]);
    p.dispatch(p.$s('.edit-tag-remove[data-key="kitchen"]'), "click");
    expect(p.chips()).toEqual(["new tag"]);
    expect(p.saves()).toEqual([]);
  });

  it("Save sends the chips and the text left in the field, as names", async () => {
    const p = start();
    await p.open();
    p.fill();
    p.type("Work");
    p.press("Enter");
    p.type("left over");
    await p.save();
    expect(p.saves()[0]?.body).toEqual({
      url: NEWS,
      title: "A story",
      why: "",
      tags: ["Work", "left over"],
    });
  });

  it("sends no tags member when there are none", async () => {
    const p = start();
    await p.open();
    p.fill();
    await p.save();
    expect(p.saves()[0]?.body).toEqual({ url: NEWS, title: "A story", why: "" });
  });

  it("a refusal keeps the chips and shows its message", async () => {
    const p = start({ code: "invalid_input", message: "Too long." }, undefined, 400);
    await p.open();
    p.fill();
    p.type("Work");
    p.press("Enter");
    await p.save();
    expect(p.saves()).toHaveLength(1);
    expect(p.chips()).toEqual(["Work"]);
    expect(p.$s("#title-error").textContent).toBe("Too long.");
  });

  it("a saved new link empties the chips for the next open", async () => {
    const p = start();
    await p.open();
    p.fill();
    p.type("Work");
    p.press("Enter");
    await p.save();
    await p.open();
    expect(p.chips()).toEqual([]);
    expect(p.field().value).toBe("");
  });

  it("empties the chips after an already-saved answer is closed", async () => {
    const p = start(ALREADY);
    await p.open();
    p.fill();
    p.type("meetings");
    p.press("Enter");
    await p.save();
    p.dispatch(p.$s("[data-save=cancel]"), "click");
    await p.open();
    expect(p.chips()).toEqual([]);
  });

  it("sends the page's list view with a save, so the card comes back as that list reads it", async () => {
    const html = page("Space", `<div id="list" data-within="kitchen" data-own="1"></div>`, {
      menu: true,
      undo: true,
    });
    const p = start(NEW_LINK, html);
    await p.open();
    p.fill();
    await p.save();
    expect(p.saves()[0]?.body).toMatchObject({ within: "kitchen", own: "1" });
  });
});

describe("the already-saved note", () => {
  const note = (p: Page) => {
    const el = p.$s(".save-tags-note");
    return { hidden: el.hidden, text: el.textContent };
  };
  const saveWith = async (body: unknown) => {
    const p = start(body);
    await p.open();
    p.fill();
    p.type("x");
    p.press("Enter");
    await p.save();
    return p;
  };

  it("names what it added and what it already had", async () => {
    const p = await saveWith({
      ...ALREADY,
      tagsAdded: ["meetings", "team retro"],
      tagsHad: ["Work"],
    });
    expect(note(p)).toEqual({
      hidden: false,
      text: "Added your tags: meetings, team retro. It already had Work.",
    });
    expect(
      [...p.document.querySelectorAll("#save-dialog .save-tags-note b")].map((b) => b.textContent),
    ).toEqual(["meetings", "team retro", "Work"]);
  });

  it("says only what was added", async () => {
    const p = await saveWith({ ...ALREADY, tagsAdded: ["meetings"], tagsHad: [] });
    expect(note(p)).toEqual({ hidden: false, text: "Added your tags: meetings." });
  });

  it("says only what it already had", async () => {
    const p = await saveWith({ ...ALREADY, tagsAdded: [], tagsHad: ["Work", "Home"] });
    expect(note(p)).toEqual({ hidden: false, text: "It already had Work, Home." });
  });

  it("is hidden when no tag was typed, and then cleared for the next answer", async () => {
    const p = await saveWith({ ...ALREADY, tagsAdded: [], tagsHad: [] });
    expect(note(p).hidden).toBe(true);
    expect(note(p).text).toBe("");
  });
});

const FOUND_CARD = {
  title: "Title 1",
  shown: "Title 1",
  url: "https://example.com/1",
  initials: "T1",
  version: null,
  fit: null,
  picture: { own: false, pageVersion: null, pageFit: null },
  tags: [
    { key: "work", name: "Work", source: "stated" },
    { key: "meetings", name: "meetings", source: "stated" },
  ],
  intent: "explore",
  intentSource: null,
  why: { text: "for the retro", source: "asked" },
  summary: null,
  space: { color: "clay" },
  lineSpace: null,
};
const FOUND_EDIT = {
  title: "Title 1",
  "page-title": "",
  version: "",
  fit: "",
  own: "0",
  "page-version": "",
  "page-fit": "",
  initials: "T1",
  tags: JSON.stringify(FOUND_CARD.tags),
  intent: "explore",
  "intent-source": "",
  why: "for the retro",
  "why-source": "asked",
};
const FOUND = {
  ...ALREADY,
  id: "1",
  title: "Title 1",
  url: "https://example.com/1",
  why: "for the retro",
  whySource: "asked",
  tagsAdded: ["meetings"],
  tagsHad: ["Work"],
  edit: FOUND_EDIT,
  card: FOUND_CARD,
};

describe("after a repeat save that added tags", () => {
  const card = (p: Page) => p.$('[data-id="1"]');
  const saveFound = async (body: unknown = FOUND) => {
    const p = start(body);
    await p.open();
    p.fill();
    p.type("meetings");
    p.press("Enter");
    await p.save();
    return p;
  };

  it("the page's card for that link shows the new tags, its space and its edit data", async () => {
    const p = await saveFound();
    expect(card(p).dataset.tags).toBe(JSON.stringify(FOUND_CARD.tags));
    expect(card(p).classList.contains("space-clay")).toBe(true);
    expect(card(p).dataset.why).toBe("for the retro");
  });

  it("Edit link opened next from that card starts from the new tags", async () => {
    const p = await saveFound();
    p.dispatch(p.$('[data-id="1"] button[data-act=edit]'), "click");
    await p.settle();
    const chips = [...p.document.querySelectorAll("#edit-link .edit-tag")].map((c) =>
      c.textContent?.trim(),
    );
    expect(chips).toEqual(["Work", "meetings"]);
  });

  it("a new link's save leaves the page's cards alone", async () => {
    const p = start(NEW_LINK);
    const before = card(p).dataset.tags;
    await p.open();
    p.fill();
    await p.save();
    expect(card(p).dataset.tags).toBe(before);
  });
});

describe("Edit link… on the already-saved view", () => {
  const button = (p: Page) => p.$s("[data-save=edit]");
  const found = async (body: unknown = FOUND, html?: string, others?: Record<string, Answer>) => {
    const p = start(body, html, 200, others);
    await p.open();
    p.fill();
    await p.save();
    return p;
  };

  it("shows beside Open it on a page with the Edit dialog", async () => {
    const p = await found();
    expect(button(p).hidden).toBe(false);
    expect(button(p).textContent).toBe("Edit link…");
    expect(p.$s(".save-found-acts").textContent).toContain("Open it");
  });

  it("is hidden on a page without the Edit dialog", async () => {
    const bare = page("Bare", "<p>hi</p>", { menu: true, undo: true });
    const p = await found(FOUND, bare);
    expect(p.document.getElementById("edit-link")).toBeNull();
    expect(button(p).hidden).toBe(true);
  });

  it("is hidden for a new link", async () => {
    const p = await found({ ...NEW_LINK });
    expect(button(p).hidden).toBe(true);
  });

  it("closes the Save dialog and opens Edit link filled as from the link's card", async () => {
    const p = await found();
    p.dispatch(button(p), "click");
    await p.settle();
    expect((p.$("#save-dialog") as HTMLElement & { open?: boolean }).open).toBe(false);
    expect((p.$("#edit-link") as HTMLElement & { open?: boolean }).open).toBe(true);
    expect((p.$("#edit-title") as HTMLInputElement).value).toBe("Title 1");
    expect((p.$("#edit-why") as HTMLTextAreaElement).value).toBe("for the retro");
    expect(
      [...p.document.querySelectorAll("#edit-link .edit-tag")].map((c) => c.textContent?.trim()),
    ).toEqual(["Work", "meetings"]);
  });

  it("a Save there writes that link, redraws its card on the page and offers Undo", async () => {
    const edited = { ...FOUND_CARD, title: "Renamed", shown: "Renamed", editId: "e9" };
    const p = await found(FOUND, undefined, { "/links/edit": { status: 200, body: edited } });
    p.dispatch(button(p), "click");
    await p.settle();
    (p.$("#edit-title") as HTMLInputElement).value = "Renamed";
    p.dispatch(p.$("#edit-link form"), "submit");
    await p.settle();
    const sent = p.sent.find((s) => s.url === "/links/edit");
    const fields = Object.fromEntries(
      [...((sent?.body as FormData | undefined)?.entries() ?? [])].map(([k, v]) => [k, String(v)]),
    );
    expect(fields).toEqual({ id: "1", title: "Renamed" });
    expect(p.$('[data-id="1"] [data-card-title]').textContent).toContain("Renamed");
    expect(p.$("#undo-bar span").textContent).toBe("Link updated");
  });
});

describe("with the Ask AI panel on", () => {
  it("Edit link… opens the dialog on the found link, and a repeat save redraws the page's cards", async () => {
    const html = allPage({
      ...LIST,
      links: [link("1")],
      ask: { ai: "Claude", place: "the page", owner: "o1" },
    });
    const p = runAskPage(
      html,
      (sent) => (sent.url === "/save" ? { status: 200, body: FOUND } : { status: 204 }),
      { menu: true },
    );
    p.dispatch(p.$("nav.menu a.menu-save"), "click", { button: 0 });
    await p.settle();
    (p.$("#save-url") as HTMLInputElement).value = NEWS;
    p.dispatch(p.$("#save-dialog form"), "submit");
    await p.settle();
    expect(p.$('[data-id="1"]').dataset.tags).toBe(JSON.stringify(FOUND_CARD.tags));
    p.dispatch(p.$("#save-dialog [data-save=edit]"), "click");
    await p.settle();
    expect((p.$("#edit-link") as HTMLElement & { open?: boolean }).open).toBe(true);
    expect((p.$("#edit-title") as HTMLInputElement).value).toBe("Title 1");
  });
});
