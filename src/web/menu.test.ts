import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ASK_KEY } from "./ask-panel.js";
import { cardMenu, DIVIDER } from "./card-menu.js";
import { runAskPage, type runPage } from "./opened-test-kit.js";
import { page } from "./page.js";
import { olderScript } from "./show-older.js";
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
    expect(rows.map(text)).toEqual(["Profile", "Apps and keys", "Your data", "Sign out"]);
    expect(own(html, 'details a[href="/connections#your-data"]').map(text)).toEqual(["Your data"]);
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

  it("keeps the bar at the right edge when it wraps under the logo, so the open menu stays on screen", () => {
    expect(themeCss).toMatch(/\.menu\{[^}]*margin-left:auto/);
    expect(themeCss).toMatch(/\.account-list\{[^}]*right:0/);
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

const ITEMS = [
  { act: "done", icon: "", text: "It's stale" },
  DIVIDER,
  { act: "edit", icon: "", text: "Edit" },
];
const cards = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `<li class="card" data-i="${i}">${cardMenu(`More for ${i}`, ITEMS)}</li>`,
  ).join("");
const cardsPage = () =>
  page(
    "t",
    `<main><ul id="list">${cards(2)}</ul><a id="older" href="/more">older</a></main>${olderScript("list")}`,
    { menu: true, ask: ASK },
  );

describe("a card menu's dismissal", () => {
  type P = ReturnType<typeof runPage>;
  const start = () => runAskPage(cardsPage(), undefined, { menu: true });
  const menus = (p: P) => [...p.document.querySelectorAll("details.card-menu")] as HTMLElement[];
  const summary = (m: Element) => m.querySelector("summary") as HTMLElement;
  const open = (m: Element) => m.setAttribute("open", "");
  const row = (m: Element) => m.querySelector("button") as Element;

  it("closes on Escape inside it and puts focus back on its summary", () => {
    const p = start();
    const [first, second] = menus(p) as [HTMLElement, HTMLElement];
    open(first);
    open(second);
    p.dispatch(row(first), "keydown", KEY("Escape"));
    expect(first.hasAttribute("open")).toBe(false);
    expect(second.hasAttribute("open")).toBe(true);
    expect(p.focused().at(-1)).toBe(summary(first));
  });

  it("ignores other keys, and an Escape that happens outside every open menu", () => {
    const p = start();
    const [first] = menus(p) as [HTMLElement];
    open(first);
    p.dispatch(row(first), "keydown", KEY("Tab"));
    p.dispatch(p.$("main"), "keydown", KEY("Escape"));
    expect(first.hasAttribute("open")).toBe(true);
    expect(p.focused()).toEqual([]);
  });

  it("closes on a press outside it, and stays open for a press inside it", () => {
    const p = start();
    const [first] = menus(p) as [HTMLElement];
    open(first);
    p.dispatch(first.querySelector(".card-menu-list") as Element, "pointerdown");
    p.dispatch(summary(first), "pointerdown");
    expect(first.hasAttribute("open")).toBe(true);
    p.dispatch(p.$("main"), "pointerdown");
    expect(first.hasAttribute("open")).toBe(false);
  });

  it("closes when focus moves to something outside it, not to something inside it", () => {
    const p = start();
    const [first, second] = menus(p) as [HTMLElement, HTMLElement];
    open(first);
    p.dispatch(summary(first), "focusout", { relatedTarget: row(first) });
    expect(first.hasAttribute("open")).toBe(true);
    p.dispatch(summary(first), "focusout", { relatedTarget: null });
    expect(first.hasAttribute("open")).toBe(true);
    p.dispatch(row(first), "focusout", { relatedTarget: summary(second) });
    expect(first.hasAttribute("open")).toBe(false);
  });

  it("closes a menu on a card that Show older links appended", async () => {
    const next = `<ul id="list">${cards(1).replace('data-i="0"', 'data-i="late"')}</ul>`;
    const p = runAskPage(cardsPage(), () => ({ status: 200, text: next }), { menu: true });
    p.dispatch(p.$("#older"), "click");
    await p.settle();
    const late = p.$('[data-i="late"] details.card-menu');
    open(late);
    p.dispatch(row(late), "keydown", KEY("Escape"));
    expect(late.hasAttribute("open")).toBe(false);
    expect(p.focused().at(-1)).toBe(summary(late));
    open(late);
    p.dispatch(p.$("main"), "pointerdown");
    expect(late.hasAttribute("open")).toBe(false);
  });

  it("keeps the account menu and a card menu on their own rules when both are open", () => {
    const p = start();
    const [first] = menus(p) as [HTMLElement];
    const account = p.$("details.account-menu");
    open(first);
    open(account);
    p.dispatch(p.$("#sign-out"), "keydown", KEY("Escape"));
    expect(account.hasAttribute("open")).toBe(false);
    expect(first.hasAttribute("open")).toBe(true);
    expect(p.focused().at(-1)).toBe(summary(account));
    open(account);
    p.dispatch(row(first), "keydown", KEY("Escape"));
    expect(first.hasAttribute("open")).toBe(false);
    expect(account.hasAttribute("open")).toBe(true);
  });

  it("still closes the account menu on Escape from Ask AI in the nav, with a card menu on the page", () => {
    const p = start();
    const account = p.$("details.account-menu");
    open(account);
    p.dispatch(p.$("#ask-open"), "keydown", KEY("Escape"));
    expect(account.hasAttribute("open")).toBe(false);
    expect(p.focused().at(-1)).toBe(summary(account));
  });

  it("leaves card menus alone when the real Ask AI handler takes the Escape", () => {
    const p = start();
    const [first] = menus(p) as [HTMLElement];
    p.dispatch(p.$("#ask-open"), "click");
    open(first);
    p.dispatch(p.$("#ask-text"), "keydown", KEY("Escape"));
    expect(p.$("#ask-panel").hasAttribute("hidden")).toBe(true);
    expect(p.focused().at(-1)).toBe(p.$("#ask-open"));
    expect(first.hasAttribute("open")).toBe(true);
  });

  it("does not interfere with a row's own action: a press on it runs it once", () => {
    const p = start();
    const [first] = menus(p) as [HTMLElement];
    open(first);
    let runs = 0;
    row(first).addEventListener("click", () => {
      runs += 1;
    });
    p.dispatch(row(first), "pointerdown");
    p.dispatch(row(first), "click");
    expect(runs).toBe(1);
    expect(first.hasAttribute("open")).toBe(true);
  });

  it("puts every menu in one exclusive group, so the browser opens one at a time", () => {
    expect(cardMenu("More", ITEMS)).toContain('<details class="card-menu" name="menu">');
    expect(plain()).toContain('<details class="account-menu" name="menu">');
    const names = [...parseHTML(cardsPage()).document.querySelectorAll("details")].map((d) =>
      d.getAttribute("name"),
    );
    expect(names).toEqual(["menu", "menu", "menu"]);
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
