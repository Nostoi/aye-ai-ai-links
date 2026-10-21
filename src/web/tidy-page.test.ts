import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { TidyLink } from "../core/tidy-up.js";
import type { FocusEntry, Link, Source } from "../core/types.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { themeCss } from "./theme.js";
import { tidyPage } from "./tidy-page.js";

const NOW = new Date("2026-10-21T10:00:00Z");

let n = 0;
const link = (over: Partial<Link> = {}): Link => {
  n += 1;
  return {
    id: String(n),
    url: `https://example.com/${n}`,
    urlKey: `example.com/${n}`,
    title: `Title ${n}`,
    summary: null,
    why: { text: "to compare", source: "stated" },
    tags: [],
    savedAt: new Date("2026-03-12T10:00:00Z"),
    savedBy: "claude",
    lastOpenedAt: null,
    putAwayAt: null,
    tidyKeptAt: null,
    lastSurfacedAt: null,
    snoozedUntil: null,
    state: "active",
    snapshot: null,
    ...over,
  };
};
const focus = (text: string, source: Source): FocusEntry => ({
  id: "f",
  text,
  source,
  writtenBy: "agent",
  createdAt: NOW,
});
const queue = (count: number): TidyLink[] =>
  Array.from({ length: count }, () => ({ link: link(), fit: null }));

const render = (q: TidyLink[], hasFocus = true) =>
  tidyPage({ queue: q, hasFocus, images: new Map(), catalog: [], now: NOW });
const doc = (q: TidyLink[], hasFocus = true) => parseHTML(render(q, hasFocus)).document;
const first = (q: TidyLink[], hasFocus = true) =>
  doc(q, hasFocus).querySelector("section[data-id]") as Element;

describe("the Tidy up page", () => {
  it("shows the first of five links and hides the rest", () => {
    const q = queue(5);
    const sections = [...doc(q).querySelectorAll("section[data-id]")];
    expect(sections.map((s) => s.getAttribute("data-id"))).toEqual(q.map((t) => t.link.id));
    expect(sections.map((s) => s.hasAttribute("hidden"))).toEqual([false, true, true, true, true]);
  });

  it("marks each step 'Link N of M' for a screen reader, with one hidden dot per link", () => {
    const sections = [...doc(queue(5)).querySelectorAll("section[data-id]")];
    expect(render(queue(5))).toContain("Link 1 of 5");
    expect(sections[2]?.textContent).toContain("Link 3 of 5");
    const dots = sections[2]?.querySelector(".steps") as Element;
    expect(dots.getAttribute("aria-hidden")).toBe("true");
    expect(dots.querySelectorAll("b")).toHaveLength(5);
  });

  it("links Stop here to Home", () => {
    const stop = [...first(queue(2)).querySelectorAll("a")].find(
      (a) => a.textContent === "Stop here",
    );
    expect(stop?.getAttribute("href")).toBe("/");
  });

  it("shows the title, the why, and the picture box of the card", () => {
    const t = { link: link({ title: "Home batteries" }), fit: null };
    const section = first([t]);
    expect(section.textContent).toContain("Home batteries");
    expect(section.textContent).toContain("Why you saved it");
    expect(section.textContent).toContain('"to compare"');
    expect(section.querySelector("[data-pic]")).not.toBeNull();
  });

  it("marks an inferred why as a guess, and a stated one not", () => {
    const guessed = first([
      { link: link({ why: { text: "maybe", source: "inferred" } }), fit: null },
    ]);
    expect(guessed.textContent).toContain("Why (a guess): maybe");
    expect(first(queue(1)).textContent).not.toContain("(a guess)");
  });

  it("says when it was saved and that it was never opened", () => {
    expect(first(queue(1)).textContent).toContain(
      "Saved in March. You haven't opened it from here.",
    );
  });

  it("says the month of the latest opening, with the year only for another year", () => {
    const t = {
      link: link({
        savedAt: new Date("2024-03-12T10:00:00Z"),
        lastOpenedAt: new Date("2026-05-02T10:00:00Z"),
      }),
      fit: null,
    };
    expect(first([t]).textContent).toContain("Saved in March 2024. Last opened in May.");
  });

  it("opens the link in a new tab, as a recorded opening", () => {
    const a = [...first(queue(1)).querySelectorAll("a")].find(
      (x) => x.textContent === "Open it to check",
    ) as Element;
    expect(a.getAttribute("href")).toMatch(/^https:\/\/example\.com\//);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.hasAttribute("data-open")).toBe(true);
    expect(render(queue(1))).toContain('"/links/opened"');
  });

  it("offers the three choices in order, with their exact lines and the safe marker", () => {
    const buttons = [...first(queue(1)).querySelectorAll("button[data-act]")];
    expect(buttons.map((b) => b.getAttribute("data-act"))).toEqual(["keep", "put-away", "stale"]);
    expect(buttons.every((b) => b.getAttribute("type") === "button")).toBe(true);
    const [keep, away, stale] = buttons;
    expect(keep?.textContent).toContain("Keep");
    expect(keep?.textContent).toContain("Stays in your lists, as it is now.");
    expect(away?.textContent).toContain("Put it away");
    expect(away?.textContent).toContain(
      "Out of your lists. Comes back when you start something it fits.",
    );
    expect(away?.textContent).toContain("If you're not sure");
    expect(away?.className).toContain("safe");
    expect(stale?.textContent).toContain("It's stale");
    expect(stale?.textContent).toContain("Out of sight for good. Search still finds it.");
    expect(keep?.textContent).not.toContain("If you're not sure");
    expect(stale?.textContent).not.toContain("If you're not sure");
    expect(keep?.className).not.toContain("safe");
  });

  describe("the fit line", () => {
    const fits = (f: FocusEntry | null, hasFocus = true) =>
      first([{ link: link(), fit: f }], hasFocus).querySelector(".fit")?.textContent ?? null;

    it("says it might fit a stated or asked focus the owner is working on", () => {
      expect(fits(focus("Solar for the house", "stated"))).toBe(
        "Might fit Solar for the house, which you're working on.",
      );
      expect(fits(focus("Solar for the house", "asked"))).toBe(
        "Might fit Solar for the house, which you're working on.",
      );
    });

    it("marks an inferred focus as a guess", () => {
      expect(fits(focus("Solar for the house", "inferred"))).toBe(
        "Might fit Solar for the house, which you may be working on (a guess).",
      );
    });

    it("bolds the focus text and escapes it", () => {
      const html = first([{ link: link(), fit: focus("<i>x</i>", "stated") }]).innerHTML;
      expect(html).toContain("<b>&lt;i&gt;x&lt;/i&gt;</b>");
    });

    it("says it fits nothing when the owner has focus entries and none match", () => {
      expect(fits(null)).toBe("Doesn't fit anything you're working on now.");
    });

    it("shows no fit line, and no empty box, when there are no current entries", () => {
      expect(fits(null, false)).toBeNull();
    });

    it("still offers Put it away when there is no fit line", () => {
      expect(first(queue(1), false).querySelector("button[data-act=put-away]")).not.toBeNull();
    });
  });

  describe("the finish screen", () => {
    const done = (q: TidyLink[]) => doc(q).querySelector(".tidy-done") as Element;

    it("follows the last link, hidden, and says That's five. Done for now. for a full session", () => {
      const d = done(queue(5));
      expect(d.hasAttribute("hidden")).toBe(true);
      expect(d.querySelector("h2")?.textContent).toBe("That's five. Done for now.");
      expect(d.textContent).toContain(
        "Everything you put away is still saved and still searchable.",
      );
      const back = d.querySelector("a") as Element;
      expect(back.textContent).toBe("Back home");
      expect(back.getAttribute("href")).toBe("/");
    });

    it("says only Done for now. for a shorter session", () => {
      expect(done(queue(3)).querySelector("h2")?.textContent).toBe("Done for now.");
    });

    it("stands alone, shown, for an empty queue", () => {
      expect(doc([]).querySelectorAll("section[data-id]")).toHaveLength(0);
      expect(done([]).hasAttribute("hidden")).toBe(false);
      expect(done([]).querySelector("h2")?.textContent).toBe("Done for now.");
    });
  });

  it("leaves a link without a web address unlinked", () => {
    const t = { link: link({ url: "ftp://example.com/x" }), fit: null };
    expect(first([t]).querySelector("a[data-open]")).toBeNull();
  });

  it("uses no amber and makes no outside request", () => {
    const html = render(queue(5));
    for (const el of parseHTML(html).document.querySelectorAll("[class]")) {
      expect(el.className).not.toMatch(/amber|needs-you/);
    }
    expect(outsideRefs(html)).toEqual([]);
  });

  it("styles the Tidy up rules with theme tokens only, the controls at least 44px tall", () => {
    const rules = [...themeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
      sel: (sel ?? "").trim(),
      body: body ?? "",
    }));
    const tidy = rules.filter((r) => /\.tidy|\.steps|\.leave/.test(r.sel));
    expect(tidy.length).toBeGreaterThan(0);
    for (const r of tidy) {
      expect(r.body, r.sel).not.toMatch(/amber|#[0-9a-fA-F]{3,8}\b/);
    }
    expect(rules.find((r) => r.sel === ".tidy-choices button")?.body).toMatch(
      /min-height:\s*(?:[4-9]\d)px/,
    );
    expect(rules.find((r) => r.sel === ".leave")?.body).toMatch(/min-height:\s*44px/);
  });
});

const post = (url: string, body: unknown): Post => ({
  url,
  body,
  redirect: "manual",
  keepalive: undefined,
});
const PUT_CHANGE = {
  before: { state: "active", putAwayAt: null, snoozedUntil: null },
  after: { state: "archived", putAwayAt: "2026-10-21T10:00:00.000Z" },
};
const STALE_CHANGE = {
  before: { state: "active", putAwayAt: null, snoozedUntil: null },
  after: { state: "archived", putAwayAt: null },
};
/** The answers when nothing is wrong: Keep and Undo 204, the state actions their change. */
const fine = (s: Post): Answer =>
  s.url === "/home/put-away"
    ? { status: 200, body: PUT_CHANGE }
    : s.url === "/home/archive"
      ? { status: 200, body: STALE_CHANGE }
      : { status: 204 };

describe("the Tidy up session", () => {
  const load = (answer: (s: Post) => Answer = fine, count = 5) => {
    const q = queue(count);
    const p = runPage(render(q), answer);
    const ids = q.map((t) => t.link.id);
    const shown = () =>
      [...p.document.querySelectorAll("section[data-id]")]
        .filter((s) => !s.hasAttribute("hidden"))
        .map((s) => s.getAttribute("data-id"));
    const finished = () => !(p.$(".tidy-done") as Element).hasAttribute("hidden");
    const choose = async (act: string) => {
      p.dispatch(p.$(`section[data-id]:not([hidden]) button[data-act=${act}]`), "click");
      await p.settle();
    };
    const undo = async () => {
      p.dispatch(p.$("#undo-bar button"), "click");
      await p.settle();
    };
    const key = async (k: string, init: Record<string, unknown> = {}, target?: Element) => {
      p.dispatch(target ?? p.document.body, "keydown", { key: k, ...init });
      await p.settle();
    };
    return { p, ids, shown, finished, choose, undo, key };
  };
  const urls = (p: ReturnType<typeof runPage>) => p.sent.map((s) => s.url);

  it.each([
    ["keep", "/tidy/keep"],
    ["put-away", "/home/put-away"],
    ["stale", "/home/archive"],
  ])("%s posts once to %s with the link's id and shows the next link", async (act, url) => {
    const { p, ids, shown, choose } = load();
    await choose(act);
    expect(p.sent).toEqual([post(url, { id: ids[0] })]);
    expect(shown()).toEqual([ids[1]]);
  });

  it("Keep offers no Undo bar", async () => {
    const { p, choose } = load();
    await choose("keep");
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("Put it away and It's stale offer their bars, title first", async () => {
    const { p, choose } = load();
    await choose("put-away");
    expect(p.$("#undo-bar span").textContent).toBe(
      "Put away. Out of your lists but still saved. If you start something it fits, it'll come back.",
    );
    expect(p.$("#undo-bar strong").textContent).toBe("Put away.");
    await choose("stale");
    expect(p.$("#undo-bar span").textContent).toBe(
      "Let go. You won't see it again unless you search for it.",
    );
  });

  it("Undo posts undo-state with the change it received and shows that link again", async () => {
    const { p, ids, shown, choose, undo } = load();
    await choose("put-away");
    await undo();
    expect(p.sent[1]).toEqual(post("/home/undo-state", { id: ids[0], change: PUT_CHANGE }));
    expect(shown()).toEqual([ids[0]]);
  });

  it("an undone link can be decided again, differently, without a reload", async () => {
    const { p, ids, shown, choose, undo } = load();
    await choose("put-away");
    await undo();
    await choose("stale");
    expect(urls(p)).toEqual(["/home/put-away", "/home/undo-state", "/home/archive"]);
    expect(p.sent[2]).toEqual(post("/home/archive", { id: ids[0] }));
    expect(shown()).toEqual([ids[1]]);
    await undo();
    expect(p.sent[3]).toEqual(post("/home/undo-state", { id: ids[0], change: STALE_CHANGE }));
  });

  it("after an Undo the session continues with the first undecided link, never one decided later", async () => {
    const { p, ids, shown, choose, undo } = load();
    await choose("put-away");
    await choose("keep");
    await undo();
    expect(shown()).toEqual([ids[0]]);
    await choose("keep");
    expect(shown()).toEqual([ids[2]]);
    const kept = p.sent.filter((s) => s.url === "/tidy/keep").map((s) => s.body);
    expect(kept).toEqual([{ id: ids[1] }, { id: ids[0] }]);
  });

  it("shows the finish screen after the fifth, and an Undo there brings the link back", async () => {
    const { ids, shown, finished, choose, undo } = load();
    for (let i = 0; i < 4; i++) await choose("keep");
    expect(finished()).toBe(false);
    await choose("stale");
    expect(finished()).toBe(true);
    expect(shown()).toEqual([]);
    await undo();
    expect(shown()).toEqual([ids[4]]);
    expect(finished()).toBe(false);
    await choose("keep");
    expect(finished()).toBe(true);
  });

  it("an Undo while a choice on the next link is in flight sends nothing", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const { p, ids, shown, choose, undo } = load((s) =>
      s.url === "/home/archive" ? { ...fine(s), wait } : fine(s),
    );
    await choose("put-away");
    p.dispatch(p.$("section[data-id]:not([hidden]) button[data-act=stale]"), "click");
    await undo();
    expect(urls(p)).toEqual(["/home/put-away", "/home/archive"]);
    release();
    await p.settle();
    expect(urls(p)).toEqual(["/home/put-away", "/home/archive"]);
    expect(shown()).toEqual([ids[2]]);
  });

  it("sends one request for a double click", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const { p, ids, shown } = load((s) => ({ ...fine(s), wait }));
    const button = p.$("section[data-id]:not([hidden]) button[data-act=keep]");
    p.dispatch(button, "click");
    p.dispatch(button, "click");
    release();
    await p.settle();
    expect(p.sent).toEqual([post("/tidy/keep", { id: ids[0] })]);
    expect(shown()).toEqual([ids[1]]);
  });

  it("a 409 shows the refusal's message, does not advance and offers no Undo", async () => {
    const { p, ids, shown, choose } = load(() => ({
      status: 409,
      body: { code: "conflict", message: "That link changed. Reload the page." },
    }));
    for (const act of ["keep", "put-away", "stale"]) {
      await choose(act);
      expect(p.$("#tidy-error").textContent).toBe("That link changed. Reload the page.");
      expect(shown()).toEqual([ids[0]]);
    }
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("a request that fails says to reload, and does not advance", async () => {
    const { p, ids, shown, choose } = load(() => ({ status: 200, networkFails: true }));
    await choose("put-away");
    expect(p.$("#tidy-error").textContent).toBe(
      "That did not work. Reload the page and try again.",
    );
    expect(shown()).toEqual([ids[0]]);
  });

  it("a later success clears the message", async () => {
    let refuse = true;
    const { p, choose } = load((s) =>
      refuse ? { status: 409, body: { code: "conflict", message: "Nope." } } : fine(s),
    );
    await choose("keep");
    expect(p.$("#tidy-error").textContent).toBe("Nope.");
    refuse = false;
    await choose("keep");
    expect(p.$("#tidy-error").textContent).toBe("");
  });

  it("a refused Undo shows the message and leaves the view as it is", async () => {
    const { p, ids, shown, choose, undo } = load((s) =>
      s.url === "/home/undo-state"
        ? { status: 409, body: { code: "conflict", message: "Changed since." } }
        : fine(s),
    );
    await choose("put-away");
    await undo();
    expect(p.$("#tidy-error").textContent).toBe("Changed since.");
    expect(shown()).toEqual([ids[1]]);
  });

  describe("the keys", () => {
    it.each([
      ["1", "/tidy/keep"],
      ["2", "/home/put-away"],
      ["3", "/home/archive"],
    ])("key %s posts %s for the shown link", async (k, url) => {
      const { p, ids, key } = load();
      await key(k);
      expect(p.sent).toEqual([post(url, { id: ids[0] })]);
    });

    it("act on the link currently shown, after an Undo too", async () => {
      const { p, ids, choose, undo, key } = load();
      await choose("put-away");
      await undo();
      await key("1");
      expect(p.sent.at(-1)).toEqual(post("/tidy/keep", { id: ids[0] }));
    });

    it.each(["1", "2", "3"])("an auto-repeated key %s picks nothing", async (k) => {
      const { p, ids, shown, key } = load();
      await key(k, { repeat: true });
      expect(p.sent).toEqual([]);
      expect(shown()).toEqual([ids[0]]);
    });

    it("are ignored in a field, with a modifier held, and on the finish screen", async () => {
      const { p, finished, choose, key } = load(fine, 1);
      for (const tag of ["input", "textarea", "select"]) {
        const field = p.document.createElement(tag);
        p.$("main").append(field);
        await key("2", {}, field);
      }
      const editable = p.document.createElement("div");
      Object.defineProperty(editable, "isContentEditable", { value: true });
      p.$("main").append(editable);
      await key("2", {}, editable);
      await key("2", { ctrlKey: true });
      await key("2", { metaKey: true });
      await key("2", { altKey: true });
      await key("x");
      expect(p.sent).toEqual([]);
      await choose("keep");
      expect(finished()).toBe(true);
      await key("2");
      expect(p.sent).toHaveLength(1);
    });
  });

  it("moves focus to the new link's title, and to the finish heading", async () => {
    const { p, ids, choose } = load(fine, 2);
    await choose("keep");
    const title = p.$(`section[data-id='${ids[1]}'] .tidy-title`);
    expect(p.focused().at(-1)).toBe(title);
    expect(title.getAttribute("tabindex")).toBe("-1");
    await choose("keep");
    expect(p.focused().at(-1)).toBe(p.$(".tidy-done h2"));
  });

  it("hints each choice's key, off the screen reader's path, and hides the hints on a phone", () => {
    const keys = [...first(queue(1)).querySelectorAll("button[data-act] .key")];
    expect(keys.map((k) => k.textContent)).toEqual(["1", "2", "3"]);
    expect(keys.every((k) => k.getAttribute("aria-hidden") === "true")).toBe(true);
    const phone = themeCss.match(/@media \(max-width:600px\)\{(.*)\}/g) ?? [];
    expect(phone.some((m) => m.includes(".tidy-choices .key{display:none}"))).toBe(true);
  });
});
