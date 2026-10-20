import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ASK_KEY } from "./ask-panel.js";
import { PAGE_STYLE, page } from "./page.js";
import { askCss, themeCss } from "./theme.js";

const ASK = { ai: "Fake", place: "Home", owner: "owner-a" };
const HOSTILE = "<b>x</b>";

const withAsk = (ask = ASK) => page("t", "<main>body</main>", { menu: true, undo: true, ask });

describe("the Ask AI panel's markup", () => {
  const { document } = parseHTML(withAsk({ ai: HOSTILE, place: HOSTILE, owner: HOSTILE }));
  const html = withAsk({ ai: HOSTILE, place: HOSTILE, owner: HOSTILE });
  const panel = document.getElementById("ask-panel");

  it("puts Ask AI between Apps and keys and Sign out, as a toggle for the panel", () => {
    const items = [...document.querySelectorAll(".menu > *")].map((e) => e.textContent?.trim());
    expect(items).toEqual(["All links", "Tags", "Profile", "Apps and keys", "Ask AI", "Sign out"]);
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

  it("uses only theme tokens for colour", () => {
    expect(askCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
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
}: {
  stored?: unknown;
  storage?: Partial<Storage>;
  phone?: boolean;
} = {}) {
  const html = withAsk();
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
    .filter((s) => s.includes(ASK_KEY))
    .join("\n");
  const matchMedia = () => ({ matches: phone, addEventListener: () => {} });
  new Function("document", "window", "sessionStorage", "matchMedia", code)(
    document,
    window,
    sessionStorage,
    matchMedia,
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
    /** What the script exposes for the sending code. */
    panel: () =>
      (
        window as unknown as {
          askPanel: {
            state: Record<string, unknown> & { entries: unknown[]; history: unknown[] };
            messages: HTMLElement;
            save: () => void;
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
  history: [{ role: "user", text: "hello" }],
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
    expect(p.panel().state.history).toHaveLength(1);
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
  it("is not done here: submitting the form only stops the page from reloading", () => {
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
