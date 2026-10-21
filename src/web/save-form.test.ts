import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { LONG_MESSAGE, SIGNED_OUT, saveForm } from "./save-form.js";

const NEWS = "https://news.example/a?b=1";
const doc = (html: string) => parseHTML(html).document;
const value = (html: string, id: string) => doc(html).getElementById(id)?.getAttribute("value");

describe("the Save page as served", () => {
  it("fills the address and title, shows the address's host, and leaves the why empty", () => {
    const html = saveForm({ url: NEWS, title: "A story", long: false });
    const d = doc(html);
    const address = d.getElementById("save-url");
    expect(address?.getAttribute("type")).toBe("url");
    expect(address?.hasAttribute("required")).toBe(true);
    expect(address?.getAttribute("value")).toBe(NEWS);
    expect(value(html, "save-title")).toBe("A story");
    expect(d.getElementById("save-host")?.textContent).toBe("Saving a page from news.example");
    expect(d.getElementById("save-host")?.hasAttribute("hidden")).toBe(false);
    expect(d.getElementById("save-why")?.tagName).toBe("TEXTAREA");
    expect(d.getElementById("save-why")?.textContent).toBe("");
    expect(d.querySelector('label[for="save-why"]')?.textContent).toBe(
      "Why are you saving it? (optional)",
    );
    expect(d.querySelector("#save-form button[type=submit]")?.textContent).toBe("Save");
    expect(d.getElementById("result")?.hasAttribute("hidden")).toBe(true);
    expect(d.getElementById("save-heading")?.textContent).toBe("Save a link");
  });

  it("escapes a hostile query into attribute values, never into markup or a script", () => {
    const url = `https://ex.com/"><script>alert(1)</script>`;
    const title = `"><img src=x onerror=alert(2)>`;
    const html = saveForm({ url, title, long: false });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    const d = doc(html);
    expect(d.querySelectorAll("img")).toHaveLength(0);
    expect(value(html, "save-url")).toBe(url);
    expect(value(html, "save-title")).toBe(title);
    for (const script of d.querySelectorAll("script")) {
      expect(script.textContent).not.toContain("alert(");
    }
  });

  it("has each id Task 5's script relies on exactly once, filled or empty", () => {
    const ids = [
      "save-heading",
      "save-form",
      "save-url",
      "save-host",
      "url-error",
      "save-title",
      "title-error",
      "save-why",
      "save-error",
      "result",
      "saved-link",
      "saved-why",
      "why-kept",
      "saved-state",
      "bring-back",
      "close",
      "close-note",
      "result-error",
    ];
    for (const o of [
      { url: NEWS, title: "A story" },
      { url: "", title: "" },
    ]) {
      const d = doc(saveForm({ ...o, long: false }));
      for (const id of ids) {
        expect(d.querySelectorAll(`[id="${id}"]`), id).toHaveLength(1);
      }
    }
  });

  it("round-trips ampersands, quotes, a closing textarea and a javascript: address as values", () => {
    const url = "javascript:alert(1)&a=1";
    const title = `Tom & Jerry's </textarea><b>x</b> "q"`;
    const html = saveForm({ url, title, long: false });
    const d = doc(html);
    expect(value(html, "save-url")).toBe(url);
    expect(value(html, "save-title")).toBe(title);
    expect(d.querySelectorAll("b")).toHaveLength(0);
    expect(d.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("hides the host line for an address that does not parse", () => {
    const d = doc(saveForm({ url: "not an address", title: "", long: false }));
    expect(d.getElementById("save-host")?.hasAttribute("hidden")).toBe(true);
  });

  it("is an empty add-a-link form with no query", () => {
    const html = saveForm({ url: "", title: "", long: false });
    expect(value(html, "save-url")).toBe("");
    expect(value(html, "save-title")).toBe("");
    expect(doc(html).getElementById("save-host")?.hasAttribute("hidden")).toBe(true);
  });

  it("long shows the long-address message and no form", () => {
    const d = doc(saveForm({ url: "", title: "", long: true }));
    expect(d.querySelector("form")).toBeNull();
    expect(d.querySelector("main")?.textContent).toContain(LONG_MESSAGE);
    expect(LONG_MESSAGE).toBe("This page's address is too long to save from the bookmarklet.");
  });

  it("makes no outside request; a filled form's only finding is the address field's own value", () => {
    expect(outsideRefs(saveForm({ url: "", title: "", long: false }))).toEqual([]);
    expect(outsideRefs(saveForm({ url: "", title: "", long: true }))).toEqual([]);
    expect(outsideRefs(saveForm({ url: "https://ex.com/a", title: "T", long: false }))).toEqual([
      "<input value=https://ex.com/a>",
    ]);
  });
});

type Answer = { status: number; type?: string; body?: unknown };
type Sent = { url: string; body: unknown; redirect: unknown; keepalive: unknown };

/** A manual redirect to sign-in, as `fetch` with `redirect: "manual"` reports it. */
const REDIRECT: Answer = { status: 0, type: "opaqueredirect" };

/**
 * The page in linkedom with its scripts run in one scope. `fetch` records each request and replies
 * with `answer`. `history.replaceState` is recorded. `window` is a fake whose `close()` closes the
 * tab only when `closes` is set.
 */
function load(answer: (sent: Sent) => Answer, { closes = false, url = NEWS } = {}) {
  const html = saveForm({ url, title: "A story", long: false });
  const { document, window } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .join("\n");
  const sent: Sent[] = [];
  const fetch = async (
    to: string,
    init: { body: string; redirect?: string; keepalive?: boolean },
  ) => {
    const request = {
      url: to,
      body: JSON.parse(init.body),
      redirect: init.redirect,
      keepalive: init.keepalive,
    };
    sent.push(request);
    const a = answer(request);
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      type: a.type ?? "basic",
      json: async () => {
        if (a.body === undefined) throw new SyntaxError("no body");
        return a.body;
      },
    };
  };
  const replaced: unknown[][] = [];
  const history = { replaceState: (...args: unknown[]) => replaced.push(args) };
  const tab = {
    closed: false,
    close: () => {
      if (closes) tab.closed = true;
    },
  };
  new Function("document", "fetch", "history", "window", code)(document, fetch, history, tab);
  const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
  const fire = (selector: string, type: string) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    $(selector).dispatchEvent(event);
    return event;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { $, fire, settle, sent, replaced, tab };
}

const ANSWER = {
  id: "7",
  created: false,
  whyKept: true,
  state: "active",
  savedAt: "2026-03-03T12:00:00.000Z",
  savedOn: "March 3",
  title: "A story",
  url: NEWS,
  why: "for the trip",
  putAwayAt: null,
};
const CHANGE = {
  before: { state: "archived", putAwayAt: null, snoozedUntil: null },
  after: { state: "active", putAwayAt: null },
};
const answering =
  (body: Record<string, unknown>, others: Record<string, Answer> = {}) =>
  (sent: Sent): Answer =>
    sent.url === "/save"
      ? { status: 200, body }
      : (others[sent.url] ??
        (sent.url === "/home/bring-back" ? { status: 200, body: CHANGE } : { status: 204 }));
const visible = (el: HTMLElement) => !el.hasAttribute("hidden");

describe("Save on the page", () => {
  it("posts the three fields without following a redirect, then shows Saved with Close and cleans the address", async () => {
    const page = load(answering({ ...ANSWER, created: true }));
    (page.$("#save-why") as HTMLTextAreaElement).value = "for later";
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.sent).toEqual([
      {
        url: "/save",
        body: { url: NEWS, title: "A story", why: "for later" },
        redirect: "manual",
        keepalive: undefined,
      },
    ]);
    expect(page.$("#save-heading").textContent).toBe("Saved");
    expect(visible(page.$("#save-form"))).toBe(false);
    expect(visible(page.$("#result"))).toBe(true);
    expect(visible(page.$("#close"))).toBe(true);
    expect(visible(page.$("#saved-link"))).toBe(false);
    expect(page.replaced).toEqual([[null, "", "/save"]]);
  });

  it("sends one Save while one is pending", async () => {
    const page = load(answering({ ...ANSWER, created: true }));
    page.fire("#save-form", "submit");
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.sent).toHaveLength(1);
  });

  it("already saved: the date, the title as a new-tab link inside the link's data-id, and its why; no Bring it back", async () => {
    const page = load(answering(ANSWER));
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.$("#save-heading").textContent).toBe("Already saved on March 3");
    const link = page.$("#saved-link a");
    expect(link.getAttribute("href")).toBe(NEWS);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toBe("A story");
    expect(link.closest("[data-id]")?.getAttribute("data-id")).toBe("7");
    expect(visible(page.$("#saved-link"))).toBe(true);
    expect(page.$("#saved-why").textContent).toBe("Why: for the trip");
    expect(visible(page.$("#bring-back"))).toBe(false);
    expect(visible(page.$("#why-kept"))).toBe(false);
    expect(page.replaced).toEqual([[null, "", "/save"]]);
  });

  it("already saved with no title: the link shows its address", async () => {
    const page = load(answering({ ...ANSWER, title: null, why: null }));
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.$("#saved-link a").textContent).toBe(NEWS);
    expect(visible(page.$("#saved-why"))).toBe(false);
  });

  it("opening the saved link posts /links/opened with its id and keepalive, and lets it open", async () => {
    const page = load(answering(ANSWER));
    page.fire("#save-form", "submit");
    await page.settle();
    const click = page.fire("#saved-link a", "click");
    await page.settle();
    expect(click.defaultPrevented).toBe(false);
    expect(page.sent[1]).toEqual({
      url: "/links/opened",
      body: { id: "7" },
      redirect: "manual",
      keepalive: true,
    });
  });

  it.each([
    ["stale", null, "Stale"],
    ["put away", "2026-10-01T00:00:00.000Z", "Put away"],
  ])("archived and %s: says %s before Bring it back", async (_, putAwayAt, text) => {
    const page = load(answering({ ...ANSWER, state: "archived", putAwayAt }));
    page.fire("#save-form", "submit");
    await page.settle();
    expect(visible(page.$("#saved-state"))).toBe(true);
    expect(page.$("#saved-state").textContent).toBe(text);
    expect(visible(page.$("#bring-back"))).toBe(true);
  });

  it("active: says nothing about being put away", async () => {
    const page = load(answering(ANSWER));
    page.fire("#save-form", "submit");
    await page.settle();
    expect(visible(page.$("#saved-state"))).toBe(false);
  });

  it("archived: Bring it back posts /home/bring-back, then says Back in your list", async () => {
    const page = load(answering({ ...ANSWER, state: "archived" }));
    page.fire("#save-form", "submit");
    await page.settle();
    expect(visible(page.$("#bring-back"))).toBe(true);
    page.fire("#bring-back", "click");
    await page.settle();
    expect(page.sent[1]).toEqual({
      url: "/home/bring-back",
      body: { id: "7" },
      redirect: "manual",
      keepalive: undefined,
    });
    expect(page.$("#save-heading").textContent).toBe("Back in your list");
    expect(visible(page.$("#bring-back"))).toBe(false);
    expect(visible(page.$("#saved-state"))).toBe(false);
    expect(visible(page.$("#close"))).toBe(true);
  });

  it.each([
    [409, "That link was changed since, so it stays as it is. Reload the page."],
    [404, "That link is gone. Reload the page."],
  ])("Bring it back refused with %i shows the route's message", async (status, message) => {
    const refused = { status, body: { code: "x", message } };
    const page = load(answering({ ...ANSWER, state: "archived" }, { "/home/bring-back": refused }));
    page.fire("#save-form", "submit");
    await page.settle();
    page.fire("#bring-back", "click");
    await page.settle();
    expect(page.$("#result-error").textContent).toBe(message);
    expect(page.$("#save-heading").textContent).toBe("Already saved on March 3");
  });

  it("whyKept false: says the owner's why wasn't saved, and shows the stored one", async () => {
    const page = load(answering({ ...ANSWER, whyKept: false, why: "theirs" }));
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.$("#why-kept").textContent).toBe(
      "It already had a reason, so yours wasn't saved: “theirs”",
    );
    expect(visible(page.$("#why-kept"))).toBe(true);
    expect(visible(page.$("#saved-why"))).toBe(false);
  });

  it.each([
    [
      "invalid_url",
      "#url-error",
      "Only http and https links can be saved, not ftp:. Use the page's web address.",
    ],
    ["invalid_input", "#title-error", "A title can be at most 200 characters."],
    ["BAD_REQUEST", "#save-error", "Send a JSON body with url and title and why."],
  ])(
    "a %s refusal shows its message under its field, and keeps the form and the address",
    async (code, where, message) => {
      const page = load(() => ({ status: 400, body: { code, message } }));
      page.fire("#save-form", "submit");
      await page.settle();
      expect(page.$(where).textContent).toBe(message);
      expect(visible(page.$("#save-form"))).toBe(true);
      expect(page.$("#save-heading").textContent).toBe("Save a link");
      expect(page.replaced).toEqual([]);
    },
  );

  it("a redirect to sign-in says the owner was signed out, and keeps the form and the address", async () => {
    const page = load(() => REDIRECT);
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.$("#save-error").textContent).toBe(SIGNED_OUT);
    expect(visible(page.$("#save-form"))).toBe(true);
    expect(page.replaced).toEqual([]);
  });

  it("any other failure shows the general message", async () => {
    const page = load(() => ({ status: 500 }));
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.$("#save-error").textContent).toBe(
      "That did not work. Reload the page and try again.",
    );
    expect(page.replaced).toEqual([]);
  });

  it("a network failure shows the general message and enables Save again", async () => {
    const page = load(() => {
      throw new TypeError("network down");
    });
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.$("#save-error").textContent).toBe(
      "That did not work. Reload the page and try again.",
    );
    expect(page.$("#save-form button[type=submit]").hasAttribute("disabled")).toBe(false);
  });

  it("a 400 whose body is not JSON shows the general message and enables Save again", async () => {
    const page = load(() => ({ status: 400 }));
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.$("#save-error").textContent).toBe(
      "That did not work. Reload the page and try again.",
    );
    expect(page.$("#save-form button[type=submit]").hasAttribute("disabled")).toBe(false);
  });

  it("after a failed Save, a second Save sends a second POST", async () => {
    const page = load(() => ({ status: 500 }));
    page.fire("#save-form", "submit");
    await page.settle();
    page.fire("#save-form", "submit");
    await page.settle();
    expect(page.sent).toHaveLength(2);
  });

  it("Bring it back sends one POST for two clicks while the first is pending", async () => {
    const page = load(answering({ ...ANSWER, state: "archived" }));
    page.fire("#save-form", "submit");
    await page.settle();
    page.fire("#bring-back", "click");
    page.fire("#bring-back", "click");
    await page.settle();
    expect(page.sent.filter((s) => s.url === "/home/bring-back")).toHaveLength(1);
  });

  it("shows an answer's title and why as typed text, never as markup", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const kept = load(answering({ ...ANSWER, title: hostile, why: hostile }));
    kept.fire("#save-form", "submit");
    await kept.settle();
    expect(kept.$("#result").querySelectorAll("img")).toHaveLength(0);
    expect(kept.$("#saved-link a").textContent).toBe(hostile);
    expect(kept.$("#saved-why").textContent).toBe(`Why: ${hostile}`);
    const notKept = load(answering({ ...ANSWER, title: hostile, why: hostile, whyKept: false }));
    notKept.fire("#save-form", "submit");
    await notKept.settle();
    expect(notKept.$("#result").querySelectorAll("img")).toHaveLength(0);
    expect(notKept.$("#why-kept").textContent).toBe(
      `It already had a reason, so yours wasn't saved: “${hostile}”`,
    );
  });

  it("Close closes the tab when the browser allows it", async () => {
    const page = load(answering({ ...ANSWER, created: true }), { closes: true });
    page.fire("#save-form", "submit");
    await page.settle();
    page.fire("#close", "click");
    expect(page.tab.closed).toBe(true);
    expect(visible(page.$("#close-note"))).toBe(false);
  });

  it("when the tab stays open, Close is replaced by You can close this tab.", async () => {
    const page = load(answering({ ...ANSWER, created: true }));
    page.fire("#save-form", "submit");
    await page.settle();
    page.fire("#close", "click");
    expect(visible(page.$("#close"))).toBe(false);
    expect(visible(page.$("#close-note"))).toBe(true);
    expect(page.$("#close-note").textContent).toBe("You can close this tab.");
  });

  it("editing the address updates the host line, and hides it for an address that does not parse", () => {
    const page = load(() => ({ status: 204 }));
    const field = page.$("#save-url") as HTMLInputElement;
    field.value = "https://other.example/x";
    page.fire("#save-url", "input");
    expect(page.$("#save-host").textContent).toBe("Saving a page from other.example");
    expect(visible(page.$("#save-host"))).toBe(true);
    field.value = "nonsense";
    page.fire("#save-url", "input");
    expect(visible(page.$("#save-host"))).toBe(false);
  });
});
