import { afterEach, describe, expect, it, vi } from "vitest";
import type { Link } from "../core/types.js";
import { allPage } from "./all-page.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
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
) {
  const answer = (sent: Post): Answer =>
    sent.url === "/save" ? { status, body } : { status: 204 };
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
