import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import type { Link } from "../core/types.js";

export type Post = { url: string; body: unknown; redirect: unknown; keepalive: unknown };

export type Answer = {
  status: number;
  type?: string;
  body?: unknown;
  text?: string;
  wait?: Promise<unknown>;
  textFails?: boolean;
  redirected?: boolean;
};

/**
 * A page in linkedom with all its scripts but the menu's run in one scope, as a browser shares
 * one global scope across a page's scripts, so two scripts that declare the same name fail.
 * `fetch` records each request (a GET has no body; a JSON body is parsed; any other body (a
 * `FormData`) is kept as sent) and replies with `answer`; timers never fire, so an Undo bar stays
 * up until the test clicks it.
 */
export function runPage(html: string, answer: (sent: Post) => Answer = () => ({ status: 204 })) {
  const { document, DOMParser } = parseHTML(html);
  const focusLog: Element[] = [];
  (
    document.defaultView as unknown as { HTMLElement: { prototype: { focus: () => void } } }
  ).HTMLElement.prototype.focus = function (this: Element) {
    focusLog.push(this);
  };
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => !s.includes("sign-out"))
    .join("\n");
  const sent: Post[] = [];
  const fetch = async (
    url: string,
    init?: { body?: string | FormData; redirect?: string; keepalive?: boolean },
  ) => {
    const request = {
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      redirect: init?.redirect,
      keepalive: init?.keepalive,
    };
    sent.push(request);
    const a = answer(request);
    if (a.wait) await a.wait;
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      type: a.type ?? "basic",
      redirected: a.redirected ?? false,
      json: async () => {
        if (a.body === undefined) throw new SyntaxError("no body");
        return a.body;
      },
      text: async () => {
        if (a.textFails) throw new TypeError("body read failed");
        return a.text ?? "";
      },
    };
  };
  const location = { href: "https://links.example/", reload: () => {} };
  new Function(
    "document",
    "fetch",
    "location",
    "addEventListener",
    "DOMParser",
    "setTimeout",
    "clearTimeout",
    code,
  )(
    document,
    fetch,
    location,
    () => {},
    DOMParser,
    () => 0,
    () => {},
  );
  const win = document.defaultView as unknown as typeof globalThis;
  const dispatch = (target: Element, type: string, init: Record<string, unknown> = {}) => {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, init);
    target.dispatchEvent(event);
    return event;
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
  return { document, sent, dispatch, settle, $, location, focused: () => focusLog };
}

/**
 * The page's edit dialog, with `showModal` and `close` standing in for the browser's: linkedom
 * has neither, and `close` fires the dialog's close event as a browser does.
 */
export function stubDialog(page: ReturnType<typeof runPage>) {
  const dialog = page.$("#edit-link") as HTMLElement & {
    open?: boolean;
    showModal(): void;
    close(): void;
  };
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    if (!dialog.open) return;
    dialog.open = false;
    page.dispatch(dialog, "close");
  };
  return dialog;
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
  const page = runPage(first, () => ({ status: 204, text: next }));
  page.dispatch(page.document.getElementById("older") as Element, "click");
  await page.settle();
  const link = page.document.querySelector(`[data-id="${appendedId}"] a[data-open]`);
  if (!link) throw new Error("the appended card's link is missing");
  page.dispatch(link, "click");
  await page.settle();
  return page.sent.filter((s) => s.body !== undefined);
}
