import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { TagMergeSuggestion } from "../core/tag-suggest.js";
import type { Tag } from "../core/types.js";
import { PAGE_STYLE } from "./page.js";
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

const LINKS: Record<string, number> = { kitchen: 5, baking: 1, home: 2 };
const entry = (t: Tag) => ({ tag: t, links: LINKS[t.key] ?? 0 });
const render = (tags: Tag[], suggestions: TagMergeSuggestion[] = []) =>
  tagsPage({ tags: tags.map(entry), suggestions });

type Answer = { status: number; type?: string; body?: unknown };
type Sent = { url: string; body: unknown; redirect: unknown };
const REDIRECT: Answer = { status: 0, type: "opaqueredirect" };
/** The server's answer to a tag action: the tag after the change. */
const ok = (t: Tag): Answer => ({ status: 200, body: { tag: t } });

/** The page in linkedom with its own script and the Undo bar's run against it, timers stubbed. */
function load(
  answer: (sent: Sent) => Answer | Promise<Answer>,
  tags: Tag[] = [KITCHEN, BAKING, HOME],
  hash = "",
  suggestions: TagMergeSuggestion[] = [],
) {
  const html = render(tags, suggestions);
  const { document, window } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => !s.includes("sign-out"))
    .join("\n");
  const sent: Sent[] = [];
  const fetch = async (url: string, init: { body: string; redirect?: string }) => {
    const request = { url, body: JSON.parse(init.body), redirect: init.redirect };
    sent.push(request);
    const a = await answer(request);
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
  const scrolled: Element[] = [];
  for (const el of document.querySelectorAll("li[data-key]")) {
    (el as HTMLElement).scrollIntoView = () => {
      scrolled.push(el);
    };
  }
  const reloads: number[] = [];
  new Function("document", "fetch", "setTimeout", "clearTimeout", "location", code)(
    document,
    fetch,
    () => 0,
    () => {},
    { hash, reload: () => void reloads.push(1) },
  );
  const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
  const row = (key: string) => $(`li[data-key="${key}"]`);
  const inRow = (key: string, selector: string) => row(key).querySelector(selector) as HTMLElement;
  const click = (el: HTMLElement) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const type = (el: HTMLElement, text: string, event = "input") => {
    (el as HTMLInputElement).value = text;
    el.dispatchEvent(Object.assign(new window.Event(event, { bubbles: true }), { key: "Enter" }));
  };
  return {
    $,
    row,
    inRow,
    click,
    type,
    settle,
    sent,
    document,
    window,
    reloads,
    scrolled,
    focused: () => focused,
  };
}

describe("the Tags page when the Ask AI panel changes a tag", () => {
  const changed = (t: ReturnType<typeof load>) =>
    t.document.dispatchEvent(new t.window.CustomEvent("aye-tags-changed"));

  it("reloads, so the rows show the tags as they now are", () => {
    const t = load(() => ({ status: 500 }));
    expect(t.reloads).toEqual([]);
    changed(t);
    expect(t.reloads).toHaveLength(1);
  });

  it("reloads a page with no tags too, since an Undo can bring one back", () => {
    const t = load(() => ({ status: 500 }), []);
    changed(t);
    expect(t.reloads).toHaveLength(1);
  });
});

const pressedOf = (el: HTMLElement) => el.getAttribute("aria-pressed");

describe("the Tags page as served", () => {
  const html = render([KITCHEN, BAKING, HOME]);
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
      render([
        tag({ key: "t", kindSource: "inferred" }),
        tag({ key: "p", kind: "project", kindSource: "asked" }),
      ]),
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
      render([tag({ key: "p", kind: "project", projectStatus: "done" }), BAKING]),
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

  it("shows an unpinned tag's kept color, since this page edits it", () => {
    const kept = tag({ key: "kept", color: "violet" });
    const page = parseHTML(render([kept])).document;
    expect(page.querySelector('li[data-key="kept"] .dot')?.className).toBe("dot space-violet");
    expect(
      page.querySelector('li[data-key="kept"] [data-color="violet"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
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
    const served = render([tag({ key: evil, name: evil })]);
    expect(served).not.toContain("<img src=x");
    expect(served).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(parseHTML(served).document.querySelector("li")?.getAttribute("data-key")).toBe(evil);
  });

  it("says so when there are no tags", () => {
    expect(render([])).toContain("No tags yet.");
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

  it("unpinning keeps showing the kept color and offers Undo, which pins it again with it", async () => {
    const page = load((sent) =>
      ok({ ...KITCHEN, pinned: (sent.body as { pinned: boolean }).pinned }),
    );
    page.click(page.inRow("kitchen", '[data-action="pin"]'));
    await page.settle();
    expect(page.inRow("kitchen", '[data-action="pin"]').textContent).toBe("Pin to home");
    expect(page.inRow("kitchen", ".dot").className).toBe("dot space-clay");
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
  it("opens the panel of the tag a #tag= address names, as a space page's Change link sends it", () => {
    const odd = tag({ key: "c++ & ü/x#y", name: "C++ & ü" });
    const hash = `#tag=${encodeURIComponent(odd.key)}`;
    const page = load(() => ok(odd), [KITCHEN, odd], hash);
    expect(page.inRow(odd.key, ".tag-edit").hidden).toBe(false);
    expect(page.inRow(odd.key, '[data-action="edit"]').textContent).toBe("Close");
    expect(page.inRow("kitchen", ".tag-edit").hidden).toBe(true);
    expect(page.scrolled).toEqual([page.row(odd.key)]);
  });

  it.each(["#tag=nope", "", "#other=kitchen", "#tag="])(
    "opens nothing for the address %j",
    (hash) => {
      const page = load(() => ok(KITCHEN), undefined, hash);
      expect(page.document.querySelectorAll(".tag-edit:not([hidden])")).toHaveLength(0);
      expect(page.scrolled).toEqual([]);
    },
  );

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

type Page = ReturnType<typeof load>;
const ids = (page: Page) =>
  [...page.document.querySelectorAll("li[data-key]")].map((r) => r.getAttribute("data-key"));
const tagged = (page: Page, key: string, name: string) => {
  const panel = page.inRow(key, ".tag-edit");
  return [...panel.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLElement;
};
/** An answer held until `release()`, so a request can be left out while others are tried. */
const gate = (a: Answer) => {
  let release = () => {};
  const held = new Promise<Answer>((resolve) => {
    release = () => resolve(a);
  });
  return { held, release };
};
const MERGED: Answer = { status: 200, body: { tag: HOME, changeId: "c1", moved: 1, links: 3 } };
const BACK: Answer = {
  status: 200,
  body: {
    tags: [
      { tag: BAKING, links: 1 },
      { tag: HOME, links: 2 },
    ],
  },
};
const picks = (page: Page, key: string) =>
  [...page.inRow(key, ".picker").querySelectorAll("button[data-pick]")] as HTMLElement[];
const mergeBakingIntoHome = async (page: Page) => {
  page.click(tagged(page, "baking", "Merge into another tag…"));
  page.click(picks(page, "baking")[1] as HTMLElement);
  page.click(tagged(page, "baking", "Merge into Home batteries"));
  await page.settle();
};

describe("the Tags page's counts and controls as served", () => {
  const html = render([KITCHEN, BAKING, HOME]);
  const { document } = parseHTML(html);
  const row = (key: string) => document.querySelector(`li[data-key="${key}"]`) as HTMLElement;

  it("shows each tag's link count after its kind", () => {
    expect(row("kitchen").querySelector(".count")?.textContent).toBe("· 5 links");
    expect(row("baking").querySelector(".count")?.textContent).toBe("· 1 link");
    expect(row("kitchen").querySelector(".kind")?.textContent).toBe("Project? (a guess)");
  });

  it("puts Name and Rename first in the Edit panel, and Merge and Delete after Color", () => {
    const panel = row("baking").querySelector(".tag-edit")?.innerHTML ?? "";
    const at = (s: string) => panel.indexOf(s);
    const field = row("baking").querySelector('.tag-edit input[name="name"]');
    expect(field?.getAttribute("value")).toBe("Baking");
    expect(at('name="name"')).toBeGreaterThan(-1);
    expect(at('name="name"')).toBeLessThan(at("Rename"));
    expect(at("Rename")).toBeLessThan(at("<legend>Kind"));
    expect(at("<legend>Color")).toBeLessThan(at("Merge into another tag…"));
    expect(at("Merge into another tag…")).toBeLessThan(at("Delete tag"));
  });

  it("makes every control at least 44px tall, with the field outlined in --field", () => {
    expect(PAGE_STYLE).toMatch(/\.tag button\{[^}]*min-height:44px/);
    expect(PAGE_STYLE).toMatch(/\.tag input\{[^}]*min-height:44px/);
    expect(PAGE_STYLE).toMatch(/\.tag input\{[^}]*border:1\.5px solid var\(--field\)/);
  });

  it("asks nothing before a removal: no confirmation call in the page", () => {
    expect(html).not.toContain("confirm(");
  });
});

describe("renaming a tag", () => {
  it("posts the key and the typed name, then the row takes the returned tag", async () => {
    const renamed = { ...BAKING, key: "bread", name: "Bread" };
    const page = load(() => ok(renamed));
    page.type(page.inRow("baking", 'input[name="name"]'), "Bread");
    page.click(tagged(page, "baking", "Rename"));
    await page.settle();
    expect(page.sent).toEqual([
      { url: "/tags/rename", body: { key: "baking", name: "Bread" }, redirect: "manual" },
    ]);
    expect(ids(page)).toEqual(["kitchen", "bread", "home"]);
    expect(page.inRow("bread", ".tag-name").textContent).toBe("Bread");
    expect(page.inRow("bread", ".tag-name").getAttribute("href")).toBe("/spaces?tag=bread");
    expect(page.inRow("bread", ".count").textContent).toBe("· 1 link");
    expect((page.inRow("bread", 'input[name="name"]') as HTMLInputElement).value).toBe("Bread");
    expect(page.$("#undo-bar").hidden).toBe(true);
    page.click(page.inRow("bread", '[data-action="pin"]'));
    await page.settle();
    expect(page.sent[1]?.body).toEqual({ key: "bread", pinned: true });
  });

  it("renames in place when only capitals change: the key stays", async () => {
    const page = load(() => ok({ ...BAKING, name: "BAKING" }));
    page.type(page.inRow("baking", 'input[name="name"]'), "BAKING");
    page.click(tagged(page, "baking", "Rename"));
    await page.settle();
    expect(ids(page)).toEqual(["kitchen", "baking", "home"]);
    expect(page.inRow("baking", ".tag-name").textContent).toBe("BAKING");
  });

  it("renames on Enter in the Name field", async () => {
    const page = load(() => ok({ ...BAKING, key: "bread", name: "Bread" }));
    const field = page.inRow("baking", 'input[name="name"]');
    page.type(field, "Bread", "keydown");
    await page.settle();
    expect(page.sent).toHaveLength(1);
  });

  it("shows a refusal's message and leaves the row as it was", async () => {
    const page = load(() => ({ status: 400, body: { message: "Type a new name for the tag." } }));
    page.click(tagged(page, "baking", "Rename"));
    await page.settle();
    expect(page.$("#tags-error").textContent).toBe("Type a new name for the tag.");
    expect(ids(page)).toEqual(["kitchen", "baking", "home"]);
  });

  const taken: Answer = {
    status: 409,
    body: { code: "taken", tag: HOME, links: 5, message: "You already have it." },
  };

  it("offers a merge when the name is another tag's, and Keep closes it with nothing sent", async () => {
    const page = load(() => taken);
    page.type(page.inRow("baking", 'input[name="name"]'), "Home batteries");
    page.click(tagged(page, "baking", "Rename"));
    await page.settle();
    const box = page.inRow("baking", ".taken");
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain(
      "You already have a tag called Home batteries (5 links). Merge Baking into it?",
    );
    expect(tagged(page, "baking", "Merge into Home batteries").className).toContain("primary");
    expect(page.$("#tags-error").textContent).toBe("");
    page.click(tagged(page, "baking", "Keep Baking"));
    await page.settle();
    expect(box.hidden).toBe(true);
    expect(page.sent).toHaveLength(1);
    expect((page.inRow("baking", 'input[name="name"]') as HTMLInputElement).value).toBe("Baking");
    expect(ids(page)).toEqual(["kitchen", "baking", "home"]);
  });

  it("merges into the tag it named when the offer is taken", async () => {
    const page = load((sent) => (sent.url === "/tags/rename" ? taken : MERGED));
    page.click(tagged(page, "baking", "Rename"));
    await page.settle();
    page.click(tagged(page, "baking", "Merge into Home batteries"));
    await page.settle();
    expect(page.sent[1]).toEqual({
      url: "/tags/merge",
      body: { key: "baking", into: "home" },
      redirect: "manual",
    });
    expect(ids(page)).toEqual(["kitchen", "home"]);
  });
});

describe("merging a tag", () => {
  it("lists the other tags with their counts, filters them, and enables Merge only after a pick", () => {
    const page = load(() => MERGED);
    page.click(tagged(page, "baking", "Merge into another tag…"));
    const panel = page.inRow("baking", ".merge");
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain("Merge Baking into…");
    expect(panel.textContent).toContain(
      "Its 1 link moves to the tag you pick, and Baking goes away.",
    );
    expect(picks(page, "baking").map((b) => b.textContent)).toEqual([
      "Kitchen5 links",
      "Home batteries2 links",
    ]);
    const go = tagged(page, "baking", "Merge into…") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    page.type(page.inRow("baking", '.merge input[name="filter"]'), "home");
    expect(picks(page, "baking").map((b) => b.hidden)).toEqual([true, false]);
    page.click(picks(page, "baking")[1] as HTMLElement);
    expect(go.disabled).toBe(false);
    expect(go.textContent).toBe("Merge into Home batteries");
    expect(go.className).toContain("primary");
    expect(page.sent).toEqual([]);
  });

  it("sends nothing from Merge before a pick, and Cancel closes the picker and clears the pick", () => {
    const page = load(() => MERGED);
    page.click(tagged(page, "baking", "Merge into another tag…"));
    page.click(tagged(page, "baking", "Merge into…"));
    page.click(picks(page, "baking")[1] as HTMLElement);
    page.click(tagged(page, "baking", "Cancel"));
    expect(page.inRow("baking", ".merge").hidden).toBe(true);
    page.click(tagged(page, "baking", "Merge into another tag…"));
    expect((tagged(page, "baking", "Merge into…") as HTMLButtonElement).disabled).toBe(true);
    expect(page.sent).toEqual([]);
  });

  it("removes the row, draws the kept row with the new count, and offers Undo", async () => {
    const page = load(() => MERGED);
    await mergeBakingIntoHome(page);
    expect(page.sent).toEqual([
      { url: "/tags/merge", body: { key: "baking", into: "home" }, redirect: "manual" },
    ]);
    expect(ids(page)).toEqual(["kitchen", "home"]);
    expect(page.inRow("home", ".count").textContent).toBe("· 3 links");
    expect(page.$("#undo-bar").hidden).toBe(false);
    expect(page.$("#undo-bar span").textContent).toBe(
      "Merged Baking into Home batteries (1 link).",
    );
  });

  it("Undo puts the removed row back where it was and draws both rows from the answer", async () => {
    const back = {
      tags: [
        { tag: { ...BAKING, pinned: true, color: "violet" }, links: 1 },
        { tag: HOME, links: 2 },
      ],
    };
    const page = load((sent) => (sent.url === "/tags/undo" ? { status: 200, body: back } : MERGED));
    await mergeBakingIntoHome(page);
    page.click(page.$("#undo-bar button"));
    await page.settle();
    expect(page.sent[1]).toEqual({
      url: "/tags/undo",
      body: { changeId: "c1" },
      redirect: "manual",
    });
    expect(ids(page)).toEqual(["kitchen", "baking", "home"]);
    expect(pressedOf(page.inRow("baking", '[data-action="pin"]'))).toBe("true");
    expect(page.inRow("baking", ".dot").className).toBe("dot space-violet");
    expect(page.inRow("home", ".count").textContent).toBe("· 2 links");
    expect(page.inRow("baking", ".merge").hidden).toBe(true);
    expect(page.$("#undo-bar").hidden).toBe(true);
  });

  it("shows the server's words when Undo is refused, and the row stays merged away", async () => {
    const refused = { message: "The tags changed since, so nothing was undone." };
    const page = load((sent) =>
      sent.url === "/tags/undo" ? { status: 409, body: refused } : MERGED,
    );
    await mergeBakingIntoHome(page);
    page.click(page.$("#undo-bar button"));
    await page.settle();
    expect(page.$("#tags-error").textContent).toBe(refused.message);
    expect(ids(page)).toEqual(["kitchen", "home"]);
  });

  it("changes nothing and offers no Undo when the merge is refused", async () => {
    const page = load(() => ({
      status: 404,
      body: { message: "That tag is not there any more." },
    }));
    await mergeBakingIntoHome(page);
    expect(ids(page)).toEqual(["kitchen", "baking", "home"]);
    expect(page.$("#undo-bar").hidden).toBe(true);
    expect(page.$("#tags-error").textContent).toBe("That tag is not there any more.");
  });
});

describe("deleting a tag", () => {
  const gone = (moved: number): Answer => ({ status: 200, body: { changeId: "d1", moved } });

  it.each([
    [1, "Deleted Baking from 1 link."],
    [4, "Deleted Baking from 4 links."],
  ])(
    "removes the row at once and says how many links lost the tag (%i)",
    async (moved, message) => {
      const page = load(() => gone(moved));
      page.click(tagged(page, "baking", "Delete tag"));
      await page.settle();
      expect(page.sent).toEqual([
        { url: "/tags/delete", body: { key: "baking" }, redirect: "manual" },
      ]);
      expect(ids(page)).toEqual(["kitchen", "home"]);
      expect(page.$("#undo-bar span").textContent).toBe(message);
    },
  );

  it("Undo brings the row back in its place, drawn from the answer", async () => {
    const back = { tags: [{ tag: { ...BAKING, color: "teal" }, links: 1 }] };
    const page = load((sent) =>
      sent.url === "/tags/undo" ? { status: 200, body: back } : gone(1),
    );
    page.click(tagged(page, "baking", "Delete tag"));
    await page.settle();
    page.click(page.$("#undo-bar button"));
    await page.settle();
    expect(page.sent[1]?.body).toEqual({ changeId: "d1" });
    expect(ids(page)).toEqual(["kitchen", "baking", "home"]);
    expect(page.inRow("baking", ".dot").className).toBe("dot space-teal");
  });

  it("keeps the row and offers no Undo when the delete is refused", async () => {
    const page = load(() => ({
      status: 404,
      body: { message: "That tag is not there any more." },
    }));
    page.click(tagged(page, "baking", "Delete tag"));
    await page.settle();
    expect(ids(page)).toEqual(["kitchen", "baking", "home"]);
    expect(page.$("#undo-bar").hidden).toBe(true);
  });
});

describe("one action at a time on a row", () => {
  it("sends nothing from a row while its pin is out, so a late pin cannot overwrite a color", async () => {
    const g = gate(ok({ ...BAKING, pinned: true, color: "violet" }));
    const page = load(() => g.held);
    page.click(page.inRow("baking", '[data-action="pin"]'));
    page.click(page.inRow("baking", '[data-color="teal"]'));
    page.click(page.inRow("baking", '[data-kind="project"]'));
    page.click(tagged(page, "baking", "Rename"));
    page.click(tagged(page, "baking", "Delete tag"));
    await page.settle();
    expect(page.sent).toHaveLength(1);
    g.release();
    await page.settle();
    page.click(page.inRow("baking", '[data-color="teal"]'));
    await page.settle();
    expect(page.sent).toHaveLength(2);
  });

  it("leaves another row free", async () => {
    const g = gate(ok({ ...BAKING, pinned: true, color: "violet" }));
    const page = load((s) => ((s.body as { key: string }).key === "baking" ? g.held : ok(HOME)));
    page.click(page.inRow("baking", '[data-action="pin"]'));
    page.click(page.inRow("home", '[data-color="teal"]'));
    await page.settle();
    expect(page.sent).toHaveLength(2);
    g.release();
  });

  it("holds both rows while a merge is out", async () => {
    const g = gate(MERGED);
    const page = load(() => g.held);
    await mergeBakingIntoHome(page);
    page.click(page.inRow("home", '[data-action="pin"]'));
    page.click(tagged(page, "home", "Delete tag"));
    await page.settle();
    expect(page.sent).toHaveLength(1);
    g.release();
    await page.settle();
    page.click(page.inRow("home", '[data-action="pin"]'));
    await page.settle();
    expect(page.sent).toHaveLength(2);
  });

  it("holds both rows while a merge's Undo is out", async () => {
    const g = gate(BACK);
    const page = load((sent) => (sent.url === "/tags/undo" ? g.held : MERGED));
    await mergeBakingIntoHome(page);
    page.click(page.$("#undo-bar button"));
    await page.settle();
    page.click(page.inRow("home", '[data-action="pin"]'));
    await page.settle();
    expect(page.sent.map((s) => s.url)).toEqual(["/tags/merge", "/tags/undo"]);
    g.release();
    await page.settle();
    expect(page.$("#undo-bar").hidden).toBe(true);
    page.click(page.inRow("baking", '[data-action="pin"]'));
    await page.settle();
    expect(page.sent).toHaveLength(3);
  });

  it("an Undo clicked while its row is busy waits, then runs", async () => {
    const g = gate(ok({ ...HOME, pinned: false }));
    const page = load((sent) => {
      if (sent.url === "/tags/pin") return g.held;
      return sent.url === "/tags/undo" ? BACK : MERGED;
    });
    await mergeBakingIntoHome(page);
    page.click(page.inRow("home", '[data-action="pin"]'));
    page.click(page.$("#undo-bar button"));
    await page.settle();
    expect(page.sent.map((s) => s.url)).toEqual(["/tags/merge", "/tags/pin"]);
    g.release();
    await page.settle();
    expect(page.sent.map((s) => s.url)).toEqual(["/tags/merge", "/tags/pin", "/tags/undo"]);
    expect(ids(page)).toEqual(["kitchen", "baking", "home"]);
  });
});

describe("pickers, offers and color notes follow the other rows", () => {
  const POWER = { ...HOME, key: "power", name: "Power" };
  const renameHome = async (page: Page) => {
    page.type(page.inRow("home", 'input[name="name"]'), "Power");
    page.click(tagged(page, "home", "Rename"));
    await page.settle();
  };
  const TAKEN: Answer = {
    status: 409,
    body: { code: "taken", tag: HOME, links: 2, message: "You already have it." },
  };
  const DELETED: Answer = { status: 200, body: { changeId: "d1", moved: 2 } };
  const names = (page: Page, key: string) => picks(page, key).map((b) => b.textContent);

  it("a renamed tag in an open picker keeps its pick and is the one merged into", async () => {
    const page = load((sent) => (sent.url === "/tags/rename" ? ok(POWER) : MERGED));
    page.click(tagged(page, "baking", "Merge into another tag…"));
    page.click(picks(page, "baking")[1] as HTMLElement);
    await renameHome(page);
    expect(names(page, "baking")).toEqual(["Kitchen5 links", "Power2 links"]);
    expect(page.inRow("baking", '[data-action="merge-go"]').textContent).toBe("Merge into Power");
    page.click(tagged(page, "baking", "Merge into Power"));
    await page.settle();
    expect(page.sent[1]).toEqual({
      url: "/tags/merge",
      body: { key: "baking", into: "power" },
      redirect: "manual",
    });
  });

  it("a deleted tag leaves the open picker and its pick is cleared", async () => {
    const page = load(() => DELETED);
    page.click(tagged(page, "baking", "Merge into another tag…"));
    page.click(picks(page, "baking")[1] as HTMLElement);
    page.click(tagged(page, "home", "Delete tag"));
    await page.settle();
    expect(names(page, "baking")).toEqual(["Kitchen5 links"]);
    const go = page.inRow("baking", '[data-action="merge-go"]') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(go.textContent).toBe("Merge into…");
  });

  it("a picker follows a merge into it, and a restored tag comes back", async () => {
    const page = load((s) => (s.url === "/tags/undo" ? BACK : MERGED));
    page.click(tagged(page, "kitchen", "Merge into another tag…"));
    page.click(tagged(page, "baking", "Merge into another tag…"));
    page.click(picks(page, "baking")[1] as HTMLElement);
    page.click(tagged(page, "baking", "Merge into Home batteries"));
    await page.settle();
    expect(names(page, "kitchen")).toEqual(["Home batteries3 links"]);
    page.click(page.$("#undo-bar button"));
    await page.settle();
    expect(names(page, "kitchen")).toEqual(["Baking1 link", "Home batteries2 links"]);
  });

  it("the heading and the count in an open panel follow its own tag's rename", async () => {
    const page = load(() => ok({ ...BAKING, key: "bread", name: "Bread" }));
    page.click(tagged(page, "baking", "Merge into another tag…"));
    page.type(page.inRow("baking", 'input[name="name"]'), "Bread");
    page.click(tagged(page, "baking", "Rename"));
    await page.settle();
    const panel = page.inRow("bread", ".merge");
    expect(panel.textContent).toContain("Merge Bread into…");
    expect(panel.textContent).toContain("and Bread goes away.");
    expect(panel.textContent).not.toContain("Baking");
  });

  it("a taken offer follows a rename of the tag it names", async () => {
    const page = load((s) => {
      if (s.url !== "/tags/rename") return MERGED;
      return (s.body as { key: string }).key === "baking" ? TAKEN : ok(POWER);
    });
    page.click(tagged(page, "baking", "Rename"));
    await page.settle();
    await renameHome(page);
    expect(page.inRow("baking", ".taken p").textContent).toBe(
      "You already have a tag called Power (2 links). Merge Baking into it?",
    );
    page.click(tagged(page, "baking", "Merge into Power"));
    await page.settle();
    expect(page.sent[2]).toEqual({
      url: "/tags/merge",
      body: { key: "baking", into: "power" },
      redirect: "manual",
    });
  });

  it("a taken offer whose tag is deleted says so, and its merge says so rather than doing nothing", async () => {
    const page = load((s) => (s.url === "/tags/rename" ? TAKEN : DELETED));
    page.click(tagged(page, "baking", "Rename"));
    await page.settle();
    page.click(tagged(page, "home", "Delete tag"));
    await page.settle();
    expect(page.inRow("baking", ".taken p").textContent).toContain("not there any more");
    page.click(page.inRow("baking", '[data-action="merge-taken"]'));
    await page.settle();
    expect(page.$("#tags-error").textContent).toBe("That tag is not there any more.");
    expect(page.sent.map((s) => s.url)).toEqual(["/tags/rename", "/tags/delete"]);
  });

  it("a taken name whose tag has no row on the page offers a reload, worded from the server's answer", async () => {
    const NEW = { ...HOME, key: "pixel-art", name: "pixel art" };
    const page = load(() => ({
      status: 409,
      body: { code: "taken", tag: NEW, links: 1, message: "You already have it." },
    }));
    page.click(tagged(page, "baking", "Rename"));
    await page.settle();
    const box = page.inRow("baking", ".taken");
    expect(box.hidden).toBe(false);
    expect(box.querySelector("p")?.textContent).toBe(
      "You already have a tag called pixel art (1 link). Reload this page to merge Baking into it.",
    );
    expect(box.textContent).not.toContain("not there any more");
    expect((page.inRow("baking", '[data-action="merge-taken"]') as HTMLElement).hidden).toBe(true);
  });

  it("Delete takes the deleted tag out of the other tags' shared-color notes", async () => {
    const PANTRY = tag({ key: "pantry", name: "Pantry", color: "clay", pinned: true });
    const page = load(() => DELETED, [KITCHEN, PANTRY]);
    expect(page.inRow("kitchen", ".shared").textContent).toBe("Pantry also uses this color.");
    page.click(tagged(page, "pantry", "Delete tag"));
    await page.settle();
    expect(page.inRow("kitchen", ".shared").hidden).toBe(true);
    expect(page.inRow("kitchen", ".shared").textContent).toBe("");
    expect(page.inRow("kitchen", '[data-color="clay"]').getAttribute("aria-label")).toBe("clay");
  });
});

describe("suggested merges on the Tags page", () => {
  const GARDEN = tag({ key: "garden", name: "Garden" });
  const POND = tag({ key: "pond", name: "Pond" });
  LINKS.garden = 3;
  LINKS.pond = 1;
  const TAGS = [KITCHEN, BAKING, HOME, GARDEN, POND];
  const pair = (a: Tag, b: Tag): TagMergeSuggestion => ({ a: entry(a), b: entry(b) });
  const KB = pair(KITCHEN, BAKING);
  const HB = pair(HOME, BAKING);
  const GP = pair(GARDEN, POND);
  const SUGGESTIONS = [KB, GP, HB];
  const NO_CONTENT: Answer = { status: 204 };
  const open = (answer: (sent: Sent) => Answer | Promise<Answer>, suggestions = SUGGESTIONS) =>
    load(answer, TAGS, "", suggestions);
  const item = (page: Page, keys: string) => {
    const [a, b] = keys.split("|");
    return page.$(`#suggest li[data-a="${a}"][data-b="${b}"]`);
  };
  const shown = (page: Page) =>
    [...page.document.querySelectorAll("#suggest li.suggestion")].map(
      (li) => `${li.getAttribute("data-a")}|${li.getAttribute("data-b")}`,
    );
  const button = (page: Page, keys: string, name: string) =>
    [...item(page, keys).querySelectorAll("button")].find(
      (b) => b.textContent === name,
    ) as HTMLElement;
  const merged = (kept: Tag, moved = 1): Answer => ({
    status: 200,
    body: { tag: kept, changeId: "c1", moved, links: 6 },
  });
  const ALL = ["kitchen|baking", "garden|pond", "home|baking"];

  describe("as served", () => {
    it("shows nothing without suggestions", () => {
      const page = load(() => NO_CONTENT, TAGS);
      expect(page.document.getElementById("suggest")).toBeNull();
      expect(page.document.body.innerHTML).not.toContain("Tags you might combine");
    });

    it("puts the section above the list, naming both tags with their counts and three buttons", () => {
      const page = open(() => NO_CONTENT);
      const section = page.$("#suggest");
      expect(section.querySelector("h2")?.textContent).toBe("Tags you might combine");
      expect(page.document.documentElement.outerHTML.indexOf('id="suggest"')).toBeLessThan(
        page.document.documentElement.outerHTML.indexOf('id="tags"'),
      );
      expect(shown(page)).toEqual(ALL);
      const first = item(page, "kitchen|baking");
      expect(first.querySelector(".pair")?.textContent).toBe(
        "Kitchen · 5 links and Baking · 1 link",
      );
      expect([...first.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
        "Keep Kitchen",
        "Keep Baking",
        "Not these",
      ]);
    });

    it("escapes hostile names", () => {
      const evil = tag({ key: "x", name: "<img src=x onerror=alert(1)>" });
      const page = load(() => NO_CONTENT, [evil, BAKING], "", [pair(evil, BAKING)]);
      expect(page.document.querySelector("#suggest img")).toBeNull();
      expect(page.$("#suggest .pair").textContent).toContain("<img src=x onerror=alert(1)>");
    });

    it("sizes its buttons to at least 44px and uses no amber", () => {
      expect(PAGE_STYLE).toContain(".suggestion button{min-height:44px");
      expect(PAGE_STYLE.match(/\.suggest[^{]*\{[^}]*\}/g)?.join("")).not.toContain("amber");
    });
  });

  describe("Keep", () => {
    it("merges the other tag into the one kept, offers Undo, and drops every suggestion naming either", async () => {
      const page = open(() => merged(KITCHEN));
      page.click(button(page, "kitchen|baking", "Keep Kitchen"));
      await page.settle();
      expect(page.sent).toEqual([
        { url: "/tags/merge", body: { key: "baking", into: "kitchen" }, redirect: "manual" },
      ]);
      expect(ids(page)).toEqual(["kitchen", "home", "garden", "pond"]);
      expect(page.$("#undo-bar span").textContent).toBe("Merged Baking into Kitchen (1 link).");
      expect(shown(page)).toEqual(["garden|pond"]);
      expect(page.$("#suggest").hidden).toBe(false);
    });

    it("Keep on the second tag merges the first into it", async () => {
      const page = open(() => merged(BAKING));
      page.click(button(page, "kitchen|baking", "Keep Baking"));
      await page.settle();
      expect(page.sent[0]?.body).toEqual({ key: "kitchen", into: "baking" });
    });

    it("hides the section once its last suggestion has gone", async () => {
      const page = open(() => merged(GARDEN), [GP]);
      page.click(button(page, "garden|pond", "Keep Garden"));
      await page.settle();
      expect(shown(page)).toEqual([]);
      expect(page.$("#suggest").hidden).toBe(true);
    });

    it("Undo puts the rows back but not the suggestions", async () => {
      const back = {
        tags: [
          { tag: BAKING, links: 1 },
          { tag: KITCHEN, links: 5 },
        ],
      };
      const page = open((sent) =>
        sent.url === "/tags/undo" ? { status: 200, body: back } : merged(KITCHEN),
      );
      page.click(button(page, "kitchen|baking", "Keep Kitchen"));
      await page.settle();
      page.click(page.$("#undo-bar button"));
      await page.settle();
      expect(ids(page)).toEqual(["kitchen", "baking", "home", "garden", "pond"]);
      expect(shown(page)).toEqual(["garden|pond"]);
    });

    it("keeps the suggestion and says why when the merge is refused", async () => {
      const page = open(() => ({
        status: 404,
        body: { message: "That tag is not there any more." },
      }));
      page.click(button(page, "kitchen|baking", "Keep Kitchen"));
      await page.settle();
      expect(shown(page)).toEqual(ALL);
      expect(page.$("#tags-error").textContent).toBe("That tag is not there any more.");
      expect(page.$("#undo-bar").hidden).toBe(true);
    });

    it("sends nothing while one of its rows has a request out", async () => {
      const g = gate({ status: 200, body: { tag: BAKING } });
      const page = open(() => g.held);
      page.click(page.inRow("baking", '[data-action="pin"]'));
      page.click(button(page, "kitchen|baking", "Keep Kitchen"));
      await page.settle();
      expect(page.sent).toHaveLength(1);
      g.release();
    });
  });

  describe("Not these", () => {
    it("posts the pair, removes only that suggestion, and offers an Undo that says so", async () => {
      const page = open(() => NO_CONTENT);
      page.click(button(page, "kitchen|baking", "Not these"));
      await page.settle();
      expect(page.sent).toEqual([
        {
          url: "/tags/suggestions/dismiss",
          body: { a: "kitchen", b: "baking" },
          redirect: "manual",
        },
      ]);
      expect(shown(page)).toEqual(["garden|pond", "home|baking"]);
      expect(ids(page)).toEqual(["kitchen", "baking", "home", "garden", "pond"]);
      expect(page.$("#undo-bar").hidden).toBe(false);
      expect(page.$("#undo-bar span").textContent).toBe("Won't suggest Kitchen and Baking again.");
    });

    it("Undo posts the undismissal and puts the suggestion back in its place", async () => {
      const page = open(() => NO_CONTENT);
      page.click(button(page, "garden|pond", "Not these"));
      await page.settle();
      page.click(page.$("#undo-bar button"));
      await page.settle();
      expect(page.sent[1]).toEqual({
        url: "/tags/suggestions/undismiss",
        body: { a: "garden", b: "pond" },
        redirect: "manual",
      });
      expect(shown(page)).toEqual(ALL);
      expect(page.$("#undo-bar").hidden).toBe(true);
    });

    it("Undo shows the section again after its last suggestion was dismissed", async () => {
      const page = open(() => NO_CONTENT, [GP]);
      page.click(button(page, "garden|pond", "Not these"));
      await page.settle();
      expect(page.$("#suggest").hidden).toBe(true);
      page.click(page.$("#undo-bar button"));
      await page.settle();
      expect(page.$("#suggest").hidden).toBe(false);
      expect(shown(page)).toEqual(["garden|pond"]);
    });

    it("keeps the suggestion, shows the error and offers no Undo when the dismissal is refused", async () => {
      const page = open(() => ({ status: 400, body: { message: "No." } }));
      page.click(button(page, "kitchen|baking", "Not these"));
      await page.settle();
      expect(shown(page)).toEqual(ALL);
      expect(page.$("#tags-error").textContent).toBe("No.");
      expect(page.$("#undo-bar").hidden).toBe(true);
    });

    it("does not bring the suggestion back when its Undo is refused, and says so", async () => {
      const page = open((sent) =>
        sent.url.endsWith("/undismiss") ? { status: 400, body: { message: "No." } } : NO_CONTENT,
      );
      page.click(button(page, "garden|pond", "Not these"));
      await page.settle();
      page.click(page.$("#undo-bar button"));
      await page.settle();
      expect(shown(page)).toEqual(["kitchen|baking", "home|baking"]);
      expect(page.$("#tags-error").textContent).toBe("No.");
    });
  });

  describe("a change from the Edit panel", () => {
    it("a merge drops the suggestions naming the tag merged away or the tag merged into", async () => {
      const page = open(() => MERGED);
      await mergeBakingIntoHome(page);
      expect(shown(page)).toEqual(["garden|pond"]);
    });

    it("a merge into a tag drops the suggestions that name it, though it stays on the page", async () => {
      const page = open(() => merged(GARDEN));
      page.click(tagged(page, "pond", "Merge into another tag…"));
      page.click(picks(page, "pond").find((b) => b.dataset.pick === "garden") as HTMLElement);
      page.click(tagged(page, "pond", "Merge into Garden"));
      await page.settle();
      expect(shown(page)).toEqual(["kitchen|baking", "home|baking"]);
    });

    it("a delete drops the suggestions naming the tag", async () => {
      const page = open(() => ({ status: 200, body: { changeId: "d1", moved: 1 } }));
      page.click(tagged(page, "baking", "Delete tag"));
      await page.settle();
      expect(shown(page)).toEqual(["garden|pond"]);
    });

    it("a rename to a new key drops the suggestions naming the old one", async () => {
      const page = open(() => ok({ ...BAKING, key: "bread", name: "Bread" }));
      page.type(page.inRow("baking", 'input[name="name"]'), "Bread");
      page.click(tagged(page, "baking", "Rename"));
      await page.settle();
      expect(shown(page)).toEqual(["garden|pond"]);
    });

    it("a rename that keeps the key drops them too, since their wording is stale", async () => {
      const page = open(() => ok({ ...BAKING, name: "BAKING" }));
      page.type(page.inRow("baking", 'input[name="name"]'), "BAKING");
      page.click(tagged(page, "baking", "Rename"));
      await page.settle();
      expect(shown(page)).toEqual(["garden|pond"]);
    });

    it("a pin leaves the suggestions alone", async () => {
      const page = open(() => ok({ ...BAKING, pinned: true, color: "teal" }));
      page.click(page.inRow("baking", '[data-action="pin"]'));
      await page.settle();
      expect(shown(page)).toEqual(ALL);
    });
  });
});
