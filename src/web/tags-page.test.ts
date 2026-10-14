import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { Tag } from "../core/types.js";
import { tagsPage } from "./tags-page.js";

const tag = (over: Partial<Tag> & { key: string }): Tag => ({
  name: over.key,
  kind: "topic",
  kindSource: "stated",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
  ...over,
});

const KITCHEN = tag({
  key: "kitchen",
  name: "Kitchen",
  kind: "project",
  kindSource: "inferred",
  color: "clay",
  pinned: true,
  projectStatus: "active",
});
const BAKING = tag({ key: "baking", name: "Baking" });
const HOME = tag({ key: "home", name: "Home batteries", color: "teal", pinned: true });

type Answer = { status: number; type?: string; body?: unknown };
type Sent = { url: string; body: unknown; redirect: unknown };
const REDIRECT: Answer = { status: 0, type: "opaqueredirect" };
/** The server's answer to a tag action: the tag after the change. */
const ok = (t: Tag): Answer => ({ status: 200, body: { tag: t } });

/** The page in linkedom with its own script and the Undo bar's run against it, timers stubbed. */
function load(answer: (sent: Sent) => Answer, tags: Tag[] = [KITCHEN, BAKING, HOME]) {
  const html = tagsPage({ tags });
  const { document, window } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => !s.includes("sign-out"))
    .join("\n");
  const sent: Sent[] = [];
  const fetch = async (url: string, init: { body: string; redirect?: string }) => {
    const request = { url, body: JSON.parse(init.body), redirect: init.redirect };
    sent.push(request);
    const a = answer(request);
    return {
      status: a.status,
      type: a.type ?? "basic",
      json: async () => {
        if (a.body === undefined) throw new SyntaxError("no body");
        return a.body;
      },
    };
  };
  // linkedom tracks no focus: `focused` stands in for it, and as in Chrome, disabling the
  // focused button drops focus to the body.
  let focused: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => focused });
  for (const el of document.querySelectorAll("button")) {
    (el as HTMLElement).focus = () => {
      focused = el;
    };
    let disabled = false;
    Object.defineProperty(el, "disabled", {
      get: () => disabled,
      set: (on: boolean) => {
        disabled = on;
        if (on && focused === el) focused = document.body;
      },
    });
  }
  new Function("document", "fetch", "setTimeout", "clearTimeout", code)(
    document,
    fetch,
    () => 0,
    () => {},
  );
  const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
  const row = (key: string) => $(`li[data-key="${key}"]`);
  const inRow = (key: string, selector: string) => row(key).querySelector(selector) as HTMLElement;
  const click = (el: HTMLElement) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { $, row, inRow, click, settle, sent, document, focused: () => focused };
}

const pressedOf = (el: HTMLElement) => el.getAttribute("aria-pressed");

describe("the Tags page as served", () => {
  const html = tagsPage({ tags: [KITCHEN, BAKING, HOME] });
  const { document } = parseHTML(html);
  const row = (key: string) => document.querySelector(`li[data-key="${key}"]`) as HTMLElement;
  const kind = (key: string) => row(key).querySelector(".kind")?.textContent;

  it("shows an inferred project as a guess, with the note, and neither kind chosen", () => {
    expect(kind("kitchen")).toBe("Project? (a guess)");
    expect((row("kitchen").querySelector(".guess-note") as HTMLElement).hidden).toBe(false);
    for (const b of row("kitchen").querySelectorAll("button[data-kind]")) {
      expect(pressedOf(b as HTMLElement)).toBe("false");
    }
  });

  it("shows a topic plainly though an AI inferred it, and an asked project plainly", () => {
    const page = parseHTML(
      tagsPage({
        tags: [
          tag({ key: "t", kindSource: "inferred" }),
          tag({ key: "p", kind: "project", kindSource: "asked" }),
        ],
      }),
    ).document;
    const label = (key: string) => page.querySelector(`li[data-key="${key}"] .kind`)?.textContent;
    expect(label("t")).toBe("Topic");
    expect(label("p")).toBe("Project");
    expect(page.querySelector('li[data-key="t"] .guess-note')?.hasAttribute("hidden")).toBe(true);
    expect(
      page
        .querySelector('li[data-key="t"] button[data-kind="topic"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(page.querySelector('li[data-key="p"] .guess-note')?.hasAttribute("hidden")).toBe(true);
  });

  it("offers a status only for a project, and shows a done project as done", () => {
    const page = parseHTML(
      tagsPage({ tags: [tag({ key: "p", kind: "project", projectStatus: "done" }), BAKING] }),
    ).document;
    expect(page.querySelector('li[data-key="p"] .kind')?.textContent).toBe("Project, done");
    expect(page.querySelector('li[data-key="p"] fieldset.status')?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(
      page
        .querySelector('li[data-key="p"] button[data-status="done"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      page.querySelector('li[data-key="baking"] fieldset.status')?.hasAttribute("hidden"),
    ).toBe(true);
  });

  it("gives a colored tag its space color and a tag never colored the neutral dot", () => {
    expect(row("kitchen").querySelector(".dot")?.className).toBe("dot space-clay");
    expect(row("baking").querySelector(".dot")?.className).toBe("dot");
    expect(pressedOf(row("kitchen").querySelector('[data-color="clay"]') as HTMLElement)).toBe(
      "true",
    );
    expect(row("kitchen").querySelectorAll(".swatch")).toHaveLength(6);
    expect(row("kitchen").querySelector('[data-color="amber"], .space-amber')).toBeNull();
  });

  it("says whether each tag is pinned", () => {
    const pin = (key: string) => row(key).querySelector('[data-action="pin"]') as HTMLElement;
    expect(pin("kitchen").textContent).toBe("Pinned to home");
    expect(pressedOf(pin("kitchen"))).toBe("true");
    expect(pin("baking").textContent).toBe("Pin to home");
    expect(pressedOf(pin("baking"))).toBe("false");
  });

  it("escapes a hostile name and key", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const served = tagsPage({ tags: [tag({ key: evil, name: evil })] });
    expect(served).not.toContain("<img src=x");
    expect(served).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(parseHTML(served).document.querySelector("li")?.getAttribute("data-key")).toBe(evil);
  });

  it("says so when there are no tags", () => {
    expect(tagsPage({ tags: [] })).toContain("No tags yet.");
  });
});

describe("pinning on the page", () => {
  it("posts the key without following redirects and draws the tag the server returns", async () => {
    const pinned = { ...BAKING, pinned: true, color: "violet" };
    const page = load(() => ok(pinned));
    page.click(page.inRow("baking", '[data-action="pin"]'));
    await page.settle();
    expect(page.sent).toEqual([
      { url: "/tags/pin", body: { key: "baking", pinned: true }, redirect: "manual" },
    ]);
    const pin = page.inRow("baking", '[data-action="pin"]');
    expect(pin.textContent).toBe("Pinned to home");
    expect(pressedOf(pin)).toBe("true");
    expect(page.inRow("baking", ".dot").className).toBe("dot space-violet");
    expect(pressedOf(page.inRow("baking", '[data-color="violet"]'))).toBe("true");
    expect(page.$("#undo-bar").hidden).toBe(true);
  });

  it("unpinning offers Undo, which pins it again with the color it kept", async () => {
    const page = load((sent) =>
      ok({ ...KITCHEN, pinned: (sent.body as { pinned: boolean }).pinned }),
    );
    page.click(page.inRow("kitchen", '[data-action="pin"]'));
    await page.settle();
    expect(page.inRow("kitchen", '[data-action="pin"]').textContent).toBe("Pin to home");
    expect(page.$("#undo-bar").hidden).toBe(false);
    expect(page.$("#undo-bar span").textContent).toBe("Kitchen unpinned.");
    page.click(page.$("#undo-bar button"));
    await page.settle();
    expect(page.sent[1]).toEqual({
      url: "/tags/pin",
      body: { key: "kitchen", pinned: true },
      redirect: "manual",
    });
    expect(page.inRow("kitchen", '[data-action="pin"]').textContent).toBe("Pinned to home");
    expect(page.inRow("kitchen", ".dot").className).toBe("dot space-clay");
    expect(page.$("#undo-bar").hidden).toBe(true);
  });

  it("moves focus to Undo after unpinning, and back to the pin button after Undo", async () => {
    const page = load((sent) =>
      ok({ ...KITCHEN, pinned: (sent.body as { pinned: boolean }).pinned }),
    );
    const pin = page.inRow("kitchen", '[data-action="pin"]');
    pin.focus();
    page.click(pin);
    await page.settle();
    expect(page.focused()).toBe(page.$("#undo-bar button"));
    page.click(page.$("#undo-bar button"));
    await page.settle();
    expect(page.focused()).toBe(pin);
  });

  it.each([
    ["a redirect to the sign-in page", REDIRECT, /did not work/],
    ["a 200 for another tag", ok(BAKING), /did not work/],
    [
      "a refusal",
      { status: 404, body: { message: "That tag is not there any more. Reload the page." } },
      /not there any more/,
    ],
  ])("keeps the row as it was and offers no Undo after %s", async (_, answer, message) => {
    const page = load(() => answer);
    page.click(page.inRow("kitchen", '[data-action="pin"]'));
    await page.settle();
    expect(page.inRow("kitchen", '[data-action="pin"]').textContent).toBe("Pinned to home");
    expect(page.$("#undo-bar").hidden).toBe(true);
    expect(page.$("#tags-error").textContent).toMatch(message);
  });

  it("sends one request while one is pending", async () => {
    const page = load(() => ok({ ...BAKING, pinned: true, color: "violet" }));
    page.click(page.inRow("baking", '[data-action="pin"]'));
    page.click(page.inRow("baking", '[data-action="pin"]'));
    await page.settle();
    expect(page.sent).toHaveLength(1);
  });
});

describe("editing a tag on the page", () => {
  it("Edit opens the panel and becomes Close; Close shuts it", () => {
    const page = load(() => ok(KITCHEN));
    const edit = page.inRow("kitchen", '[data-action="edit"]');
    page.click(edit);
    expect(edit.getAttribute("aria-expanded")).toBe("true");
    expect(edit.textContent).toBe("Close");
    expect(page.inRow("kitchen", ".tag-edit").hidden).toBe(false);
    page.click(edit);
    expect(edit.getAttribute("aria-expanded")).toBe("false");
    expect(edit.textContent).toBe("Edit");
    expect(page.inRow("kitchen", ".tag-edit").hidden).toBe(true);
  });

  it("confirming a guessed project drops the guess, and making it a topic hides its status", async () => {
    const page = load((sent) => {
      const kind = (sent.body as { kind: "topic" | "project" }).kind;
      return ok({
        ...KITCHEN,
        kind,
        kindSource: "stated",
        projectStatus: kind === "project" ? "active" : null,
      });
    });
    page.click(page.inRow("kitchen", '[data-kind="project"]'));
    await page.settle();
    expect(page.sent[0]).toEqual({
      url: "/tags/kind",
      body: { key: "kitchen", kind: "project" },
      redirect: "manual",
    });
    expect(page.inRow("kitchen", ".kind").textContent).toBe("Project");
    expect(page.inRow("kitchen", ".guess-note").hidden).toBe(true);
    expect(pressedOf(page.inRow("kitchen", '[data-kind="project"]'))).toBe("true");
    expect(page.inRow("kitchen", "fieldset.status").hidden).toBe(false);
    page.click(page.inRow("kitchen", '[data-kind="topic"]'));
    await page.settle();
    expect(page.inRow("kitchen", ".kind").textContent).toBe("Topic");
    expect(pressedOf(page.inRow("kitchen", '[data-kind="topic"]'))).toBe("true");
    expect(pressedOf(page.inRow("kitchen", '[data-kind="project"]'))).toBe("false");
    expect(page.inRow("kitchen", "fieldset.status").hidden).toBe(true);
  });

  it("marking a project done offers Undo, which reopens it", async () => {
    const page = load((sent) =>
      ok({ ...KITCHEN, projectStatus: (sent.body as { status: "active" | "done" }).status }),
    );
    page.click(page.inRow("kitchen", '[data-status="done"]'));
    await page.settle();
    expect(page.sent[0]).toEqual({
      url: "/tags/status",
      body: { key: "kitchen", status: "done" },
      redirect: "manual",
    });
    expect(pressedOf(page.inRow("kitchen", '[data-status="done"]'))).toBe("true");
    expect(page.$("#undo-bar span").textContent).toBe("Kitchen marked done.");
    page.click(page.$("#undo-bar button"));
    await page.settle();
    expect(page.sent[1]).toEqual({
      url: "/tags/status",
      body: { key: "kitchen", status: "active" },
      redirect: "manual",
    });
    expect(pressedOf(page.inRow("kitchen", '[data-status="active"]'))).toBe("true");
    expect(pressedOf(page.inRow("kitchen", '[data-status="done"]'))).toBe("false");
  });

  it("Done on a project already done sends nothing and offers no Undo that would reopen it", async () => {
    const done = { ...KITCHEN, kindSource: "stated" as const, projectStatus: "done" as const };
    const page = load(() => ok(done), [done]);
    page.click(page.inRow("kitchen", '[data-status="done"]'));
    await page.settle();
    expect(page.sent).toEqual([]);
    expect(page.$("#undo-bar").hidden).toBe(true);
  });

  it("reopening a done project offers no Undo", async () => {
    const done = { ...KITCHEN, kindSource: "stated" as const, projectStatus: "done" as const };
    const page = load(() => ok({ ...done, projectStatus: "active" }), [done]);
    expect(page.inRow("kitchen", ".kind").textContent).toBe("Project, done");
    page.click(page.inRow("kitchen", '[data-status="active"]'));
    await page.settle();
    expect(page.inRow("kitchen", ".kind").textContent).toBe("Project");
    expect(page.$("#undo-bar").hidden).toBe(true);
  });

  it("picking a color posts it and draws the returned color", async () => {
    const page = load(() => ok({ ...KITCHEN, color: "violet" }));
    page.click(page.inRow("kitchen", '[data-color="violet"]'));
    await page.settle();
    expect(page.sent[0]).toEqual({
      url: "/tags/color",
      body: { key: "kitchen", color: "violet" },
      redirect: "manual",
    });
    expect(page.inRow("kitchen", ".dot").className).toBe("dot space-violet");
    expect(pressedOf(page.inRow("kitchen", '[data-color="violet"]'))).toBe("true");
    expect(pressedOf(page.inRow("kitchen", '[data-color="clay"]'))).toBe("false");
  });

  it("names the other spaces that use a color, and says so when the tag shares its own", async () => {
    const page = load(() => ok({ ...HOME, color: "clay" }));
    expect(page.inRow("home", '[data-color="clay"]').getAttribute("aria-label")).toBe(
      "clay, also used by Kitchen",
    );
    expect(page.inRow("home", '[data-color="violet"]').getAttribute("aria-label")).toBe("violet");
    expect(page.inRow("baking", '[data-color="teal"]').getAttribute("aria-label")).toBe(
      "teal, also used by Home batteries",
    );
    expect(page.inRow("home", ".shared").hidden).toBe(true);
    page.click(page.inRow("home", '[data-color="clay"]'));
    await page.settle();
    expect(page.inRow("home", ".shared").hidden).toBe(false);
    expect(page.inRow("home", ".shared").textContent).toBe("Kitchen also uses this color.");
    expect(page.inRow("kitchen", ".shared").textContent).toBe(
      "Home batteries also uses this color.",
    );
  });

  it("shows a name from the server as text", async () => {
    const evil = tag({ key: "x", name: "<b>x</b>" });
    const page = load(
      () => ok({ ...evil, pinned: false, color: "teal" }),
      [evil, { ...HOME, name: "<i>h</i>" }],
    );
    expect(page.inRow("x", '[data-color="teal"]').getAttribute("aria-label")).toBe(
      "teal, also used by <i>h</i>",
    );
    expect(page.document.querySelector("li i")).toBeNull();
  });
});
