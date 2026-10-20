import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { MAX_PAGE_IDS, MAX_TEXT_CHARS } from "../ai/chat-turn.js";
import { renderCard } from "./ai-card.js";
import { ASK_KEY } from "./ask-panel.js";
import { isToolJson, isToolJsonOrNull } from "./http.js";
import { PAGE_STYLE, page } from "./page.js";
import { askCss, themeCss } from "./theme.js";

const ASK = { ai: "Fake", place: "Home", owner: "owner-a" };
const HOSTILE = "<b>x</b>";

const withAsk = (ask = ASK, body = "<main>body</main>") =>
  page("t", body, { menu: true, undo: true, ask });

describe("the Ask AI panel's markup", () => {
  const { document } = parseHTML(withAsk({ ai: HOSTILE, place: HOSTILE, owner: HOSTILE }));
  const html = withAsk({ ai: HOSTILE, place: HOSTILE, owner: HOSTILE });
  const panel = document.getElementById("ask-panel");

  it("puts Ask AI between the page links and the account menu, as a toggle for the panel", () => {
    const items = [...document.querySelectorAll(".menu > *")].map((e) => e.textContent?.trim());
    expect(items.slice(0, 3)).toEqual(["All links", "Spaces and tags", "Ask AI"]);
    expect(items).toHaveLength(4);
    const button = document.getElementById("ask-open");
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(button?.getAttribute("aria-controls")).toBe("ask-panel");
    expect(button?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is a hidden labelled aside holding the header, messages and form", () => {
    expect(panel?.tagName).toBe("ASIDE");
    expect(panel?.getAttribute("aria-label")).toBe("Ask AI");
    expect(panel?.hasAttribute("hidden")).toBe(true);
    expect(panel?.querySelector("h2")?.textContent).toBe("Ask AI");
    expect(document.getElementById("ask-close")?.getAttribute("aria-label")).toBe("Close");
    expect(document.getElementById("ask-restart")?.textContent).toBe("Start over");
    expect(document.getElementById("ask-messages")).not.toBeNull();
    expect(document.querySelector('label[for="ask-text"]')?.textContent).toBe("Message your AI");
    const text = document.getElementById("ask-text");
    expect(text?.tagName).toBe("TEXTAREA");
    expect(text?.getAttribute("placeholder")).toBe("Ask, or paste a link to save");
    expect(panel?.querySelector('button[type="submit"]')?.textContent).toBe("Send");
  });

  it("escapes the AI, the place and the owner, and carries the owner as data-owner", () => {
    expect(html).not.toContain(HOSTILE);
    expect(panel?.getAttribute("data-owner")).toBe(HOSTILE);
    expect(panel?.querySelector(".ask-title p")?.textContent).toBe(
      `Using ${HOSTILE}, on ${HOSTILE}`,
    );
    expect(document.getElementById("ask-back")?.textContent).toBe(`‹ ${HOSTILE}`);
  });

  it("adds a second style with askCss and leaves the page's own style alone", () => {
    const styles = [...parseHTML(withAsk()).document.querySelectorAll("style")];
    expect(styles).toHaveLength(2);
    expect(styles[0]?.textContent).toBe(PAGE_STYLE);
    expect(styles[1]?.textContent).toBe(`\n${askCss}\n`);
    expect(PAGE_STYLE).toBe(`\n${themeCss}\n`);
    expect(themeCss).not.toContain("ask-panel");
  });

  it("limits the message box to the server's longest message", () => {
    expect(document.getElementById("ask-text")?.getAttribute("maxlength")).toBe(
      String(MAX_TEXT_CHARS),
    );
  });

  it("uses only theme tokens for colour", () => {
    expect(askCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });

  it("styles the Earlier line as a 44px control, keeps its box hidden, and dims by opacity only", () => {
    expect(askCss).toMatch(/\.ask-earlier\{[^}]*min-height:44px/);
    expect(askCss).toContain(".ask-earlier-entries[hidden]{display:none}");
    expect(askCss).toMatch(/\.ask-dim\{opacity:\.4\}/);
    expect(themeCss).not.toContain("ask-dim");
  });

  it("makes no outside requests", () => {
    expect(html).not.toMatch(/(?:src|href)="https?:/);
  });
});

/** The panel in linkedom, its script run against a fake `sessionStorage` and a recorded focus. */
function load({
  stored,
  storage,
  phone = false,
  body,
  url = "/",
  fetch = (async () => {
    throw new Error("no fetch expected");
  }) as unknown as typeof globalThis.fetch,
}: {
  stored?: unknown;
  storage?: Partial<Storage>;
  phone?: boolean;
  /** The page's own markup, around the panel. */
  body?: string;
  /** The page's address: path and query. */
  url?: string;
  fetch?: typeof globalThis.fetch;
} = {}) {
  const html = withAsk(ASK, body);
  const { document, window } = parseHTML(html);
  const items = new Map<string, string>();
  if (stored !== undefined) {
    items.set(ASK_KEY, typeof stored === "string" ? stored : JSON.stringify(stored));
  }
  const sessionStorage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    ...storage,
  };
  let focused: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => focused });
  for (const el of document.querySelectorAll("button, textarea")) {
    (el as HTMLElement).focus = () => {
      focused = el;
    };
  }
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.includes(ASK_KEY) || s.includes("recordOpen"))
    .join("\n");
  const matchMedia = () => ({ matches: phone, addEventListener: () => {} });
  // linkedom's MutationObserver never fires, so tests fire the callbacks themselves.
  type Watch = { callback: () => void; connected: boolean; target?: unknown; options?: unknown };
  const observers: Watch[] = [];
  class FakeObserver {
    entry: Watch;
    constructor(callback: () => void) {
      this.entry = { callback, connected: false };
      observers.push(this.entry);
    }
    observe(target: unknown, options: unknown) {
      this.entry.connected = true;
      this.entry.target = target;
      this.entry.options = options;
    }
    disconnect() {
      this.entry.connected = false;
    }
  }
  const [pathname = "/", search = ""] = url.split(/(?=\?)/);
  new Function(
    "document",
    "window",
    "sessionStorage",
    "matchMedia",
    "fetch",
    "location",
    "MutationObserver",
    "CustomEvent",
    code,
  )(
    document,
    window,
    sessionStorage,
    matchMedia,
    fetch,
    { pathname, search },
    FakeObserver,
    window.CustomEvent,
  );
  const el = (id: string) => document.getElementById(id) as HTMLElement;
  const click = (id: string) => el(id).dispatchEvent(new window.Event("click", { bubbles: true }));
  const pressEscape = () =>
    el("ask-text").dispatchEvent(
      Object.assign(new window.Event("keydown", { bubbles: true }), { key: "Escape" }),
    );
  const stateNow = () => (items.has(ASK_KEY) ? JSON.parse(items.get(ASK_KEY) as string) : null);
  return {
    document,
    window,
    el,
    click,
    pressEscape,
    stateNow,
    items,
    /** Runs the callbacks of the observers that are watching the page. */
    mutate: () => {
      for (const o of observers) if (o.connected) o.callback();
    },
    watching: () => observers.filter((o) => o.connected).length,
    /** What each connected observer was told to watch. */
    watched: () =>
      observers.filter((o) => o.connected).map((o) => ({ target: o.target, options: o.options })),
    /** What the script exposes for the sending code. */
    panel: () =>
      (
        window as unknown as {
          askPanel: {
            state: Record<string, unknown> & { entries: unknown[]; history: unknown[] };
            messages: HTMLElement;
            save: () => void;
            trimHistory: (history: unknown[], text: string) => { role: string; text: string }[];
          };
        }
      ).askPanel,
    focused: () => focused,
    pressed: () => el("ask-open").getAttribute("aria-pressed"),
  };
}

const saved = (over: Record<string, unknown> = {}) => ({
  v: 1,
  owner: ASK.owner,
  open: false,
  entries: [{ kind: "me", text: "hello" }],
  history: [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi there" },
  ],
  pending: null,
  ...over,
});

describe("opening and closing the panel", () => {
  it("opens with the button: shows the panel, presses the button, focuses the message box", () => {
    const p = load();
    expect(p.el("ask-panel").hasAttribute("hidden")).toBe(true);
    p.click("ask-open");
    expect(p.el("ask-panel").hasAttribute("hidden")).toBe(false);
    expect(p.pressed()).toBe("true");
    expect(p.document.body.classList.contains("ask-open")).toBe(true);
    expect(p.focused()).toBe(p.el("ask-text"));
    expect(p.stateNow().open).toBe(true);
  });

  it.each([["ask-close"], ["ask-back"], ["ask-open"]])(
    "closes with %s and puts focus back on Ask AI",
    (id) => {
      const p = load();
      p.click("ask-open");
      p.click(id);
      expect(p.el("ask-panel").hasAttribute("hidden")).toBe(true);
      expect(p.pressed()).toBe("false");
      expect(p.document.body.classList.contains("ask-open")).toBe(false);
      expect(p.focused()).toBe(p.el("ask-open"));
      expect(p.stateNow().open).toBe(false);
    },
  );

  it("closes on Escape from inside the panel", () => {
    const p = load();
    p.click("ask-open");
    p.pressEscape();
    expect(p.el("ask-panel").hasAttribute("hidden")).toBe(true);
    expect(p.focused()).toBe(p.el("ask-open"));
  });

  it("restores an open panel on the next page, without taking focus", () => {
    const p = load({ stored: saved({ open: true }) });
    expect(p.el("ask-panel").hasAttribute("hidden")).toBe(false);
    expect(p.pressed()).toBe("true");
    expect(p.focused()).toBeNull();
  });

  it("makes the rest of the page inert while the phone sheet is open, and only then", () => {
    const wide = load();
    wide.click("ask-open");
    expect(wide.document.querySelector("header")?.hasAttribute("inert")).toBe(false);

    const phone = load({ phone: true });
    phone.click("ask-open");
    expect(phone.document.querySelector("header")?.hasAttribute("inert")).toBe(true);
    expect(phone.document.querySelector("main")?.parentElement?.hasAttribute("inert")).toBe(true);
    expect(phone.el("ask-panel").hasAttribute("inert")).toBe(false);
    phone.click("ask-back");
    expect(phone.document.querySelector("header")?.hasAttribute("inert")).toBe(false);
  });

  it("still opens when sessionStorage throws", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    const p = load({ storage: { getItem: boom, setItem: boom, removeItem: boom } });
    p.click("ask-open");
    expect(p.el("ask-panel").hasAttribute("hidden")).toBe(false);
    p.click("ask-close");
    expect(p.el("ask-panel").hasAttribute("hidden")).toBe(true);
  });
});

describe("the panel's saved state", () => {
  it("keeps this owner's version-1 state", () => {
    const p = load({ stored: saved() });
    expect(p.panel().state.entries).toEqual([{ kind: "me", text: "hello" }]);
    expect(p.panel().state.history).toHaveLength(2);
  });

  it.each([
    ["another owner's", saved({ owner: "owner-b" })],
    ["a version 2", saved({ v: 2 })],
    ["unparseable", "{not json"],
    ["a non-object", "7"],
    ["one with no entries list", { v: 1, owner: ASK.owner, open: true }],
  ])("discards %s state and removes the key", (_name, stored) => {
    const p = load({ stored });
    expect(p.items.has(ASK_KEY)).toBe(false);
    expect(p.panel().state).toEqual({
      v: 1,
      owner: ASK.owner,
      open: false,
      entries: [],
      history: [],
      pending: null,
    });
    expect(p.el("ask-panel").hasAttribute("hidden")).toBe(true);
  });

  it("Start over empties entries, history, pending and the messages, and keeps the panel open", () => {
    const p = load({ stored: saved({ open: true, pending: { text: "hello" } }) });
    p.panel().messages.appendChild(p.document.createElement("p"));
    p.click("ask-restart");
    expect(p.panel().messages.children).toHaveLength(0);
    expect(p.stateNow()).toEqual({
      v: 1,
      owner: ASK.owner,
      open: true,
      entries: [],
      history: [],
      pending: null,
    });
  });

  it("Sign out removes the key, and nothing writes it back afterwards", () => {
    const p = load({ stored: saved({ open: true }) });
    p.click("sign-out");
    expect(p.items.has(ASK_KEY)).toBe(false);
    p.panel().save();
    expect(p.items.has(ASK_KEY)).toBe(false);
  });
});

describe("sending", () => {
  it("stops the page from reloading when the form is submitted empty", () => {
    const p = load();
    let prevented = false;
    const event = Object.assign(new p.window.Event("submit", { bubbles: true, cancelable: true }), {
      preventDefault: () => {
        prevented = true;
      },
    });
    p.el("ask-form").dispatchEvent(event);
    expect(prevented).toBe(true);
  });
});

type Body = { id?: string; editId?: string; text?: string; tool?: unknown; previous?: unknown };
type Call = { url: string; method: string; body: Body | undefined };
type Reply = { status?: number; body?: unknown };

/** A fake `fetch` that records each call and answers from `handler`; a missing body fails `json()`. */
const fakeFetch = (handler: (call: Call) => Reply | Promise<Reply>) => {
  const calls: Call[] = [];
  const fn = async (url: string, init: { method?: string; body?: string } = {}) => {
    const call = {
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = await handler(call);
    return {
      status: reply.status ?? 200,
      json: async () => {
        if (reply.body === undefined) throw new Error("no body");
        return reply.body;
      },
    };
  };
  return { fn: fn as unknown as typeof fetch, calls };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const CARD = (id: string, title = "T") =>
  `<article class="ask-card" data-id="${id}"><h3><a href="https://x.example/${id}" target="_blank" rel="noopener noreferrer" data-open>${title}</a></h3></article>`;
const ROW = {
  status: "kept",
  source: "asked",
  since: "2026-10-01T00:00:00.000Z",
  answeredAt: null,
  waitDays: 30,
};
const link = (linkId: string, over: Record<string, unknown> = {}) => ({
  kind: "link",
  tool: "save_link",
  linkId,
  created: false,
  fields: [],
  editId: null,
  ...over,
});
const okAnswer = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    ok: true,
    ai: "Fake",
    segments: [{ text: "Done." }],
    remember: "Done.",
    cards: {},
    changes: [],
    ...over,
  },
});

/** Loads the panel with `handler` answering every request, and lets the test send and click. */
function talk(
  handler: (call: Call) => Reply | Promise<Reply>,
  options: { stored?: unknown; body?: string; url?: string } = {},
) {
  const net = fakeFetch(handler);
  const p = load({ ...options, fetch: net.fn });
  const say = async (text: string) => {
    (p.el("ask-text") as HTMLTextAreaElement).value = text;
    p.el("ask-form").dispatchEvent(
      new p.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
  };
  const clickEl = async (node: Element | null | undefined) => {
    node?.dispatchEvent(new p.window.Event("click", { bubbles: true }));
    await flush();
  };
  const messages = () => p.panel().messages;
  const lines = () => [...messages().querySelectorAll(".ask-line")].map((n) => n.textContent);
  return { ...p, net, say, clickEl, messages, lines };
}

describe("trimming the history to send", () => {
  const pairs = (n: number, text = "x") =>
    Array.from({ length: n * 2 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text }));
  const trim = (history: unknown[], text = "next") => load().panel().trimHistory(history, text);

  it("keeps the last 40 messages, dropping whole pairs from the front", () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `m${i}`,
    }));
    const kept = trim(history);
    expect(kept).toHaveLength(40);
    expect(kept[0]).toEqual({ role: "user", text: "m10" });
    expect(kept[39]).toEqual({ role: "assistant", text: "m49" });
  });

  it("drops the oldest pairs while the body is over 400 KiB", () => {
    const history = pairs(20).map((m, i) => ({ ...m, text: `${i}:${"y".repeat(20_000)}` }));
    const cut = (h: typeof history) =>
      h.map((m) => ({ ...m, text: m.role === "assistant" ? m.text.slice(0, 8_000) : m.text }));
    const body = (h: unknown[]) =>
      new TextEncoder().encode(JSON.stringify({ history: h, text: "next" })).length;
    expect(body(cut(history))).toBeGreaterThan(400 * 1024);
    const kept = trim(history);
    expect(body(kept)).toBeLessThanOrEqual(400 * 1024);
    expect(kept.length).toBeLessThan(40);
    expect(kept.length % 2).toBe(0);
    expect(kept[0]?.role).toBe("user");
    expect(kept.at(-1)?.text.startsWith("39:")).toBe(true);
    expect(body(cut(history.slice(-(kept.length + 2))))).toBeGreaterThan(400 * 1024);
  });

  it("posts only valid pairs: a malformed message or an empty reply drops its whole pair", () => {
    const good = [
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
    ];
    const kept = trim([
      ...good,
      { role: "user", text: "c" },
      null,
      { role: "user", text: "d" },
      { role: "assistant", text: "  " },
      ...good,
      { role: "assistant", text: "orphan" },
    ]);
    expect(kept).toEqual([...good, ...good]);
  });

  it("cuts a long assistant text to 8,000 characters and leaves the owner's text alone", () => {
    const kept = trim([
      { role: "user", text: "u".repeat(9_000) },
      { role: "assistant", text: "a".repeat(9_000) },
    ]);
    expect(kept[0]?.text).toHaveLength(9_000);
    expect(kept[1]?.text).toHaveLength(8_000);
  });
});

describe("sending a message", () => {
  it("posts the history and the trimmed text, and shows the message and Thinking while it waits", async () => {
    let release: (r: Reply) => void = () => {};
    const waiting = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const t = talk(() => waiting, { stored: saved() });
    await t.say("  find my batteries  ");
    expect(t.net.calls).toEqual([
      {
        url: "/ai/chat",
        method: "POST",
        body: {
          history: [
            { role: "user", text: "hello" },
            { role: "assistant", text: "hi there" },
          ],
          text: "find my batteries",
          page: { path: "/", place: "Home", ids: [], shown: 0 },
        },
      },
    ]);
    expect(t.messages().querySelector(".ask-me:last-of-type, .ask-me")?.textContent).toBeTruthy();
    expect(t.messages().textContent).toContain("find my batteries");
    expect(t.messages().textContent).toContain("Thinking…");
    expect(t.stateNow().pending).toEqual({ text: "find my batteries", path: "/", place: "Home" });
    release(okAnswer());
    await flush();
    expect(t.messages().textContent).not.toContain("Thinking…");
    expect(t.stateNow().pending).toBeNull();
  });

  it("disables Send while a turn runs, ignores a second submit, and enables Send after", async () => {
    let release: (r: Reply) => void = () => {};
    const waiting = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const t = talk(() => waiting);
    const send = t.document.querySelector('#ask-form button[type="submit"]') as HTMLButtonElement;
    await t.say("one");
    expect(send.disabled).toBe(true);
    await t.say("two");
    expect(t.net.calls).toHaveLength(1);
    release(okAnswer());
    await flush();
    expect(send.disabled).toBe(false);
  });

  it("ignores an empty message", async () => {
    const t = talk(() => okAnswer());
    await t.say("   ");
    expect(t.net.calls).toHaveLength(0);
    expect(t.stateNow()?.entries ?? []).toHaveLength(0);
  });
});

describe("an answer", () => {
  const reply = () =>
    okAnswer({
      segments: [{ text: "See <b>this</b>\nand that" }, { card: CARD("7") }, { text: "Bye" }],
      remember: "See [link 7: T] Bye",
    });

  it("draws text segments as text, card segments as cards, and keeps the pair with remember", async () => {
    const t = talk(() => reply());
    await t.say("show me");
    const paragraphs = [...t.messages().querySelectorAll(".ask-reply p")];
    expect(paragraphs.map((n) => n.textContent)).toEqual(["See <b>this</b>\nand that", "Bye"]);
    expect(t.messages().querySelector(".ask-reply b")).toBeNull();
    expect(t.messages().querySelector(".ask-reply .ask-card[data-id='7']")).not.toBeNull();
    expect(t.panel().state.history).toEqual([
      { role: "user", text: "show me" },
      { role: "assistant", text: "See [link 7: T] Bye" },
    ]);
    expect(t.stateNow().history).toEqual(t.panel().state.history);
  });

  it("draws it again after a reload", async () => {
    const t = talk(() => reply());
    await t.say("show me");
    const again = load({ stored: t.stateNow() });
    expect(again.panel().messages.querySelector(".ask-card[data-id='7']")).not.toBeNull();
    expect(again.panel().messages.querySelector(".ask-me")?.textContent).toBe("show me");
  });
});

describe("the change lines", () => {
  const lineFor = async (change: unknown, extra: Record<string, unknown> = {}) => {
    const t = talk(() => okAnswer({ changes: [change], ...extra }));
    await t.say("go");
    return t;
  };

  it("says Saved. for a created link, with an Undo that deletes it", async () => {
    const t = await lineFor(link("5", { created: true }));
    expect(t.lines()).toEqual(["Saved.Undo"]);
    await t.clickEl(t.messages().querySelector("button.ask-undo"));
    expect(t.net.calls.at(-1)).toEqual({ url: "/links/delete", method: "POST", body: { id: "5" } });
  });

  it("shows one line for a link saved and edited in the same turn, with the delete Undo", async () => {
    const t = talk(() =>
      okAnswer({
        changes: [link("5", { editId: "e2" }), link("5", { created: true, editId: "e1" })],
      }),
    );
    await t.say("go");
    expect(t.lines()).toEqual(["Saved.Undo"]);
    await t.clickEl(t.messages().querySelector("button.ask-undo"));
    expect(t.net.calls.at(-1)?.url).toBe("/links/delete");
  });

  it("shows one line for a link edited twice, the one with an editId carrying the Undo", async () => {
    const t = talk(() =>
      okAnswer({ changes: [link("5"), link("5", { editId: "e1" }), link("5")] }),
    );
    await t.say("go");
    expect(t.lines()).toEqual(["Updated.Undo"]);
    const undo = t.messages().querySelector("button.ask-undo");
    expect(undo?.getAttribute("title")).toBe("Puts back the title, summary, why and tags.");
  });

  it("says Updated. with no Undo for an edit that has no editId", async () => {
    const t = await lineFor(link("5"));
    expect(t.lines()).toEqual(["Updated."]);
    expect(t.messages().querySelector("button")).toBeNull();
  });

  it.each([
    ["kept", "asked", "Kept handy."],
    ["suggested", "inferred", "Suggested for your Handy shelf (a guess)."],
    ["declined", "asked", "Taken off your Handy shelf."],
  ])("says %s for a handy change, with an Undo", async (status, source, words) => {
    const t = await lineFor({
      kind: "handy",
      linkId: "5",
      change: { tool: { ...ROW, status, source }, previous: null },
    });
    expect(t.lines()).toEqual([`${words}Undo`]);
  });

  it("names a tag's kind and links to Tags, with no Undo", async () => {
    const t = await lineFor({ kind: "tag", name: "garden", tagKind: "project" });
    expect(t.lines()).toEqual(["Made garden a project.Tags"]);
    expect(t.messages().querySelector(".ask-line a")?.getAttribute("href")).toBe("/tags");
    expect(t.messages().querySelector("button")).toBeNull();
  });

  const entry = (kind: string, text: string, source: string) => ({
    entry: kind,
    id: "1",
    text,
    source,
  });

  it("gives one line per profile entry, marking inferred ones and saying what you're working on for a focus", async () => {
    const t = await lineFor({
      kind: "profile",
      added: [entry("note", "likes tea", "inferred"), entry("focus", "the garden", "inferred")],
      edited: [entry("note", "likes coffee", "stated")],
      removed: [entry("focus", "old plan", "asked")],
    });
    expect(t.lines()).toEqual([
      "Added the note 'likes tea' (a guess)Profile",
      "Added what you're working on: 'the garden' (a guess)Profile",
      "Changed the note 'likes coffee'Profile",
      "Removed what you're working on: 'old plan'Profile",
    ]);
    expect(t.messages().querySelector(".ask-line a")?.getAttribute("href")).toBe("/profile");
    expect(t.messages().querySelector("button")).toBeNull();
  });

  it("counts the links marked as shown in today's picks", async () => {
    expect((await lineFor({ kind: "surfaced", linkIds: ["1", "2", "3"] })).lines()).toEqual([
      "Marked 3 links as shown in today's picks.",
    ]);
    expect((await lineFor({ kind: "surfaced", linkIds: ["1"] })).lines()).toEqual([
      "Marked 1 link as shown in today's picks.",
    ]);
  });

  it("draws a changed link's card above its line, once", async () => {
    const t = await lineFor(link("5", { created: true }), { cards: { "5": CARD("5") } });
    const block = t.messages().querySelector(".ask-change");
    expect(block?.firstElementChild?.getAttribute("data-id")).toBe("5");
    expect(t.messages().querySelectorAll(".ask-card")).toHaveLength(1);
  });
});

describe("Edit under a change line (#183)", () => {
  /** A card as the server renders it, carrying the edit dialog's data. */
  const editable = (id: string, title = `Link ${id}`) =>
    renderCard(
      {
        id,
        url: `https://x.example/${id}`,
        urlKey: `x.example/${id}`,
        title,
        summary: null,
        why: null,
        tags: [],
        savedAt: new Date("2026-10-20T00:00:00Z"),
        savedBy: "t",
        lastOpenedAt: null,
        lastSurfacedAt: null,
        snoozedUntil: null,
        state: "active",
        snapshot: null,
      },
      { version: "v1", fit: "cover" },
      { own: false, pageVersion: null, pageFit: null },
      [],
    );
  const rowButtons = (row: Element | null | undefined) =>
    [...(row?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
  const rows = (t: ReturnType<typeof talk>) => [...t.messages().querySelectorAll(".ask-line")];
  const edits = (t: ReturnType<typeof talk>) => [...t.messages().querySelectorAll(".ask-edit")];
  const answered = async (over: Record<string, unknown>) => {
    const t = talk((call) => (call.url === "/ai/chat" ? okAnswer(over) : { status: 204 }));
    await t.say("go");
    return t;
  };

  it("gives a save line with its card Edit then Undo, Edit a plain button", async () => {
    const t = await answered({
      changes: [link("5", { created: true })],
      cards: { "5": editable("5") },
    });
    expect(rowButtons(rows(t)[0])).toEqual(["Edit", "Undo"]);
    const [edit] = edits(t);
    expect(edit?.tagName).toBe("BUTTON");
    expect(edit?.getAttribute("type")).toBe("button");
    expect(edit?.getAttribute("data-id")).toBe("5");
  });

  it("gives Updated. Edit, with an editId and without one", async () => {
    const t = await answered({
      changes: [link("5", { editId: "e1" }), link("6")],
      cards: { "5": editable("5"), "6": editable("6") },
    });
    expect(rows(t).map(rowButtons)).toEqual([["Edit", "Undo"], ["Edit"]]);
  });

  it("gives handy, tag, profile and surfaced lines no Edit", async () => {
    const t = await answered({
      changes: [
        { kind: "handy", linkId: "9", change: { tool: ROW, previous: null } },
        { kind: "tag", name: "garden", tagKind: "project" },
        {
          kind: "profile",
          added: [{ entry: "note", id: "1", text: "x", source: "stated" }],
          edited: [],
          removed: [],
        },
        { kind: "surfaced", linkIds: ["9"] },
      ],
      cards: { "9": editable("9") },
    });
    expect(rows(t).map(rowButtons)).toEqual([["Undo"], [], [], []]);
  });

  it("gives a reply's cards no buttons", async () => {
    const t = await answered({ segments: [{ card: editable("7") }] });
    expect(t.messages().querySelectorAll(".ask-reply button")).toHaveLength(0);
  });

  it("gives a changed link the reply cites Edit on its line, its card being only in the reply", async () => {
    const t = await answered({
      segments: [{ card: editable("5") }],
      changes: [link("5", { created: true })],
      cards: {},
    });
    expect(t.messages().querySelectorAll(".ask-change .ask-card")).toHaveLength(0);
    expect(rowButtons(rows(t)[0])).toEqual(["Edit", "Undo"]);
  });

  it("gives a line whose link has no card no Edit", async () => {
    const t = await answered({ changes: [link("5", { created: true })], cards: {} });
    expect(rowButtons(rows(t)[0])).toEqual(["Undo"]);
  });

  it("removes Edit from every line for a link once its save is undone, and draws none after a reload", async () => {
    const t = talk((call) => {
      if (call.url !== "/ai/chat") return { status: 204 };
      return t.net.calls.length === 1
        ? okAnswer({ changes: [link("5", { created: true })], cards: { "5": editable("5") } })
        : okAnswer({ changes: [link("5", { editId: "e1" })], cards: { "5": editable("5") } });
    });
    await t.say("save it");
    await t.say("rename it");
    expect(rows(t).map(rowButtons)).toEqual([
      ["Edit", "Undo"],
      ["Edit", "Undo"],
    ]);
    await t.clickEl(t.messages().querySelector("button.ask-undo"));
    expect(t.net.calls.at(-1)?.url).toBe("/links/delete");
    expect(edits(t)).toHaveLength(0);
    const again = load({ stored: t.stateNow() });
    expect(again.panel().messages.querySelectorAll(".ask-edit")).toHaveLength(0);
  });

  it("keeps Edit after an edit's Undo, since the link is still there", async () => {
    const t = await answered({
      changes: [link("5", { editId: "e1" })],
      cards: { "5": editable("5") },
    });
    await t.clickEl(t.messages().querySelector("button.ask-undo"));
    expect(rows(t)[0]?.textContent).toBe("Updated.EditUndone.");
  });

  it("draws Edit again from the stored state", async () => {
    const t = await answered({
      changes: [link("5", { created: true })],
      cards: { "5": editable("5") },
    });
    const again = load({ stored: t.stateNow() });
    const [row] = again.panel().messages.querySelectorAll(".ask-line");
    expect(rowButtons(row)).toEqual(["Edit", "Undo"]);
  });
});

describe("Undo", () => {
  const save = link("5", { created: true });
  const edit = link("7", { editId: "e1" });
  const handy = {
    kind: "handy",
    linkId: "9",
    change: { tool: ROW, previous: { ...ROW, status: "suggested", source: "inferred" } },
  };
  const server =
    (over: Partial<Record<string, Reply>> = {}) =>
    (call: Call) => {
      if (call.url === "/ai/chat") {
        return okAnswer({
          segments: [{ card: CARD("7", "Old") }],
          changes: [save, edit, handy],
          cards: { "5": CARD("5"), "9": CARD("9", "Handy old") },
        });
      }
      return over[call.url] ?? { status: 204 };
    };
  const buttons = (t: ReturnType<typeof talk>) => [
    ...t.messages().querySelectorAll("button.ask-undo"),
  ];

  it("posts the body each kind needs, and the handy body passes the server's check", async () => {
    const t = talk(server());
    await t.say("go");
    for (const b of buttons(t)) await t.clickEl(b);
    const posted = t.net.calls.filter((c) => c.url !== "/ai/chat" && c.method === "POST");
    expect(posted.map((c) => c.url)).toEqual(["/links/delete", "/links/edit/undo", "/tools/undo"]);
    expect(posted[0]?.body).toEqual({ id: "5" });
    expect(posted[1]?.body).toEqual({ id: "7", editId: "e1" });
    expect(posted[2]?.body).toEqual({
      id: "9",
      tool: handy.change.tool,
      previous: handy.change.previous,
    });
    expect(isToolJson(posted[2]?.body?.tool)).toBe(true);
    expect(isToolJsonOrNull(posted[2]?.body?.previous)).toBe(true);
  });

  it("disables the button while it runs, then shows Undone. in its place", async () => {
    let release: (r: Reply) => void = () => {};
    const waiting = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const t = talk((call) => (call.url === "/links/delete" ? waiting : server()(call)));
    await t.say("go");
    const [first] = buttons(t);
    await t.clickEl(first);
    expect((first as HTMLButtonElement).disabled).toBe(true);
    release({ status: 204 });
    await flush();
    expect(t.lines()[0]).toBe("Saved.Undone.");
  });

  it("re-reads the card after an edit Undo, in the panel and in the stored state, and keeps both after a reload", async () => {
    const t = talk(server({ "/ai/card/7": { body: { card: CARD("7", "Restored") } } }));
    await t.say("go");
    await t.clickEl(buttons(t)[1]);
    expect(t.net.calls.at(-1)).toEqual({ url: "/ai/card/7", method: "GET", body: undefined });
    expect(t.messages().querySelector(".ask-reply .ask-card")?.textContent).toBe("Restored");
    const stored = t.stateNow();
    expect(stored.entries[1].segments).toEqual([{ card: CARD("7", "Restored") }]);
    const again = load({ stored });
    expect(again.panel().messages.querySelector(".ask-reply .ask-card")?.textContent).toBe(
      "Restored",
    );
    expect(
      [...again.panel().messages.querySelectorAll(".ask-line")].map((n) => n.textContent),
    ).toEqual(["Saved.Undo", "Updated.Undone.", "Kept handy.Undo"]);
  });

  it("replaces the card kept in the cards map after a handy Undo", async () => {
    const t = talk(server({ "/ai/card/9": { body: { card: CARD("9", "Handy new") } } }));
    await t.say("go");
    await t.clickEl(buttons(t)[2]);
    expect(t.messages().querySelector(".ask-change .ask-card[data-id='9']")?.textContent).toBe(
      "Handy new",
    );
    expect(t.stateNow().entries[2].cards["9"]).toBe(CARD("9", "Handy new"));
  });

  it("leaves the card alone when it can't be read again", async () => {
    const t = talk(server({ "/ai/card/7": { status: 404, body: { code: "not_found" } } }));
    await t.say("go");
    await t.clickEl(buttons(t)[1]);
    expect(t.messages().querySelector(".ask-reply .ask-card")?.textContent).toBe("Old");
    expect(t.lines()[1]).toBe("Updated.Undone.");
  });

  it("fades the card after a save Undo, and still fades it after a reload", async () => {
    const t = talk(server());
    await t.say("go");
    await t.clickEl(buttons(t)[0]);
    const card = () => t.messages().querySelector(".ask-change .ask-card[data-id='5']");
    expect(card()?.classList.contains("ask-faded")).toBe(true);
    expect(t.net.calls.some((c) => c.url === "/ai/card/5")).toBe(false);
    const again = load({ stored: t.stateNow() });
    expect(
      again
        .panel()
        .messages.querySelector(".ask-card[data-id='5']")
        ?.classList.contains("ask-faded"),
    ).toBe(true);
  });

  it("shows the server's message on a 409 and lets the owner try again", async () => {
    const t = talk(
      server({ "/links/delete": { status: 409, body: { message: "Changed since." } } }),
    );
    await t.say("go");
    const [first] = buttons(t);
    await t.clickEl(first);
    expect(t.lines()[0]).toBe("Saved.UndoChanged since.");
    expect((first as HTMLButtonElement).disabled).toBe(false);
    expect(t.stateNow().entries[2].lines[0].undo.done).toBeUndefined();
  });

  it("says it didn't work on any other failure", async () => {
    const t = talk(
      server({ "/links/delete": { status: 500, body: { message: "secret detail" } } }),
    );
    await t.say("go");
    await t.clickEl(buttons(t)[0]);
    expect(t.lines()[0]).toBe("Saved.UndoThat didn't work. Try again.");
  });
});

describe("a turn that failed", () => {
  const failed = (over: Record<string, unknown> = {}) => ({
    status: 200,
    body: {
      ok: false,
      ai: "Fake",
      message: "Fake didn't answer: the connection timed out.",
      remember: "r",
      cards: {},
      changes: [],
      ...over,
    },
  });

  it("with no changes: says nothing was saved, offers Try again and Search, and keeps no history", async () => {
    const t = talk(() => failed());
    await t.say("miso butter");
    const alert = t.messages().querySelector('[role="alert"]');
    expect(alert?.querySelector("strong")?.textContent).toBe(
      "Fake didn't answer: the connection timed out.",
    );
    expect(alert?.textContent).toContain(
      "Nothing was saved or changed. Try again, or search your links the usual way.",
    );
    const labels = [...(alert?.querySelectorAll("button, a") ?? [])].map((n) => n.textContent);
    expect(labels).toEqual(["Try again", 'Search for "miso butter"']);
    expect(alert?.querySelector("a")?.getAttribute("href")).toBe("/search?q=miso%20butter");
    expect(t.stateNow().history).toEqual([]);
  });

  it("Try again sends the same text once more, adds no second copy of the message, and clears the alert", async () => {
    let n = 0;
    const t = talk(() => (++n === 1 ? failed() : okAnswer()));
    await t.say("miso butter");
    await t.clickEl(
      [...t.messages().querySelectorAll("button")].find((b) => b.textContent === "Try again"),
    );
    expect(t.net.calls.map((c) => c.body?.text)).toEqual(["miso butter", "miso butter"]);
    expect(t.messages().querySelector('[role="alert"]')).toBeNull();
    expect(t.messages().querySelectorAll(".ask-me")).toHaveLength(1);
    expect(t.stateNow().history).toEqual([
      { role: "user", text: "miso butter" },
      { role: "assistant", text: "Done." },
    ]);
  });

  it("keeps the first alert and its Search link when Try again then gets no answer", async () => {
    let n = 0;
    const t = talk(() => {
      if (++n === 1) return failed();
      throw new Error("offline");
    });
    await t.say("miso butter");
    await t.clickEl(
      [...t.messages().querySelectorAll("button")].find((b) => b.textContent === "Try again"),
    );
    const alerts = [...t.messages().querySelectorAll('[role="alert"]')];
    expect(alerts.map((a) => a.querySelector("strong")?.textContent)).toEqual([
      "Fake didn't answer: the connection timed out.",
      "Something went wrong. Try again.",
    ]);
    expect(alerts[0]?.querySelector("a")?.getAttribute("href")).toBe("/search?q=miso%20butter");
    expect(t.stateNow().entries.filter((e: { kind: string }) => e.kind === "alert")).toHaveLength(
      2,
    );
  });

  it("with changes: lists them with their Undo, offers only Search, and keeps the pair", async () => {
    const t = talk(() =>
      failed({
        message: "Fake stopped before it finished: it took too long.",
        remember: "Fake stopped before it finished: it took too long.\n- link 5",
        changes: [link("5", { created: true })],
        cards: { "5": CARD("5") },
      }),
    );
    await t.say("save it");
    const alert = t.messages().querySelector('[role="alert"]');
    expect(alert?.querySelector("strong")?.textContent).toBe(
      "Fake stopped before it finished: it took too long.",
    );
    expect(alert?.textContent).toContain("It had already made these changes:");
    expect(alert?.textContent).toContain(
      "Check them, then try again or search your links the usual way.",
    );
    expect(alert?.textContent).not.toContain("Nothing was saved");
    expect(alert?.querySelector(".ask-card[data-id='5']")).not.toBeNull();
    expect(t.lines()).toEqual(["Saved.Undo"]);
    const labels = [...(alert?.querySelectorAll("a.ask-button, button.ask-button") ?? [])].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(['Search for "save it"']);
    expect(t.stateNow().history).toEqual([
      { role: "user", text: "save it" },
      { role: "assistant", text: "Fake stopped before it finished: it took too long.\n- link 5" },
    ]);
    const undo = alert?.querySelector("button.ask-undo");
    await t.clickEl(undo);
    expect(t.net.calls.at(-1)?.url).toBe("/links/delete");
  });

  it("shows the server's message for another status, and a fallback when there is none", async () => {
    const withMessage = talk(() => ({ status: 400, body: { message: "Send a JSON body." } }));
    await withMessage.say("x");
    expect(withMessage.messages().querySelector('[role="alert"]')?.textContent).toBe(
      "Send a JSON body.",
    );
    const none = talk(() => ({ status: 500 }));
    await none.say("x");
    expect(none.messages().querySelector('[role="alert"]')?.textContent).toBe(
      "Something went wrong. Try again.",
    );
    expect(none.stateNow().history).toEqual([]);
    expect(none.stateNow().pending).toBeNull();
    const send = none.document.querySelector(
      '#ask-form button[type="submit"]',
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it("puts the owner's text back in the box after a failure that never reached the turn", async () => {
    const t = talk(() => ({ status: 500 }));
    await t.say("keep this text");
    expect((t.el("ask-text") as HTMLTextAreaElement).value).toBe("keep this text");
    expect(t.net.calls).toHaveLength(1);
  });

  it("falls back the same way when the request never gets an answer", async () => {
    const t = load({
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    (t.el("ask-text") as HTMLTextAreaElement).value = "hi";
    t.el("ask-form").dispatchEvent(
      new t.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(t.panel().messages.querySelector('[role="alert"]')?.textContent).toBe(
      "Something went wrong. Try again.",
    );
  });
});

describe("redrawing the conversation", () => {
  it("draws the interrupted-turn notice once, clears pending and adds no history", () => {
    const notice =
      "This message was sent, but you left the page before the answer arrived. Anything it saved or changed is in your links.";
    const p = load({ stored: saved({ pending: { text: "hello" } }) });
    expect(p.panel().messages.textContent).toContain(notice);
    expect(p.stateNow().pending).toBeNull();
    expect(p.stateNow().history).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
    expect(p.stateNow().entries.at(-1)).toEqual({
      kind: "notice",
      text: notice,
      path: "/",
      place: "Home",
    });
    const next = load({ stored: p.stateNow() });
    expect(next.panel().messages.textContent?.split(notice)).toHaveLength(2);
  });

  it("draws nothing, and does not throw, for entries that are not known kinds with the right fields", () => {
    const junk: unknown[] = [
      null,
      5,
      "x",
      [],
      {},
      { kind: "me" },
      { kind: "me", text: 4 },
      { kind: "reply" },
      { kind: "reply", segments: "no" },
      { kind: "reply", segments: [null, 3, { text: 1 }, { card: {} }, {}] },
      {
        kind: "changes",
        lines: [null, { text: 1 }, { undo: { kind: "save", url: "/x", body: {} } }],
      },
      { kind: "changes", lines: "no" },
      { kind: "alert" },
      { kind: "alert", message: 5 },
      { kind: "notice" },
      { kind: "other", text: "t" },
    ];
    // The last line is a valid line (it draws its text) whose Undo is not: it must draw no button.
    junk.push({ kind: "changes", lines: [{ text: "x", undo: { kind: "save", faded: true } }] });
    const p = load({ stored: saved({ entries: junk, open: true }) });
    expect(p.el("ask-panel").hasAttribute("hidden")).toBe(false);
    expect(p.panel().messages.textContent).toBe("x");
    expect(p.panel().messages.querySelector("button, a, article")).toBeNull();
  });
});

describe("opening a saved link from the panel", () => {
  it("records the opening of a card's link by its card's id", async () => {
    const t = talk((call) =>
      call.url === "/ai/chat" ? okAnswer({ segments: [{ card: CARD("7") }] }) : { status: 204 },
    );
    await t.say("show");
    await t.clickEl(t.messages().querySelector("a[data-open]"));
    expect(t.net.calls.at(-1)).toEqual({ url: "/links/opened", method: "POST", body: { id: "7" } });
  });
});

/** A page of link cards, as the pages draw them: `data-id` on each card. */
const pageOf = (...ids: string[]) =>
  `<main>${ids.map((id) => `<article class="card" data-id="${id}">c${id}</article>`).join("")}</main>`;

describe("telling the AI which page the owner is on", () => {
  const sentPage = async (body: string, url = "/all?order=new", stored?: unknown) => {
    const t = talk(() => okAnswer(), { body, url, stored });
    await t.say("what is here");
    return posted(t).page;
  };
  const posted = (t: { net: { calls: Call[] } }) =>
    (t.net.calls[0]?.body ?? {}) as { page?: unknown; [key: string]: unknown };

  it("sends the address, the place and the link ids in page order, once each", async () => {
    expect(await sentPage(pageOf("4", "2", "4", "9"))).toEqual({
      path: "/all?order=new",
      place: "Home",
      ids: ["4", "2", "9"],
      shown: 3,
    });
  });

  it("skips hidden cards, the panel's own cards and ids that are not numbers", async () => {
    const body = `<main>${'<article data-id="1"></article>'}<div hidden><section><article data-id="2"></article></section></div><article data-id="x7"></article><article data-id=""></article><article data-id="3"></article></main>`;
    const stored = saved({
      entries: [{ kind: "reply", segments: [{ card: CARD("8") }] }],
    });
    expect(await sentPage(body, "/", stored)).toMatchObject({ ids: ["1", "3"], shown: 2 });
  });

  it("sends the first 60 ids and counts all of them in shown", async () => {
    const all = Array.from({ length: 70 }, (_, i) => String(i + 1));
    const page = (await sentPage(pageOf(...all))) as { ids: string[]; shown: number };
    expect(page.ids).toEqual(all.slice(0, MAX_PAGE_IDS));
    expect(page.shown).toBe(70);
  });

  it("cuts a long address to 300 characters", async () => {
    const page = (await sentPage(pageOf(), `/all?q=${"a".repeat(400)}`)) as { path: string };
    expect(page.path).toBe(`/all?q=${"a".repeat(400)}`.slice(0, 300));
  });

  it("reads the page when it sends, so cards added since the panel loaded count", async () => {
    const t = talk(() => okAnswer(), { body: pageOf("1") });
    t.document
      .querySelector("main")
      ?.insertAdjacentHTML("beforeend", '<article data-id="2"></article>');
    await t.say("x");
    expect(posted(t).page).toMatchObject({ ids: ["1", "2"] });
  });

  it("counts the page against the 400 KiB budget when it trims the history", () => {
    const p = load();
    const trim = p.panel().trimHistory as (
      history: unknown[],
      text: string,
      page?: unknown,
    ) => { role: string; text: string }[];
    const budget = 400 * 1024;
    const body = (h: unknown[]) =>
      new TextEncoder().encode(JSON.stringify({ history: h, text: "next" })).length;
    const make = (len: number) =>
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? { role: "user", text: "u".repeat(len) } : { role: "assistant", text: "a" },
      );
    // Four pairs that fit with a few bytes to spare.
    const len = Math.floor((budget - body(make(0))) / 4);
    expect(body(make(len))).toBeLessThanOrEqual(budget);
    expect(trim(make(len), "next")).toHaveLength(8);
    const page = { path: "/all", place: "All links", ids: ["1", "2", "3"], shown: 3 };
    expect(trim(make(len), "next", page)).toHaveLength(6);
  });
});

describe("what a page card can mean to the fade", () => {
  const FADE_PAGE = pageOf("1", "2", "3");
  const dimmed = (t: { document: Document }) =>
    [...t.document.querySelectorAll("[data-id].ask-dim")].map((n) => n.getAttribute("data-id"));
  const cited = (...ids: string[]) =>
    okAnswer({ segments: ids.map((id) => ({ card: CARD(id) })), cards: {} });
  const fading = (reply: Reply = cited("2")) => {
    const t = talk(() => reply, { body: FADE_PAGE });
    t.click("ask-open");
    return t;
  };

  it("dims the page's other cards when a reply names a card on the page", async () => {
    const t = fading();
    await t.say("which");
    expect(dimmed(t)).toEqual(["1", "3"]);
    expect(t.document.querySelector("main [data-id='2']")?.classList.contains("ask-dim")).toBe(
      false,
    );
  });

  it("never dims the panel's own cards", async () => {
    const t = fading(cited("2", "8"));
    await t.say("which");
    expect(t.messages().querySelector(".ask-dim")).toBeNull();
    expect(dimmed(t)).toEqual(["1", "3"]);
  });

  it("dims nothing when the reply names no card on the page", async () => {
    const t = fading(cited("8"));
    await t.say("which");
    expect(dimmed(t)).toEqual([]);
    expect(t.watching()).toBe(0);
  });

  it("dims nothing for a reply with no cards, or a failed turn", async () => {
    const none = fading(okAnswer());
    await none.say("which");
    expect(dimmed(none)).toEqual([]);
    const failed = fading({ status: 500, body: { code: "X", message: "no" } });
    await failed.say("which");
    expect(dimmed(failed)).toEqual([]);
  });

  it("dims nothing while the panel is closed", async () => {
    const t = talk(() => cited("2"), { body: FADE_PAGE });
    await t.say("which");
    expect(dimmed(t)).toEqual([]);
  });

  it("clears at the next send, and again when that reply names nothing on the page", async () => {
    let reply: Reply | Promise<Reply> = cited("2");
    const t = talk(() => reply, { body: FADE_PAGE });
    t.click("ask-open");
    await t.say("which");
    expect(dimmed(t)).toEqual(["1", "3"]);
    let release: (r: Reply) => void = () => {};
    reply = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    await t.say("and now");
    expect(dimmed(t)).toEqual([]);
    expect(t.watching()).toBe(0);
    release(cited("8"));
    await flush();
    expect(dimmed(t)).toEqual([]);
  });

  it("clears on Start over and on close, and stops watching the page", async () => {
    const restarted = fading();
    await restarted.say("which");
    expect(restarted.watching()).toBe(1);
    restarted.click("ask-restart");
    expect(dimmed(restarted)).toEqual([]);
    expect(restarted.watching()).toBe(0);

    const closed = fading();
    await closed.say("which");
    closed.click("ask-close");
    expect(dimmed(closed)).toEqual([]);
    expect(closed.watching()).toBe(0);
  });

  it("dims nothing for a reply that arrives after close or Start over", async () => {
    for (const leave of ["ask-close", "ask-restart"]) {
      let release: (r: Reply) => void = () => {};
      const waiting = new Promise<Reply>((resolve) => {
        release = resolve;
      });
      const t = talk(() => waiting, { body: FADE_PAGE });
      t.click("ask-open");
      await t.say("which");
      t.click(leave);
      release(cited("2"));
      await flush();
      expect(dimmed(t), leave).toEqual([]);
      expect(t.watching(), leave).toBe(0);
    }
  });

  it("dims a card that appears while the fade is on, unless it is a named one", async () => {
    const t = fading();
    await t.say("which");
    t.document
      .querySelector("main")
      ?.insertAdjacentHTML("beforeend", '<article data-id="5"></article>');
    t.document
      .querySelector("main")
      ?.insertAdjacentHTML("beforeend", '<article data-id="2" class="again"></article>');
    t.mutate();
    expect(dimmed(t)).toEqual(["1", "3", "5"]);
    expect(t.document.querySelector(".again")?.classList.contains("ask-dim")).toBe(false);
  });

  it("watches the whole page for added cards", async () => {
    const t = fading();
    await t.say("which");
    expect(t.watched()).toEqual([
      { target: t.document.body, options: { childList: true, subtree: true } },
    ]);
  });

  it("clears a card that was taken off the page during the fade and put back", async () => {
    const t = fading();
    await t.say("which");
    const card = t.document.querySelector("main [data-id='1']") as Element;
    expect(card.classList.contains("ask-dim")).toBe(true);
    const parent = card.parentElement as Element;
    card.remove();
    t.click("ask-close");
    parent.appendChild(card);
    expect(card.classList.contains("ask-dim")).toBe(false);
  });

  it("does not keep the fade in the stored state", async () => {
    const t = fading();
    await t.say("which");
    expect(JSON.stringify(t.stateNow())).not.toContain("ask-dim");
  });
});

describe("the page each entry was made on", () => {
  it("stores the address and the place on the entries it adds", async () => {
    const t = talk(
      () => okAnswer({ changes: [link("5", { created: true })], cards: { "5": CARD("5") } }),
      {
        url: "/spaces?tag=kitchen",
      },
    );
    await t.say("save it");
    const entries = t.stateNow().entries as { kind: string; path: string; place: string }[];
    expect(entries.map((e) => e.kind)).toEqual(["me", "reply", "changes"]);
    for (const e of entries)
      expect(e).toMatchObject({ path: "/spaces?tag=kitchen", place: "Home" });
  });

  it("stores them on a failure's alert too", async () => {
    const t = talk(() => ({ status: 500, body: { message: "Broke" } }), { url: "/all" });
    await t.say("hi");
    const entries = t.stateNow().entries as { kind: string; path: string }[];
    expect(entries.map((e) => e.kind)).toEqual(["me", "alert"]);
    for (const e of entries) expect(e.path).toBe("/all");
  });

  it("keeps the version at 1", async () => {
    const t = talk(() => okAnswer());
    await t.say("hi");
    expect(t.stateNow().v).toBe(1);
  });
});

describe("the Earlier line", () => {
  const OLD = { path: "/spaces?tag=kitchen", place: "Kitchen" };
  const old = <T extends object>(e: T) => ({ ...OLD, ...e });
  const here = <T extends object>(e: T) => ({ path: "/", place: "Home", ...e });
  const earlier = (p: { document: Document }) =>
    p.document.querySelector<HTMLButtonElement>("button.ask-earlier");
  const label = (entries: unknown[]) => earlier(load({ stored: saved({ entries }) }))?.textContent;
  const savedLine = (id: string) => ({ text: "Saved.", linkId: id });

  it("names a save that the reply shows as a card", () => {
    expect(
      label([
        old({ kind: "me", text: "save the kettle" }),
        old({ kind: "reply", segments: [{ text: "Done" }, { card: CARD("5", "Kettle") }] }),
        old({ kind: "changes", lines: [savedLine("5")], cards: {} }),
      ]),
    ).toBe('Earlier, on Kitchen: saved "Kettle"');
  });

  it("names a save that only the changes show", () => {
    expect(
      label([
        old({ kind: "me", text: "save the mug" }),
        old({ kind: "reply", segments: [{ text: "Done" }] }),
        old({ kind: "changes", lines: [savedLine("6")], cards: { "6": CARD("6", "Mug") } }),
      ]),
    ).toBe('Earlier, on Kitchen: saved "Mug"');
  });

  it("names a save that a failed turn made", () => {
    expect(
      label([
        old({ kind: "me", text: "save the mug" }),
        old({
          kind: "alert",
          message: "Broke",
          text: "save the mug",
          changed: true,
          lines: [savedLine("6")],
          cards: { "6": CARD("6", "Mug") },
        }),
      ]),
    ).toBe('Earlier, on Kitchen: saved "Mug"');
  });

  it("counts saves by link, so two links with one title are two", () => {
    expect(
      label([
        old({ kind: "me", text: "save both" }),
        old({
          kind: "changes",
          lines: [savedLine("5"), savedLine("6")],
          cards: { "5": CARD("5", "GitHub"), "6": CARD("6", "GitHub") },
        }),
      ]),
    ).toBe('Earlier, on Kitchen: saved "GitHub" and 1 more');
  });

  it("leaves out a save that was undone", () => {
    const undone = (id: string) => ({
      ...savedLine(id),
      undo: { kind: "save", url: "/links/delete", body: { id }, done: true },
    });
    const cards = { "5": CARD("5", "Kettle"), "6": CARD("6", "Mug") };
    expect(
      label([
        old({ kind: "me", text: "save it" }),
        old({ kind: "changes", lines: [undone("5")], cards }),
      ]),
    ).toBe('Earlier, on Kitchen: "save it"');
    expect(
      label([
        old({ kind: "me", text: "save both" }),
        old({ kind: "changes", lines: [undone("5"), savedLine("6")], cards }),
      ]),
    ).toBe('Earlier, on Kitchen: saved "Mug"');
  });

  it("says where an interrupted turn was sent from, not where it is noticed", () => {
    const p = load({
      url: "/all",
      stored: saved({
        entries: [old({ kind: "me", text: "save the kettle" })],
        pending: { text: "save the kettle", ...OLD },
      }),
    });
    expect(p.stateNow().entries.at(-1)).toMatchObject({ kind: "notice", ...OLD });
    expect(earlier(p)?.textContent).toBe('Earlier, on Kitchen: "save the kettle"');
  });

  it("says how many more were saved", () => {
    expect(
      label([
        old({ kind: "me", text: "save both" }),
        old({
          kind: "reply",
          segments: [{ card: CARD("5", "Kettle") }, { card: CARD("6", "Mug") }],
        }),
        old({ kind: "changes", lines: [savedLine("5"), savedLine("6")], cards: {} }),
      ]),
    ).toBe('Earlier, on Kitchen: saved "Kettle" and 1 more');
  });

  it("quotes the question when nothing was saved, cut to 60 characters", () => {
    expect(
      label([
        old({ kind: "me", text: "what do I have on batteries" }),
        old({ kind: "reply", segments: [{ text: "Two links." }] }),
      ]),
    ).toBe('Earlier, on Kitchen: "what do I have on batteries"');
    const long = "w".repeat(80);
    expect(label([old({ kind: "me", text: long }), old({ kind: "reply", segments: [] })])).toBe(
      `Earlier, on Kitchen: "${"w".repeat(60)}…"`,
    );
  });

  it("offers no Try again for a failure on another page, but keeps its Search link", () => {
    const failed = (extra: object) => ({
      kind: "alert",
      message: "Broke",
      text: "save the kettle",
      changed: false,
      ...extra,
    });
    const p = load({ stored: saved({ entries: [old(failed({}))] }) });
    const box = p.document.querySelector(".ask-earlier-entries .ask-alert") as Element;
    expect([...box.querySelectorAll("button")].map((b) => b.textContent)).toEqual([]);
    expect(box.querySelector("a")?.textContent).toBe('Search for "save the kettle"');
    expect(box.textContent).toContain(
      "Nothing was saved or changed. Search your links the usual way.",
    );
    expect(box.textContent).not.toContain("Try again");
    const same = load({ stored: saved({ entries: [here(failed({}))] }) });
    expect(
      [...same.document.querySelectorAll(".ask-alert button")].map((b) => b.textContent),
    ).toEqual(["Try again"]);
  });

  it("goes by the last exchange and the place of the last earlier entry", () => {
    expect(
      label([
        { path: "/all", place: "All links", kind: "me", text: "save the kettle" },
        {
          path: "/all",
          place: "All links",
          kind: "reply",
          segments: [{ card: CARD("5", "Kettle") }],
        },
        { path: "/all", place: "All links", kind: "changes", lines: [savedLine("5")], cards: {} },
        old({ kind: "me", text: "and the weather?" }),
        old({ kind: "reply", segments: [{ text: "No idea." }] }),
        here({ kind: "me", text: "now" }),
      ]),
    ).toBe('Earlier, on Kitchen: "and the weather?"');
  });

  it("hides the earlier entries, shows the ones from this page, and toggles on press", () => {
    const p = load({
      stored: saved({
        entries: [
          old({ kind: "me", text: "before" }),
          old({ kind: "reply", segments: [{ text: "Earlier answer" }] }),
          here({ kind: "me", text: "now" }),
          here({ kind: "reply", segments: [{ text: "Current answer" }] }),
        ],
      }),
    });
    const button = earlier(p) as HTMLButtonElement;
    const box = button.nextElementSibling as HTMLElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(box.hasAttribute("hidden")).toBe(true);
    expect(box.textContent).toContain("Earlier answer");
    expect(p.panel().messages.textContent).toContain("Current answer");
    const replies = p.panel().messages.querySelectorAll(".ask-reply");
    expect(box.contains(replies[0] ?? null)).toBe(true);
    expect(box.contains(replies[1] ?? null)).toBe(false);
    button.dispatchEvent(new p.window.Event("click", { bubbles: true }));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(box.hasAttribute("hidden")).toBe(false);
    button.dispatchEvent(new p.window.Event("click", { bubbles: true }));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(box.hasAttribute("hidden")).toBe(true);
  });

  it("keeps Undo working inside the earlier entries", async () => {
    const undo = { kind: "save", url: "/links/delete", body: { id: "5" } };
    const t = talk(() => ({ status: 204 }), {
      stored: saved({
        entries: [
          old({ kind: "me", text: "save it" }),
          old({
            kind: "changes",
            lines: [{ text: "Saved.", linkId: "5", undo }],
            cards: { "5": CARD("5", "Kettle") },
          }),
        ],
      }),
    });
    await t.clickEl(t.document.querySelector("button.ask-earlier"));
    await t.clickEl(t.document.querySelector(".ask-earlier + * button.ask-undo"));
    expect(t.net.calls.at(-1)).toEqual({ url: "/links/delete", method: "POST", body: { id: "5" } });
    expect(t.document.querySelector(".ask-earlier + * .ask-faded")).not.toBeNull();
    expect(t.document.querySelector(".ask-earlier + * .ask-undone")?.textContent).toBe("Undone.");
  });

  it("draws new entries after the earlier ones, outside the hidden box", async () => {
    const t = talk(() => okAnswer({ segments: [{ text: "Fresh" }] }), {
      stored: saved({
        entries: [old({ kind: "me", text: "before" }), old({ kind: "reply", segments: [] })],
      }),
    });
    await t.say("now");
    const box = t.document.querySelector(".ask-earlier + *") as HTMLElement;
    expect(box.hasAttribute("hidden")).toBe(true);
    expect(box.textContent).not.toContain("Fresh");
    expect(t.messages().lastElementChild?.textContent).toBe("Fresh");
  });

  it("shows no button for entries without an address, or all from this page", () => {
    const plain = load({ stored: saved() });
    expect(earlier(plain)).toBeNull();
    const here2 = load({ stored: saved({ entries: [here({ kind: "me", text: "x" })] }) });
    expect(earlier(here2)).toBeNull();
    expect(here2.panel().messages.textContent).toBe("x");
  });

  it("clears the button and the entries on Start over", () => {
    const p = load({ stored: saved({ entries: [old({ kind: "me", text: "before" })] }) });
    expect(earlier(p)).not.toBeNull();
    p.click("ask-restart");
    expect(earlier(p)).toBeNull();
    expect(p.panel().messages.children).toHaveLength(0);
  });
});
