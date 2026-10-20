import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ASK_KEY } from "./ask-panel.js";
import { runAskPage, type runPage } from "./opened-test-kit.js";
import { page } from "./page.js";
import { themeCss } from "./theme.js";

/** The navigation every signed-in page shares (#196). */

const ASK = { ai: "Fake", place: "Home", owner: "owner-a" };
const plain = () => page("t", "<main>body</main>", { menu: true });
const withAsk = () => page("t", "<main>body</main>", { menu: true, undo: true, ask: ASK });

const text = (e: Element) => e.textContent?.replace(/\s+/g, " ").trim();
const nav = (html: string) => parseHTML(html).document.querySelector("nav") as HTMLElement;
const own = (html: string, selector: string) => [...nav(html).querySelectorAll(selector)];

describe("the navigation bar", () => {
  it("holds two page links and an account menu, not the old flat list of six", () => {
    const bar = nav(plain());
    expect(bar.getAttribute("aria-label")).toBe("Main");
    const top = [...bar.children];
    expect(top.map((e) => e.tagName)).toEqual(["A", "A", "DETAILS"]);
    expect(top.slice(0, 2).map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["All links", "/all"],
      ["Spaces and tags", "/tags"],
    ]);
    expect(own(plain(), "nav > button")).toEqual([]);
    expect(text(bar)).not.toContain("Tags");
    const reached = [...bar.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(reached.filter((h) => h === "/profile" || h === "/connections")).toHaveLength(2);
    for (const href of ["/profile", "/connections"]) {
      expect(bar.querySelector(`nav > a[href="${href}"]`)).toBeNull();
      expect(bar.querySelector(`details a[href="${href}"]`)).not.toBeNull();
    }
  });

  it("puts Profile, Apps and keys and Sign out in the account menu, with one Sign out", () => {
    const html = plain();
    const rows = own(html, "details .account-list > *").filter(
      (e) => !e.classList.contains("menu-phone-only"),
    );
    expect(rows.map(text)).toEqual(["Profile", "Apps and keys", "Sign out"]);
    expect(html.match(/id="sign-out"/g)).toHaveLength(1);
    expect(nav(html).querySelector("details #sign-out")).not.toBeNull();
  });

  it("repeats the two page links inside the menu for the phone, hidden at desktop width", () => {
    const html = plain();
    const phoneOnly = own(html, "details .menu-phone-only");
    expect(phoneOnly.map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["All links", "/all"],
      ["Spaces and tags", "/tags"],
    ]);
    expect(themeCss).toMatch(/\.menu-phone-only\{display:none\}/);
    expect(themeCss).toMatch(/@media \(max-width:600px\)\{[^@]*\.menu-page\{display:none\}/);
    expect(themeCss).toMatch(/@media \(max-width:600px\)\{[^@]*\.menu-phone-only\{display:flex\}/);
  });

  it("names its one summary Account at desktop width and Menu on the phone", () => {
    const summary = nav(plain()).querySelector("summary") as HTMLElement;
    const labels = [...summary.querySelectorAll(".visually-hidden")];
    expect(labels.map((l) => [text(l), l.className])).toEqual([
      ["Account", "visually-hidden label-wide"],
      ["Menu", "visually-hidden label-phone"],
    ]);
    expect(summary.querySelector("[aria-hidden=true]")).not.toBeNull();
    expect(themeCss).toMatch(/\.label-phone\{display:none\}/);
    expect(themeCss).toMatch(/@media \(max-width:600px\)\{[^@]*\.label-wide[^{]*\{display:none\}/);
    expect(themeCss).toMatch(/@media \(max-width:600px\)\{[^@]*\.label-phone\{display:inline\}/);
  });

  it("makes the summary and every row at least 44px", () => {
    expect(themeCss).toMatch(/\.account-menu summary\{[^}]*min-height:44px[^}]*min-width:44px/);
    expect(themeCss).toMatch(/\.account-list a,\.account-list button\{[^}]*min-height:44px/);
    expect(themeCss).toMatch(/\.menu-page\{[^}]*min-height:44px/);
  });

  it("puts Ask AI outside the account menu, between the page links and it, only with the AI set up", () => {
    const withAI = nav(withAsk());
    expect([...withAI.children].map((e) => text(e) ?? "")).toEqual([
      "All links",
      "Spaces and tags",
      "Ask AI",
      expect.stringContaining("Account"),
    ]);
    expect(withAI.querySelector("details #ask-open")).toBeNull();
    expect(withAI.querySelector(":scope > #ask-open")).not.toBeNull();
    const without = plain();
    expect(without).not.toContain("ask-open");
    expect(without).not.toContain("ask-panel");
    expect(without).not.toContain(ASK_KEY);
    expect(nav(without).querySelector("#sign-out")).not.toBeNull();
  });
});

const KEY = (key: string) => ({ key });

describe("the account menu's dismissal", () => {
  const open = (page_: ReturnType<typeof runPage>) =>
    page_.$("details.account-menu").setAttribute("open", "");
  const isOpen = (page_: ReturnType<typeof runPage>) =>
    page_.$("details.account-menu").hasAttribute("open");

  it("closes on Escape from inside the nav and puts focus back on its summary", () => {
    const p = runAskPage(withAsk(), undefined, { menu: true });
    open(p);
    p.dispatch(p.$("#sign-out"), "keydown", KEY("Escape"));
    expect(isOpen(p)).toBe(false);
    expect(p.focused().at(-1)).toBe(p.$("details.account-menu summary"));
  });

  it("leaves it open when another handler already took the Escape", () => {
    const p = runAskPage(withAsk(), undefined, { menu: true });
    open(p);
    const row = p.$("#sign-out");
    row.addEventListener("keydown", (event) => event.preventDefault());
    p.dispatch(row, "keydown", KEY("Escape"));
    expect(isOpen(p)).toBe(true);
  });

  it("ignores other keys", () => {
    const p = runAskPage(withAsk(), undefined, { menu: true });
    open(p);
    p.dispatch(p.$("#sign-out"), "keydown", KEY("Tab"));
    expect(isOpen(p)).toBe(true);
  });

  it("closes on a press outside it, and stays open for a press inside it", () => {
    const p = runAskPage(withAsk(), undefined, { menu: true });
    open(p);
    p.dispatch(p.$("details.account-menu .account-list"), "pointerdown");
    expect(isOpen(p)).toBe(true);
    p.dispatch(p.$("main"), "pointerdown");
    expect(isOpen(p)).toBe(false);
  });

  it("closes when focus moves from the nav to something outside it, not to something inside", () => {
    const p = runAskPage(withAsk(), undefined, { menu: true });
    open(p);
    p.dispatch(p.$("details.account-menu summary"), "focusout", {
      relatedTarget: p.$("#ask-open"),
    });
    expect(isOpen(p)).toBe(true);
    p.dispatch(p.$("details.account-menu summary"), "focusout", {
      relatedTarget: p.$("#ask-text"),
    });
    expect(isOpen(p)).toBe(false);
  });

  it("does not take focus from Ask AI: Escape in the panel closes the panel and focuses Ask AI", () => {
    const p = runAskPage(withAsk(), undefined, { menu: true });
    p.dispatch(p.$("#ask-open"), "click");
    open(p);
    p.dispatch(p.$("details.account-menu summary"), "focusout", {
      relatedTarget: p.$("#ask-text"),
    });
    p.dispatch(p.$("#ask-text"), "keydown", KEY("Escape"));
    expect(p.$("#ask-panel").hasAttribute("hidden")).toBe(true);
    expect(p.focused().at(-1)).toBe(p.$("#ask-open"));
    expect(p.focused().at(-1)).not.toBe(p.$("details.account-menu summary"));
  });

  it("does the same when focus is still in the nav: the panel's Escape is not the menu's", () => {
    const p = runAskPage(withAsk(), undefined, { menu: true });
    p.dispatch(p.$("#ask-open"), "click");
    open(p);
    p.dispatch(p.$("#ask-text"), "keydown", KEY("Escape"));
    expect(p.focused().at(-1)).toBe(p.$("#ask-open"));
  });
});

describe("Sign out", () => {
  it("with the AI on, posts the sign-out once, clears the conversation, then goes to /login", async () => {
    const p = runAskPage(withAsk(), undefined, {
      menu: true,
      stored: {
        v: 1,
        owner: ASK.owner,
        open: false,
        entries: [{ kind: "me", text: "hello" }],
        history: [{ role: "user", text: "hello" }],
        pending: null,
      },
    });
    expect(p.items.has(ASK_KEY)).toBe(true);
    p.dispatch(p.$("#sign-out"), "click");
    await p.settle();
    expect(p.sent.filter((s) => s.url === "/api/auth/sign-out")).toHaveLength(1);
    expect(p.sent).toHaveLength(1);
    expect(p.items.has(ASK_KEY)).toBe(false);
    expect(p.location.href).toBe("/login");
  });
});
