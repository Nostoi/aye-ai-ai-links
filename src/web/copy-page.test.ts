import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { CopyView } from "../core/copy-reading.js";
import type { Link } from "../core/types.js";
import { copyPage } from "./copy-page.js";
import { displayTitle } from "./display-title.js";
import { runPage } from "./opened-test-kit.js";

const NOW = new Date("2026-10-21T12:00:00Z");
const MADE = new Date("2026-10-01T00:00:00Z");
const BACK = { label: "Kitchen", href: "/spaces?tag=kitchen" };

const link = (over: Partial<Link> = {}): Link => ({
  id: "7",
  url: "https://a.example/the-page",
  urlKey: "a.example/the-page",
  title: "Quokka",
  summary: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-09-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});

const render = (over: Partial<Link> = {}, back = BACK, markdown = "A paragraph.") =>
  copyPage(
    {
      link: link(over),
      madeAt: MADE,
      copy: {
        markdown,
        madeAt: MADE,
        finished: true,
        nonce: null,
        images: new Map(),
      },
    } satisfies CopyView,
    NOW,
    back,
  );
const dom = (html: string) => parseHTML(html).document;
const text = (html: string, selector: string) =>
  dom(html).querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();

describe("the copy page's frame", () => {
  it("has the app's top bar with its menu and no Ask AI", () => {
    const d = dom(render());
    expect(
      [...d.querySelectorAll("nav.menu .menu-page")].map((a) => a.getAttribute("href")),
    ).toEqual(["/all", "/tags"]);
    expect(d.querySelector("#sign-out")).not.toBeNull();
    expect(d.querySelector("#ask-open, #ask-panel")).toBeNull();
  });

  it("names the title from displayTitle, never a raw address", () => {
    const bare = link({ title: null, snapshot: null });
    expect(displayTitle(bare)).not.toBe(bare.url);
    expect(text(render({ title: null }), "h1")).toBe(displayTitle(bare));
    const snap = {
      status: "ok" as const,
      fetchedAt: MADE,
      title: "Quokka facts",
      description: null,
      imageUrl: null,
    };
    expect(text(render({ title: null, snapshot: snap }), "h1")).toBe("Quokka facts");
    expect(text(render({ title: "https://a.example/the-page" }), "h1")).not.toBe(
      "https://a.example/the-page",
    );
  });

  it("keeps the title the page's only h1, with the article's own headings below it", () => {
    const d = dom(render({}, BACK, "# Hello\n\n## Part\n\nA paragraph."));
    expect([...d.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Quokka"]);
    expect(d.querySelector("article h2")?.textContent).toBe("Hello");
    expect(d.querySelector("article h3")?.textContent).toBe("Part");
  });

  it("shows one grey line, dated by the copy", () => {
    const d = dom(render());
    const lines = [...d.querySelectorAll(".copy-line")];
    expect(lines.map((p) => p.textContent)).toEqual([
      "Your copy from October 1 · the page may have changed",
    ]);
    const html = render();
    expect(html).not.toContain("A reading copy kept by this app");
    expect(html).not.toContain("Saved copy from");
  });

  it("shows the why as an owner's or as a guess, and nothing without one", () => {
    expect(text(render({ why: { text: "for the trip", source: "stated" } }), ".copy-why")).toBe(
      '"for the trip"',
    );
    expect(text(render({ why: { text: "for the trip", source: "inferred" } }), ".copy-why")).toBe(
      "Why (a guess): for the trip",
    );
    expect(dom(render()).querySelector(".copy-why")).toBeNull();
    expect(text(render({ why: { text: "<b>x</b>", source: "asked" } }), ".copy-why")).toBe(
      '"<b>x</b>"',
    );
  });

  it("puts Back above the title and Open on the site beside it, in the link's card", () => {
    const html = render();
    const d = dom(html);
    const nav = d.querySelector(".copy-nav") as Element;
    const back = nav.querySelector("a.back-link") as Element;
    expect(back.getAttribute("href")).toBe(BACK.href);
    expect(back.textContent).toContain("Back to Kitchen");
    const open = nav.querySelector("a[data-open]") as Element;
    expect(open.getAttribute("href")).toBe("https://a.example/the-page");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(open.textContent?.replace(/\s+/g, " ")).toContain("Open on a.example");
    expect(open.querySelector(".visually-hidden")?.textContent).toBe(" (opens in a new tab)");
    expect(open.closest("[data-id]")?.getAttribute("data-id")).toBe("7");
    expect(
      nav.compareDocumentPosition(d.querySelector("h1") as Element) &
        4 /* DOCUMENT_POSITION_FOLLOWING */,
    ).toBeTruthy();
    expect(d.querySelectorAll("a[data-open]")).toHaveLength(1);
  });

  it("records a click or middle click on Open, and no other click", async () => {
    const page = runPage(render());
    const open = page.$("a[data-open]");
    const click = page.dispatch(open, "click");
    page.dispatch(open, "auxclick", { button: 1 });
    page.dispatch(page.$(".back-link"), "click");
    page.dispatch(page.$("h1"), "click");
    await page.settle();
    expect(click.defaultPrevented).toBe(false);
    expect(page.sent).toEqual([
      { url: "/links/opened", body: { id: "7" }, redirect: "manual", keepalive: true },
      { url: "/links/opened", body: { id: "7" }, redirect: "manual", keepalive: true },
    ]);
  });

  it("has no Open link for a link that is not a web address, and keeps Back", () => {
    const html = render({ url: "file:///notes.txt", title: "Notes" });
    const d = dom(html);
    expect(d.querySelector("a[data-open], a[target=_blank]")).toBeNull();
    expect(d.querySelector(".copy-nav a.back-link")).not.toBeNull();
  });

  it("escapes the place it names", () => {
    const html = render({}, { label: "<b>Tom & Jerry</b>", href: "/x?a=1&b=2" });
    expect(dom(html).querySelector(".copy-nav b")).toBeNull();
    expect(text(html, "a.back-link")).toContain("Back to <b>Tom & Jerry</b>");
    expect(dom(html).querySelector("a.back-link")?.getAttribute("href")).toBe("/x?a=1&b=2");
  });
});
