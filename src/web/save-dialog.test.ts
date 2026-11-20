import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Link } from "../core/types.js";
import { allPage } from "./all-page.js";
import type { Ask } from "./ask-panel.js";
import { copyPage } from "./copy-page.js";
import { homePage } from "./home-page.js";
import { type Answer, type Post, runAskPage, runPage } from "./opened-test-kit.js";
import { page } from "./page.js";
import { saveForm } from "./save-form.js";

/**
 * Save in the top bar opens a dialog over the page (#329). These run the page's real scripts in
 * linkedom (`runPage`), on All links, which already runs a top-level `CARD_FETCH` of its own.
 */

const NOW = new Date("2026-10-14T12:00:00Z");
const NEWS = "https://news.example/a";
const SIGNED_OUT =
  "You were signed out. Sign in in another tab, then press Save again. What you typed is still here.";
const OFFLINE =
  "Couldn't reach Aye-AI-AI Links. Check your connection, then press Save again. Nothing was saved.";

const link = (id: string, over: Partial<Link> = {}): Link => ({
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
  ...over,
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
const all = () => allPage({ ...LIST, links: [link("1")] });

/** The answer `POST /save` gives, as `savedJson` writes it. */
const SAVED = {
  id: "7",
  created: true,
  whyKept: true,
  state: "active",
  savedAt: "2026-03-03T12:00:00.000Z",
  savedOn: "March 3",
  title: "A story",
  url: NEWS,
  why: "for the trip",
  initials: "AS",
};

const gate = () => {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

/** Answers `/save` with `save`, any other route with `others`' answer or a 204. */
const answering =
  (save: Answer, others: Record<string, Answer> = {}) =>
  (sent: Post): Answer =>
    sent.url === "/save" ? save : (others[sent.url] ?? { status: 204 });

type Dialog = HTMLElement & { open?: boolean };

/**
 * All links with its scripts running; `fill` types into the dialog's three fields. With `phone`,
 * the page's width queries answer as a phone's (through `runAskPage`, which has that switch).
 */
function start(
  answer: (sent: Post) => Answer = answering({ status: 200, body: SAVED }),
  { phone = false } = {},
) {
  const p = phone ? runAskPage(all(), answer, { phone: true }) : runPage(all(), answer);
  const dialog = p.$("#save-dialog") as Dialog | null;
  const field = (id: string) => p.$(`#save-dialog #${id}`) as HTMLInputElement;
  const pill = p.$("nav.menu a.menu-save");
  const openIt = () => {
    const click = p.dispatch(pill, "click", { button: 0 });
    expect(click.defaultPrevented, "the Save pill opens the save dialog").toBe(true);
    return click;
  };
  const fill = (url = NEWS, title = "A story", why = "for the trip") => {
    field("save-url").value = url;
    field("save-title").value = title;
    field("save-why").value = why;
  };
  const values = () => [
    field("save-url").value,
    field("save-title").value,
    field("save-why").value,
  ];
  const save = () => p.dispatch(p.$("#save-dialog form"), "submit");
  const posts = () => p.sent.filter((s) => s.url !== "/links/opened");
  /** A press and release on the dimmed page around the dialog, which the dialog itself receives. */
  const backdrop = () => {
    p.dispatch(p.$("#save-dialog"), "pointerdown");
    p.dispatch(p.$("#save-dialog"), "click");
  };
  return { ...p, dialog, field, pill, openIt, fill, values, save, posts, backdrop };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Save pill", () => {
  it("opens the dialog and sends nothing; the cursor goes to Address", () => {
    const p = start();
    const click = p.openIt();
    expect(click.defaultPrevented, "a plain click opens the dialog in place").toBe(true);
    expect(p.dialog?.open).toBe(true);
    expect(p.sent).toEqual([]);
    expect(p.focused().at(-1)).toBe(p.field("save-url"));
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
  ])("a %s click is left to the browser, which opens /save", (_, keys) => {
    const p = start();
    expect(p.dialog, "save dialog").not.toBeNull();
    const click = p.dispatch(p.pill, "click", { button: 0, ...keys });
    expect(click.defaultPrevented).toBe(false);
    expect(p.dialog?.open).toBeFalsy();
  });

  it("from the phone menu, closes the menu first, and Cancel gives focus back to its summary", () => {
    const p = start();
    const menu = p.$("details.account-menu");
    menu.setAttribute("open", "");
    const item = p.$('details.account-menu a[href="/save"]');
    const click = p.dispatch(item, "click", { button: 0 });
    expect(click.defaultPrevented, "the phone menu's Save opens the dialog").toBe(true);
    expect(menu.hasAttribute("open")).toBe(false);
    expect(p.dialog?.open).toBe(true);
    p.dispatch(p.$("#save-dialog .edit-foot [data-save=cancel]"), "click");
    expect(p.dialog?.open).toBe(false);
    expect(p.focused().at(-1)).toBe(p.$("details.account-menu summary"));
  });

  it("Cancel gives focus back to the pill", () => {
    const p = start();
    p.openIt();
    p.dispatch(p.$("#save-dialog .edit-foot [data-save=cancel]"), "click");
    expect(p.dialog?.open).toBe(false);
    expect(p.focused().at(-1)).toBe(p.pill);
  });
});

describe("saving", () => {
  it("posts /save; on created it closes, then the Undo bar's Undo deletes that link", async () => {
    const p = start();
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    expect(p.posts()[0], "Save posts the fields to /save").toEqual({
      url: "/save",
      body: { url: NEWS, title: "A story", why: "for the trip" },
      redirect: "manual",
      keepalive: undefined,
    });
    expect(p.dialog?.open).toBe(false);
    expect(p.$("#undo-bar").hidden).toBe(false);
    expect(p.$("#undo-bar span").textContent).toBe("Saved “A story”.");
    // The bar took focus after the dialog had closed and given it back.
    expect(p.focused().slice(-2)).toEqual([p.pill, p.$("#undo-bar button")]);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.posts().slice(1)).toEqual([
      { url: "/links/delete", body: { id: "7" }, redirect: "manual", keepalive: undefined },
    ]);
    expect(p.$("#page-alert").textContent).toBe("");
  });

  it("names a saved link with no title by its site", async () => {
    const p = start(answering({ status: 200, body: { ...SAVED, title: null } }));
    p.openIt();
    p.fill(NEWS, "");
    p.save();
    await p.settle();
    expect(p.$("#undo-bar span").textContent).toBe("Saved “news.example”.");
  });

  it("a failed Undo shows its message in the page's alert", async () => {
    const message = "That link is not there any more. Reload the page.";
    const p = start(
      answering(
        { status: 200, body: SAVED },
        { "/links/delete": { status: 404, body: { code: "not_found", message } } },
      ),
    );
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.$("#page-alert")?.textContent, "the page's alert").toBe(message);
    expect(p.$("#page-alert").getAttribute("role")).toBe("alert");
  });

  it("a failed Undo's alert clears when the next action offers its Undo", async () => {
    const p = start((sent) =>
      sent.url === "/save"
        ? { status: 200, body: SAVED }
        : sent.url === "/links/delete" && (sent.body as { id: string }).id === "7"
          ? { status: 404, body: { code: "not_found", message: "Gone." } }
          : { status: 204 },
    );
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.$("#page-alert").textContent, "the failed Undo's message").toBe("Gone.");
    p.dispatch(p.$("[data-id='1'] button[data-act=delete-link]"), "click");
    await p.settle();
    expect(p.$("#undo-bar span").textContent, "the next action's Undo").toBe("Link deleted.");
    expect(p.$("#page-alert").textContent).toBe("");
  });

  it("says Saving… on the Save button after 300ms unanswered, and dims the form", async () => {
    const slow = gate();
    const p = start(answering({ status: 200, body: SAVED, wait: slow.wait }));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    const button = p.$("#save-dialog .edit-foot button.primary");
    expect(p.timers.pending(300), "the busy look waits 300ms").toBe(1);
    expect(button.querySelector("b")?.textContent).toBe("Save");
    p.timers.fire();
    expect(button.querySelector("b")?.textContent).toBe("Saving…");
    expect(p.$("#save-dialog form").hasAttribute("data-busy")).toBe(true);
    slow.open();
    await p.settle();
    expect(p.document.querySelector("[data-busy]")).toBeNull();
  });

  it("on a computer, Enter (which Chrome sends through the hidden top Save) says Saving… on the foot's Save", async () => {
    const slow = gate();
    const p = start(answering({ status: 200, body: SAVED, wait: slow.wait }));
    p.openIt();
    p.fill();
    const top = p.$("#save-dialog .edit-head [data-save=save]");
    p.dispatch(p.$("#save-dialog form"), "submit", { submitter: top });
    await p.settle();
    p.timers.fire();
    expect(p.$("#save-dialog .edit-foot .primary b").textContent).toBe("Saving…");
    expect(top.querySelector("b")?.textContent).toBe("Save");
    slow.open();
    await p.settle();
  });

  it("on a phone, says Saving… on the top Save, the one on screen", async () => {
    const slow = gate();
    const p = start(answering({ status: 200, body: SAVED, wait: slow.wait }), { phone: true });
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    p.timers.fire();
    expect(p.$("#save-dialog .edit-head [data-save=save] b").textContent).toBe("Saving…");
    slow.open();
    await p.settle();
  });

  it("a new link answered after the browser closed the dialog still offers its Undo", async () => {
    const slow = gate();
    const p = start(answering({ status: 200, body: SAVED, wait: slow.wait }));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    // Chrome closes a modal on a second Escape even while its cancel event is refused.
    (p.dialog as HTMLElement & { close(): void }).close();
    slow.open();
    await p.settle();
    expect(p.$("#undo-bar").hidden, "the late save's Undo").toBe(false);
    expect(p.$("#undo-bar span").textContent).toBe("Saved “A story”.");
    p.openIt();
    expect(p.values()).toEqual(["", "", ""]);
  });

  it("sends one Save while one is out", async () => {
    const slow = gate();
    const p = start(answering({ status: 200, body: SAVED, wait: slow.wait }));
    p.openIt();
    p.fill();
    p.save();
    p.save();
    slow.open();
    await p.settle();
    expect(p.posts().filter((s) => s.url === "/save")).toHaveLength(1);
  });

  it("ignores Cancel, Escape and a backdrop click while saving", async () => {
    const slow = gate();
    const p = start(answering({ status: 200, body: SAVED, wait: slow.wait }));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    p.dispatch(p.$("#save-dialog .edit-foot [data-save=cancel]"), "click");
    expect(p.dialog?.open, "Cancel while saving").toBe(true);
    const escapeKey = p.dispatch(p.$("#save-dialog"), "cancel");
    expect(escapeKey.defaultPrevented).toBe(true);
    p.backdrop();
    expect(p.dialog?.open).toBe(true);
    slow.open();
    await p.settle();
    expect(p.dialog?.open).toBe(false);
  });

  it("a backdrop click closes it when idle; a click inside, or a drag out of a field, does not", () => {
    const p = start();
    p.openIt();
    p.dispatch(p.field("save-url"), "pointerdown");
    p.dispatch(p.field("save-url"), "click");
    expect(p.dialog?.open, "a click inside the dialog").toBe(true);
    // Selecting text and letting go outside the field ends with a click on the dialog itself.
    p.dispatch(p.field("save-url"), "pointerdown");
    p.dispatch(p.$("#save-dialog"), "click");
    expect(p.dialog?.open, "a drag out of a field").toBe(true);
    p.backdrop();
    expect(p.dialog?.open).toBe(false);
  });

  it("reopens empty after a save, and keeps the text after Cancel", async () => {
    const p = start();
    p.openIt();
    p.fill();
    p.dispatch(p.$("#save-dialog .edit-foot [data-save=cancel]"), "click");
    p.openIt();
    expect(p.values(), "after Cancel").toEqual([NEWS, "A story", "for the trip"]);
    p.save();
    await p.settle();
    expect(p.dialog?.open).toBe(false);
    p.openIt();
    expect(p.values()).toEqual(["", "", ""]);
  });
});

describe("refusals and failures keep what was typed", () => {
  it("an invalid_url refusal shows under Address", async () => {
    const message = "Only http and https links can be saved, not ftp:. Use the page's web address.";
    const p = start(answering({ status: 400, body: { code: "invalid_url", message } }));
    p.openIt();
    p.fill("ftp://x", "A story", "for the trip");
    p.save();
    await p.settle();
    expect(p.$("#save-dialog #url-error")?.textContent, "the Address error").toBe(message);
    expect(p.dialog?.open).toBe(true);
    expect(p.values()).toEqual(["ftp://x", "A story", "for the trip"]);
    expect(p.$("#save-dialog #save-error").textContent).toBe("");
  });

  it.each([
    ["signed out", { status: 0, type: "opaqueredirect" }, SIGNED_OUT],
    ["offline", { status: 0, networkFails: true }, OFFLINE],
  ])("%s: says so in the dialog's alert", async (_, answer, text) => {
    const p = start(answering(answer as Answer));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    expect(p.$("#save-dialog #save-error")?.textContent, "the dialog's alert").toBe(text);
    expect(p.dialog?.open).toBe(true);
    expect(p.values()).toEqual([NEWS, "A story", "for the trip"]);
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("the form does not use the browser's own validation", () => {
    const p = start();
    expect(p.$("#save-dialog form")?.hasAttribute("novalidate"), "novalidate").toBe(true);
  });
});

describe("an address already saved", () => {
  const ALREADY = {
    ...SAVED,
    created: false,
    state: "archived",
  };

  it("shows the link, its why and Bring it back, and Bring it back works in place", async () => {
    const change = {
      before: { state: "archived", snoozedUntil: null },
      after: { state: "active" },
    };
    const p = start(
      answering(
        { status: 200, body: ALREADY },
        { "/home/bring-back": { status: 200, body: change } },
      ),
    );
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    const found = p.$("#save-dialog [data-save-part=found]");
    expect(found, "the already-saved part").not.toBeNull();
    expect(p.dialog?.open).toBe(true);
    expect(found.hidden).toBe(false);
    expect(p.$("#save-dialog [data-save-part=fields]").hidden).toBe(true);
    expect(found.textContent).toContain("A story");
    expect(found.textContent).toContain("Already saved on March 3");
    expect(found.textContent).toContain("Archived");
    expect(found.textContent).toContain("for the trip");
    const open = p.$("#save-dialog [data-save=open]");
    expect(open.getAttribute("href")).toBe(NEWS);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.closest("[data-id]")?.getAttribute("data-id")).toBe("7");
    const back = p.$("#save-dialog [data-save=bring-back]");
    expect(back.hidden).toBe(false);
    expect(p.$("#undo-bar").hidden).toBe(true);
    p.dispatch(back, "click");
    await p.settle();
    expect(p.posts().slice(1)).toEqual([
      { url: "/home/bring-back", body: { id: "7" }, redirect: "manual", keepalive: undefined },
    ]);
    expect(p.dialog?.open).toBe(true);
    expect(back.hidden).toBe(true);
    expect(found.textContent).not.toContain("Archived");
    expect(p.$("#save-dialog-title").textContent).toBe("Brought back");
  });

  it("shows an inferred why as a guess, without the label", async () => {
    const p = start(
      answering({ status: 200, body: { ...ALREADY, why: "maybe this", whySource: "inferred" } }),
    );
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    const why = p.$("#save-dialog .save-found-why");
    expect(why.textContent).toBe("Why (a guess): maybe this");
    expect(why.hidden).toBe(false);
  });

  it("says when the owner's why was not kept", async () => {
    const p = start(
      answering({ status: 200, body: { ...ALREADY, whyKept: false, why: "theirs" } }),
    );
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    expect(p.$("#save-dialog [data-save-part=found]")?.textContent).toContain(
      "It already had a reason, so yours wasn't saved: “for the trip”",
    );
  });

  it("opening it is recorded, and the dialog reopens empty", async () => {
    const p = start(answering({ status: 200, body: { ...ALREADY, state: "active" } }));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    expect(p.$("#save-dialog [data-save=bring-back]")?.hidden).toBe(true);
    p.dispatch(p.$("#save-dialog [data-save=open]"), "click");
    await p.settle();
    expect(p.sent.at(-1)).toEqual({
      url: "/links/opened",
      body: { id: "7" },
      redirect: "manual",
      keepalive: true,
    });
    p.dispatch(p.$("#save-dialog .edit-close"), "click");
    p.openIt();
    expect(p.values()).toEqual(["", "", ""]);
    expect(p.$("#save-dialog [data-save-part=fields]").hidden).toBe(false);
  });

  it("an archived link says Archived", async () => {
    const p = start(answering({ status: 200, body: { ...ALREADY } }));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    expect(p.$("#save-dialog .save-found-line").textContent).toBe(
      "Already saved on March 3 · news.example · Archived",
    );
  });

  it("a link with no title shows its address", async () => {
    const p = start(answering({ status: 200, body: { ...ALREADY, title: null, why: null } }));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    expect(p.$("#save-dialog .save-found-title").textContent).toBe(NEWS);
    expect(p.$("#save-dialog .save-found-why").hidden).toBe(true);
  });

  it("shows an answer's title and why as text, never as markup", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const p = start(answering({ status: 200, body: { ...ALREADY, title: hostile, why: hostile } }));
    p.openIt();
    p.fill(NEWS, "A story", hostile);
    p.save();
    await p.settle();
    expect(p.$("#save-dialog").querySelectorAll("img")).toHaveLength(0);
    expect(p.$("#save-dialog .save-found-title").textContent).toBe(hostile);
  });

  it.each([
    [409, "That link was changed since, so it stays as it is. Reload the page."],
    [404, "That link is gone. Reload the page."],
  ])("Bring it back refused with %i shows the route's message", async (status, message) => {
    const p = start(
      answering(
        { status: 200, body: ALREADY },
        { "/home/bring-back": { status, body: { code: "x", message } } },
      ),
    );
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    p.dispatch(p.$("#save-dialog [data-save=bring-back]"), "click");
    await p.settle();
    expect(p.$("#save-dialog #save-error").textContent).toBe(message);
    expect(p.$("#save-dialog [data-save=bring-back]").hidden).toBe(false);
  });

  it.each([
    ["a success", { status: 200, body: {} }],
    ["a refusal", { status: 409, body: { code: "x", message: "Changed." } }],
  ])(
    "Bring it back answered with %s after the dialog was closed leaves the reopened dialog clean",
    async (_name, answer) => {
      const slow = gate();
      const p = start(
        answering(
          { status: 200, body: ALREADY },
          { "/home/bring-back": { ...answer, wait: slow.wait } },
        ),
      );
      p.openIt();
      p.fill();
      p.save();
      await p.settle();
      p.dispatch(p.$("#save-dialog [data-save=bring-back]"), "click");
      await p.settle();
      (p.dialog as HTMLElement & { close(): void }).close();
      slow.open();
      await p.settle();
      p.openIt();
      expect(p.$("#save-dialog-title").textContent).toBe("Save a link");
      expect(p.$("#save-dialog #save-error").textContent).toBe("");
    },
  );

  it("Bring it back sends one POST for two clicks, and says Bringing back… after 300ms", async () => {
    const slow = gate();
    const p = start(
      answering(
        { status: 200, body: ALREADY },
        { "/home/bring-back": { status: 200, body: {}, wait: slow.wait } },
      ),
    );
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    const back = p.$("#save-dialog [data-save=bring-back]");
    p.dispatch(back, "click");
    p.dispatch(back, "click");
    await p.settle();
    p.timers.fire();
    expect(back.textContent).toBe("Bringing back…");
    slow.open();
    await p.settle();
    expect(p.posts().filter((s) => s.url === "/home/bring-back")).toHaveLength(1);
  });
});

describe("more refusals", () => {
  it.each([
    ["invalid_input", "#title-error", "A title can be at most 200 characters."],
    ["BAD_REQUEST", "#save-error", "Send a JSON body with url and title and why."],
  ])("a %s refusal shows its message in its place", async (code, where, message) => {
    const p = start(answering({ status: 400, body: { code, message } }));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    expect(p.$(`#save-dialog ${where}`).textContent).toBe(message);
  });

  it.each([
    ["a 500", { status: 500 }],
    ["a 400 whose body is not JSON", { status: 400 }],
  ])("%s shows the general message, and a second Save sends again", async (_, answer) => {
    const p = start(answering(answer));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    expect(p.$("#save-dialog #save-error").textContent).toBe(
      "That did not work. Reload the page and try again.",
    );
    p.save();
    await p.settle();
    expect(p.posts().filter((s) => s.url === "/save")).toHaveLength(2);
  });

  it("editing the address updates the host line and the letter, and hides both for a non-address", () => {
    const p = start();
    p.openIt();
    p.field("save-url").value = "https://www.other.example/x";
    p.dispatch(p.field("save-url"), "input");
    expect(p.$("#save-dialog .save-host").textContent).toBe("Saving a page from www.other.example");
    expect(p.$("#save-dialog .save-host").hidden).toBe(false);
    expect(p.$("#save-dialog .save-letter").textContent).toBe("O");
    p.field("save-url").value = "nonsense";
    p.dispatch(p.field("save-url"), "input");
    expect(p.$("#save-dialog .save-host").hidden).toBe(true);
    expect(p.$("#save-dialog .save-letter").textContent).toBe("");
  });
});

describe("the /save page", () => {
  const bookmarklet = () => saveForm({ url: NEWS, title: "A story", long: false });

  it("opens the dialog from its query at load, and shows Saved in place", async () => {
    vi.stubGlobal("history", { replaceState: () => {} });
    const p = runPage(bookmarklet(), answering({ status: 200, body: SAVED }));
    const dialog = p.$("#save-dialog") as Dialog | null;
    expect(dialog?.open, "the dialog is open at load").toBe(true);
    expect((p.$("#save-dialog #save-url") as HTMLInputElement).value).toBe(NEWS);
    expect((p.$("#save-dialog #save-title") as HTMLInputElement).value).toBe("A story");
    p.dispatch(p.$("#save-dialog form"), "submit");
    await p.settle();
    expect(dialog?.open).toBe(true);
    expect(p.$("#save-dialog-title").textContent).toBe("Saved");
    expect(p.$("#save-dialog [data-save=close]").hidden).toBe(false);
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("Close closes the tab, or goes Home when the browser keeps it", async () => {
    vi.stubGlobal("history", { replaceState: () => {} });
    const p = runPage(bookmarklet(), answering({ status: 200, body: SAVED }));
    expect(p.$("#save-dialog"), "save dialog").not.toBeNull();
    p.dispatch(p.$("#save-dialog form"), "submit");
    await p.settle();
    const went: string[] = [];
    const win = p.document.defaultView as unknown as { close: () => void; closed: boolean };
    win.close = () => {};
    win.closed = false;
    Object.assign(p.location, { assign: (to: string) => went.push(to) });
    p.dispatch(p.$("#save-dialog [data-save=close]"), "click");
    expect(went).toEqual(["/"]);
  });

  describe("after an answer, the head Close and Escape leave like Close", () => {
    const ALREADY_SAVED = { ...SAVED, created: false };

    /** The page with one answer shown, and the ways out recorded. */
    const answered = async (body: object) => {
      vi.stubGlobal("history", { replaceState: () => {} });
      const p = runPage(bookmarklet(), answering({ status: 200, body }));
      p.dispatch(p.$("#save-dialog form"), "submit");
      await p.settle();
      const went: string[] = [];
      const win = p.document.defaultView as unknown as { close: () => void; closed: boolean };
      win.close = () => {};
      win.closed = false;
      Object.assign(p.location, { assign: (to: string) => went.push(to) });
      return { p, went };
    };

    it("shows Close after Already saved", async () => {
      const { p } = await answered(ALREADY_SAVED);
      expect(p.$("#save-dialog [data-save=close]").hidden).toBe(false);
    });

    it.each(["#save-dialog .edit-top[data-save=cancel]", "#save-dialog .edit-close"])(
      "%s leaves after Saved",
      async (selector) => {
        const { p, went } = await answered(SAVED);
        p.dispatch(p.$(selector), "click");
        expect(went).toEqual(["/"]);
      },
    );

    it("Escape leaves after an answer", async () => {
      const { p, went } = await answered(ALREADY_SAVED);
      const esc = p.dispatch(p.$("#save-dialog"), "cancel");
      expect(went).toEqual(["/"]);
      expect(esc.defaultPrevented, "the dialog stays for the tab to go").toBe(true);
    });

    it("before an answer, Escape and Cancel only close the dialog", () => {
      vi.stubGlobal("history", { replaceState: () => {} });
      const p = runPage(bookmarklet(), answering({ status: 200, body: SAVED }));
      const went: string[] = [];
      Object.assign(p.location, { assign: (to: string) => went.push(to) });
      const esc = p.dispatch(p.$("#save-dialog"), "cancel");
      p.dispatch(p.$("#save-dialog .edit-top[data-save=cancel]"), "click");
      expect(went).toEqual([]);
      expect(esc.defaultPrevented).toBe(false);
      expect((p.$("#save-dialog") as Dialog).open).toBe(false);
    });
  });

  it("has the menu but no Ask panel and no owner id", () => {
    const html = bookmarklet();
    const d = parseHTML(html).document;
    expect(d.querySelector("nav.menu"), "the menu").not.toBeNull();
    expect(d.getElementById("ask-panel")).toBeNull();
    expect(html).not.toContain("data-owner");
  });

  it("a page other than /save: after Already saved, the head Close only closes the dialog", async () => {
    const p = start(answering({ status: 200, body: { ...SAVED, created: false } }));
    p.openIt();
    p.fill();
    p.save();
    await p.settle();
    const went: string[] = [];
    const win = p.document.defaultView as unknown as { close: () => void; closed: boolean };
    let closed = 0;
    win.close = () => closed++;
    Object.assign(p.location, { assign: (to: string) => went.push(to) });
    p.dispatch(p.$("#save-dialog .edit-top[data-save=cancel]"), "click");
    expect(p.dialog?.open).toBe(false);
    expect([went, closed]).toEqual([[], 0]);
  });

  it("with a long address, says so and leaves the dialog closed and empty", () => {
    const p = runPage(saveForm({ url: "", title: "", long: true }));
    expect(p.$("main")?.textContent).toContain(
      "This page's address is too long to save from the bookmarklet.",
    );
    expect((p.$("#save-dialog") as Dialog | null)?.open, "the dialog").toBeFalsy();
  });
});

describe("every page with the menu", () => {
  const ASK: Ask = { ai: "Claude", place: "the page", owner: "o1" };
  const COPY = {
    markdown: "A paragraph.",
    madeAt: NOW,
    finished: true,
    nonce: null,
    images: new Map(),
  };
  const copy = () =>
    copyPage({ link: link("3"), madeAt: NOW, copy: COPY }, NOW, {
      label: "All links",
      href: "/all",
    });
  const home = () =>
    homePage({
      worth: { links: [], images: new Map(), now: NOW, catalog: [] },
      shelf: "",
      spaces: "",
    });

  it.each([
    ["All links", all],
    ["Home", home],
    ["the copy page", copy],
    ["/save", () => saveForm({ url: NEWS, title: "T", long: false })],
    ["/save, too long", () => saveForm({ url: "", title: "", long: true })],
    ["a page with Ask", () => allPage({ ...LIST, links: [link("1")], ask: ASK })],
  ])(
    "%s has exactly one #save-url, in a dialog that is a body child, with no style=",
    (_, html) => {
      const d = parseHTML(html()).document;
      expect(d.querySelectorAll('[id="save-url"]'), "one Address field").toHaveLength(1);
      const dialog = d.getElementById("save-dialog");
      expect(dialog?.parentElement).toBe(d.body);
      expect(dialog?.outerHTML).not.toContain("style=");
      expect(d.querySelectorAll('[id="page-alert"]')).toHaveLength(1);
    },
  );

  it("the copy page runs its scripts and opens the dialog", () => {
    const p = runPage(copy());
    const click = p.dispatch(p.$("nav.menu a.menu-save"), "click", { button: 0 });
    expect(click.defaultPrevented, "the pill opens the dialog").toBe(true);
    expect((p.$("#save-dialog") as Dialog).open).toBe(true);
  });

  it("a page with Ask runs every script, the menu's too, and opens the dialog", () => {
    const p = runAskPage(allPage({ ...LIST, links: [link("1")], ask: ASK }), undefined, {
      menu: true,
    });
    const click = p.dispatch(p.$("nav.menu a.menu-save"), "click", { button: 0 });
    expect(click.defaultPrevented, "the pill opens the dialog").toBe(true);
    expect((p.$("#save-dialog") as Dialog).open).toBe(true);
  });

  it("a page without the menu has no dialog and no Undo bar", () => {
    const html = page("t", "<main></main>");
    expect(html).not.toContain('id="save-dialog"');
    expect(html).not.toContain('id="undo-bar"');
  });
});
