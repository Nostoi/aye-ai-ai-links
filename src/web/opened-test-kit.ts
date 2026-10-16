import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import type { Link } from "../core/types.js";

export type Post = { url: string; body: unknown; redirect: unknown; keepalive: unknown };

/**
 * A page in linkedom with all its scripts but the menu's run in one scope, so two scripts that
 * declare the same name fail. `fetch` records each request and answers `text` (a next page for
 * Show older links).
 */
export function runPage(html: string, text = "") {
  const { document, DOMParser } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => !s.includes("sign-out"))
    .join("\n");
  const sent: Post[] = [];
  const fetch = async (
    url: string,
    init?: { body?: string; redirect?: string; keepalive?: boolean },
  ) => {
    sent.push({
      url,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
      redirect: init?.redirect,
      keepalive: init?.keepalive,
    });
    return { status: 204, ok: true, redirected: false, text: async () => text };
  };
  const location = { href: "https://links.example/" };
  new Function("document", "fetch", "location", "addEventListener", "DOMParser", code)(
    document,
    fetch,
    location,
    () => {},
    DOMParser,
  );
  const win = document.defaultView as unknown as typeof globalThis;
  const dispatch = (target: Element, type: string, init: Record<string, unknown> = {}) => {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, init);
    target.dispatchEvent(event);
    return event;
  };
  const settle = async () => {
    for (let i = 0; i < 2; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { document, sent, dispatch, settle };
}

/**
 * The opening contract every page that links out to saved links keeps (#124): each such link is
 * marked and sits in the card naming its link, and a click or middle click on it posts that id to
 * `route` with keepalive while the link still opens. `links` are the web links the page shows.
 */
export function itRecordsOpenings(html: () => string, links: Link[], route: string) {
  it("marks every saved link it links out to, inside the card that names that link", () => {
    const { document } = runPage(html());
    const out = [...document.querySelectorAll("a[target=_blank]")];
    expect(out.map((a) => a.getAttribute("href")).sort()).toEqual(links.map((l) => l.url).sort());
    for (const a of out) {
      const card = a.closest("[data-id]");
      expect(a.hasAttribute("data-open")).toBe(true);
      expect(links.find((l) => l.id === card?.getAttribute("data-id"))?.url).toBe(
        a.getAttribute("href"),
      );
    }
  });

  it(`posts a click or middle click on a saved link to ${route} with keepalive, letting it open`, async () => {
    const page = runPage(html());
    const [first, second] = [...page.document.querySelectorAll("a[data-open]")];
    if (!first || !second) throw new Error("the fixture needs two web links");
    const click = page.dispatch(first, "click");
    page.dispatch(second, "auxclick", { button: 1 });
    await page.settle();
    expect(click.defaultPrevented).toBe(false);
    const id = (a: Element) => a.closest("[data-id]")?.getAttribute("data-id");
    expect(page.sent).toEqual([
      { url: route, body: { id: id(first) }, redirect: "manual", keepalive: true },
      { url: route, body: { id: id(second) }, redirect: "manual", keepalive: true },
    ]);
  });

  it("records no right click, and no click elsewhere on the card", async () => {
    const page = runPage(html());
    const link = page.document.querySelector("a[data-open]") as Element;
    page.dispatch(link, "auxclick", { button: 2 });
    page.dispatch(link.closest("[data-id]") as Element, "click");
    await page.settle();
    expect(page.sent).toEqual([]);
  });
}

/** After Show older links appends the next page, a click on an appended link is recorded too. */
export async function openAppended(first: string, next: string, appendedId: string) {
  const page = runPage(first, next);
  page.dispatch(page.document.getElementById("older") as Element, "click");
  await page.settle();
  const link = page.document.querySelector(`[data-id="${appendedId}"] a[data-open]`);
  if (!link) throw new Error("the appended card's link is missing");
  page.dispatch(link, "click");
  await page.settle();
  return page.sent.filter((s) => s.body !== undefined);
}
