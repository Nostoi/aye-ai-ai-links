import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { CopyInfo } from "../core/saved-copy.js";
import type { TidyLink } from "../core/tidy-up.js";
import type { FocusEntry, Link, Source } from "../core/types.js";
import { homePage } from "./home-page.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { spacesSection } from "./spaces-section.js";
import { themeCss } from "./theme.js";

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
    summarySource: null,
    why: { text: "to compare", source: "stated" },
    tags: [],
    savedAt: new Date("2026-03-12T10:00:00Z"),
    savedBy: "claude",
    lastOpenedAt: null,
    intent: "explore",
    intentSource: null,
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
  Array.from({ length: count }, () => ({ link: link(), gone: false, fit: null }));

const NO_WORTH = { links: [], images: new Map(), now: NOW, catalog: [] };
const render = (
  q: TidyLink[],
  hasFocus = true,
  spaces = spacesSection([]),
  copies = new Map<string, CopyInfo>(),
) =>
  homePage({
    worth: NO_WORTH,
    shelf: "",
    spaces,
    tidy: { queue: q, hasFocus, images: new Map(), catalog: [], now: NOW, copies },
  });
const doc = (q: TidyLink[], hasFocus = true, copies = new Map<string, CopyInfo>()) =>
  parseHTML(render(q, hasFocus, spacesSection([]), copies)).document;
const first = (q: TidyLink[], hasFocus = true, copies = new Map<string, CopyInfo>()) =>
  doc(q, hasFocus, copies).querySelector(".tidy-step") as Element;

describe("Home's Tidy up tray", () => {
  it("is a slim tray with the Tidy spine and a hidden heading, closed, with its two lines and a Start button", () => {
    const d = doc(queue(5));
    const tray = d.querySelector("section.tidy-tray") as Element;
    expect(tray.getAttribute("aria-labelledby")).toBe("tidy-title");
    expect(tray.querySelector(".spine .spine-word")?.textContent).toBe("Tidy");
    const heading = tray.querySelector("h2#tidy-title") as Element;
    expect(heading.textContent).toBe("Tidy up");
    expect(heading.className).toBe("visually-hidden");
    const closed = tray.querySelector(".tidy-closed") as Element;
    expect(closed.hasAttribute("hidden")).toBe(false);
    expect(closed.textContent).toContain("Clear out a few links?");
    expect(closed.textContent).toContain("One at a time. Nothing gets deleted.");
    const start = closed.querySelector("button[data-tidy=start]") as Element;
    expect(start.textContent).toBe("Start");
    expect(start.getAttribute("type")).toBe("button");
    expect(start.className).not.toContain("primary");
    expect(render(queue(5))).not.toContain('href="/tidy"');
  });

  it("renders every step hidden, and the finish screen hidden", () => {
    const d = doc(queue(5));
    const steps = [...d.querySelectorAll(".tidy-step")];
    expect(steps).toHaveLength(5);
    expect(steps.every((s) => s.hasAttribute("hidden"))).toBe(true);
    expect((d.querySelector(".tidy-done") as Element).hasAttribute("hidden")).toBe(true);
  });

  it("holds one step per link, in order, each as the card that names its link", () => {
    const q = queue(5);
    const steps = [...doc(q).querySelectorAll(".tidy-step")];
    expect(steps.map((s) => s.getAttribute("data-id"))).toEqual(q.map((t) => t.link.id));
  });

  it("says 'N of M' and draws one hidden dot per link, in each step's bar", () => {
    const steps = [...doc(queue(5)).querySelectorAll(".tidy-step")];
    expect(steps[0]?.querySelector(".count")?.textContent).toBe("1 of 5");
    expect(steps[2]?.querySelector(".count")?.textContent).toBe("3 of 5");
    const dots = steps[2]?.querySelector(".steps") as Element;
    expect(dots.getAttribute("aria-hidden")).toBe("true");
    expect(dots.querySelectorAll("b")).toHaveLength(5);
    expect(dots.querySelector(".now")).toBe(dots.querySelectorAll("b")[2]);
  });

  it("offers Stop here as a button in each step, never a link", () => {
    const stop = first(queue(2)).querySelector("button[data-tidy=stop]") as Element;
    expect(stop.textContent).toBe("Stop here");
    expect(stop.getAttribute("type")).toBe("button");
    expect(first(queue(2)).querySelector('a[href="/"]')).toBeNull();
  });

  it("shows the title as a heading, the why, and the picture box of the card", () => {
    const t = { link: link({ title: "Home batteries" }), gone: false, fit: null };
    const section = first([t]);
    const title = section.querySelector("h3.tidy-title") as Element;
    expect(title.textContent).toBe("Home batteries");
    expect(title.hasAttribute("data-card-title")).toBe(true);
    expect(section.textContent).toContain("Why you saved it");
    expect(section.textContent).toContain("to compare");
    expect(section.querySelector("[data-pic]")).not.toBeNull();
  });

  describe("the why", () => {
    const why = (w: Link["why"]) => first([{ link: link({ why: w }), gone: false, fit: null }]);

    it("labels an inferred why as a guess in the label, and drops the prefix from the text", () => {
      const s = why({ text: "maybe", source: "inferred" });
      expect(s.querySelector(".tidy-why small")?.textContent).toBe("Why you saved it (a guess)");
      expect(s.querySelector(".tidy-why")?.textContent).toBe("Why you saved it (a guess)maybe");
      expect(s.textContent).not.toContain("Why (a guess)");
    });

    it("labels a stated or asked why plainly", () => {
      for (const source of ["stated", "asked"] as const) {
        const s = why({ text: "to compare", source });
        expect(s.querySelector(".tidy-why small")?.textContent).toBe("Why you saved it");
        expect(s.textContent).not.toContain("(a guess)");
      }
    });

    it("escapes the text, and says so when there is no why", () => {
      expect(why({ text: "<b>x</b>", source: "stated" }).innerHTML).toContain(
        "&lt;b&gt;x&lt;/b&gt;",
      );
      expect(why(null).querySelector(".tidy-why")?.textContent).toBe(
        "Why you saved it" + "No why yet",
      );
    });
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
      gone: false,
      fit: null,
    };
    expect(first([t]).textContent).toContain("Saved in March 2024. Last opened in May.");
  });

  it("opens the link in a new tab from a pill button, as a recorded opening", () => {
    const a = first(queue(1)).querySelector("a.button") as Element;
    expect(a.textContent).toBe("Open it to check");
    expect(a.className).not.toContain("primary");
    expect(a.getAttribute("href")).toMatch(/^https:\/\/example\.com\//);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.hasAttribute("data-open")).toBe(true);
    expect(render(queue(1))).toContain('document.getElementById("tidy")');
    expect(render(queue(1))).toContain('"/links/opened"');
  });

  it("offers Keep, Skip and Archive on an explore step, in that order, with their lines and keys 1 to 3", () => {
    const buttons = [...first(queue(1)).querySelectorAll("button[data-act]")];
    expect(buttons.map((b) => b.getAttribute("data-act"))).toEqual(["keep", "skip", "archive"]);
    expect(buttons.every((b) => b.getAttribute("type") === "button")).toBe(true);
    const [keep, skip, archive] = buttons;
    expect(keep?.textContent).toContain("Keep");
    expect(keep?.textContent).toContain("Moves to To keep. Not asked again.");
    expect(skip?.textContent).toContain("Skip");
    expect(skip?.textContent).toContain("Back in two weeks.");
    expect(archive?.textContent).toContain("Archive");
    expect(archive?.textContent).toContain("Out of your lists. Still found by search.");
    expect(buttons.map((b) => b.getAttribute("aria-keyshortcuts"))).toEqual(["1", "2", "3"]);
    for (const b of buttons) {
      expect(b.textContent).not.toContain("If you're not sure");
      expect(b.className).not.toContain("safe");
    }
  });

  describe("a gone step", () => {
    const goneStep = () => first([{ link: link(), gone: true, fit: focus("solar", "stated") }]);

    it("says the page seems gone in place of the fit line, and offers It still works and Archive with keys 1 and 2", () => {
      const step = goneStep();
      expect(step.textContent).toContain("This page seems gone.");
      expect(step.querySelector(".fit")).toBeNull();
      const buttons = [...step.querySelectorAll("button[data-act]")];
      expect(buttons.map((b) => b.getAttribute("data-act"))).toEqual(["works", "archive"]);
      expect(buttons[0]?.textContent).toContain("It still works");
      expect(buttons[0]?.textContent).toContain("Clears the warning.");
      expect(buttons[1]?.textContent).toContain("Out of your lists. Still found by search.");
      expect(buttons.map((b) => b.getAttribute("aria-keyshortcuts"))).toEqual(["1", "2"]);
    });

    it("links Read the saved copy to the copy page, before the choices, when the link has a copy", () => {
      const l = link();
      const step = first(
        [{ link: l, gone: true, fit: null }],
        true,
        new Map([[l.id, { madeAt: NOW }]]),
      );
      const a = step.querySelector("a[data-act=read-copy]");
      expect(a?.textContent).toBe("Read the saved copy");
      expect(a?.getAttribute("href")).toBe(`/links/${l.id}/copy?from=%2F`);
      const order = [...step.querySelectorAll("a, button")];
      const works = step.querySelector("button[data-act=works]");
      expect(a && order.includes(a)).toBe(true);
      expect(order.indexOf(a as Element)).toBeLessThan(order.indexOf(works as Element));
    });

    it("shows no such link on a gone step without a copy, nor on an explore step with one", () => {
      expect(goneStep().querySelector("a[data-act=read-copy]")).toBeNull();
      const l = link();
      const copies = new Map([[l.id, { madeAt: NOW }]]);
      const explore = first([{ link: l, gone: false, fit: null }], true, copies);
      expect(explore.querySelector("a[data-act=read-copy]")).toBeNull();
    });

    it("offers no Keep, and an explore step says nothing about a gone page", () => {
      expect(goneStep().querySelector("button[data-act=keep], button[data-act=skip]")).toBeNull();
      expect(first(queue(1)).textContent).not.toContain("seems gone");
    });
  });

  describe("the fit line", () => {
    const fits = (f: FocusEntry | null, hasFocus = true) =>
      first([{ link: link(), gone: false, fit: f }], hasFocus).querySelector(".fit")?.textContent ??
      null;

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
      const html = first([
        { link: link(), gone: false, fit: focus("<i>x</i>", "stated") },
      ]).innerHTML;
      expect(html).toContain("<b>&lt;i&gt;x&lt;/i&gt;</b>");
    });

    it("says it fits nothing when the owner has focus entries and none match", () => {
      expect(fits(null)).toBe("Doesn't fit anything you're working on now.");
    });

    it("shows no fit line, and no empty box, when there are no current entries", () => {
      expect(fits(null, false)).toBeNull();
    });

    it("still offers Archive when there is no fit line", () => {
      expect(first(queue(1), false).querySelector("button[data-act=archive]")).not.toBeNull();
    });
  });

  describe("the finish screen", () => {
    const done = (q: TidyLink[]) => doc(q).querySelector(".tidy-done") as Element;

    it("follows the last link, hidden, says Done for now., and offers Close", () => {
      const d = done(queue(5));
      expect(d.hasAttribute("hidden")).toBe(true);
      expect(d.querySelector("h3")?.textContent).toBe("Done for now.");
      expect(d.textContent).toContain(
        "Everything you archive is still saved and still searchable.",
      );
      const close = d.querySelector("button[data-tidy=close]") as Element;
      expect(close.textContent).toBe("Close");
      expect(d.textContent).not.toContain("Back home");
      expect(d.querySelector("a")).toBeNull();
    });

    it("says the same for a shorter session: no counts", () => {
      expect(done(queue(3)).querySelector("h3")?.textContent).toBe("Done for now.");
      expect(done(queue(3)).textContent).not.toMatch(/five|\b3\b/i);
    });
  });

  it("leaves a link without a web address unlinked", () => {
    const t = { link: link({ url: "ftp://example.com/x" }), gone: false, fit: null };
    expect(first([t]).querySelector("a[data-open]")).toBeNull();
  });

  it("uses no amber and makes no outside request", () => {
    const html = render(queue(5));
    const tray = parseHTML(html).document.querySelector(".tidy-tray") as Element;
    for (const el of tray.querySelectorAll("[class]")) {
      expect(el.className).not.toMatch(/amber|needs-you/);
    }
    expect(outsideRefs(html)).toEqual([]);
  });
});

describe("the Tidy up tray's styles", () => {
  const rules = [...themeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
    sel: (sel ?? "").trim(),
    body: body ?? "",
  }));
  const body = (sel: string) => rules.find((r) => r.sel === sel)?.body ?? "";

  it("uses theme tokens only, the controls at least 44px tall", () => {
    const tidy = rules.filter((r) => /\.tidy|\.steps|\.leave/.test(r.sel));
    expect(tidy.length).toBeGreaterThan(0);
    for (const r of tidy) {
      expect(r.body, r.sel).not.toMatch(/amber|#[0-9a-fA-F]{3,8}\b/);
    }
    expect(body(".tidy-choices button")).toMatch(/min-height:\s*(?:[4-9]\d|\d{3})px/);
    expect(body(".leave")).toMatch(/min-height:\s*44px/);
    expect(body(".tidy-closed button")).toMatch(/min-height:\s*44px/);
    expect(body(".tidy-facts .gone-copy")).toMatch(/min-height:\s*44px/);
    expect(body(".tidy-facts .gone-copy")).toMatch(/margin:-12px 0 0 6px/);
  });

  it("draws the card on the card tokens", () => {
    const card = body(".tidy");
    expect(card).toContain("border-radius:var(--radius-card-large)");
    expect(card).toContain("box-shadow:var(--shadow-card),var(--card-ring)");
    expect(card).toMatch(/padding:var\(--space-\d\)/);
  });

  it("does not underline the title until it is hovered", () => {
    expect(body(".tidy-title a")).toContain("text-decoration:none");
    expect(body(".tidy-title a:hover")).toContain("text-decoration:underline");
  });

  it("sets the choices in a row on a wide screen and stacks them on a phone", () => {
    expect(body(".tidy-choices")).toContain("display:flex");
    expect(body(".tidy-choices")).not.toContain("flex-direction:column");
    const phone = (themeCss.match(/@media \(max-width:600px\)\{.*\}/g) ?? []).join("\n");
    expect(phone).toContain(".tidy-choices{flex-direction:column}");
    expect(phone).toContain(".tidy-choices .key{display:none}");
  });
});

const post = (url: string, body: unknown): Post => ({
  url,
  body,
  redirect: "manual",
  keepalive: undefined,
});
const ARCHIVE_CHANGE = {
  before: { state: "active", snoozedUntil: null },
  after: { state: "archived" },
};
const KEEP_CHANGE = {
  before: { intent: "explore", intentSource: null },
  after: { intent: "keep", intentSource: "stated" },
};
const SNOOZE = { until: "2026-11-04T10:00:00.000Z", previous: "2099-01-01T00:00:00.000Z" };
const STILL_WORKS = { check: { result: "ok" }, previous: { result: "dead" } };
/** The answers when nothing is wrong: each choice its answer, Undo 204. */
const fine = (s: Post): Answer =>
  s.url === "/home/archive"
    ? { status: 200, body: ARCHIVE_CHANGE }
    : s.url === "/home/keep"
      ? { status: 200, body: KEEP_CHANGE }
      : s.url === "/home/snooze"
        ? { status: 200, body: SNOOZE }
        : s.url === "/links/still-works"
          ? { status: 200, body: STILL_WORKS }
          : { status: 204 };

describe("the Tidy up session", () => {
  const load = (
    answer: (s: Post) => Answer = fine,
    count = 5,
    spaces = spacesSection([]),
    q: TidyLink[] = queue(count),
  ) => {
    const p = runPage(render(q, true, spaces), answer);
    const ids = q.map((t) => t.link.id);
    const shown = () =>
      [...p.document.querySelectorAll(".tidy-step")]
        .filter((s) => !s.hasAttribute("hidden"))
        .map((s) => s.getAttribute("data-id"));
    const hidden = (selector: string) => (p.$(selector) as Element).hasAttribute("hidden");
    const finished = () => !hidden(".tidy-done");
    const closed = () => !hidden(".tidy-closed");
    const gone = () => hidden("#tidy");
    const click = async (selector: string) => {
      p.dispatch(p.$(selector), "click");
      await p.settle();
    };
    const start = () => click("button[data-tidy=start]");
    const stop = () => click(".tidy-step:not([hidden]) button[data-tidy=stop]");
    const close = () => click("button[data-tidy=close]");
    const choose = (act: string) => click(`.tidy-step:not([hidden]) button[data-act=${act}]`);
    const undo = () => click("#undo-bar button");
    const key = async (k: string, init: Record<string, unknown> = {}, target?: Element) => {
      p.dispatch(target ?? p.document.body, "keydown", { key: k, ...init });
      await p.settle();
    };
    return { p, ids, shown, finished, closed, gone, start, stop, close, choose, undo, key };
  };
  const urls = (p: ReturnType<typeof runPage>) => p.sent.map((s) => s.url);

  describe("opening and closing", () => {
    it("starts closed, showing no step, and Start shows the first and focuses its title", async () => {
      const { p, ids, shown, closed, start } = load();
      expect(shown()).toEqual([]);
      expect(closed()).toBe(true);
      await start();
      expect(shown()).toEqual([ids[0]]);
      expect(closed()).toBe(false);
      const title = p.$(`.tidy-step[data-id='${ids[0]}'] .tidy-title`);
      expect(p.focused().at(-1)).toBe(title);
      expect(title.getAttribute("tabindex")).toBe("-1");
      expect(p.sent).toEqual([]);
    });

    it("Stop here closes the tray, keeping what was decided, and Start resumes at the first undecided link", async () => {
      const { p, ids, shown, closed, start, stop, choose } = load();
      await start();
      await choose("keep");
      await stop();
      expect(shown()).toEqual([]);
      expect(closed()).toBe(true);
      expect(p.focused().at(-1)).toBe(p.$("button[data-tidy=start]"));
      await start();
      expect(shown()).toEqual([ids[1]]);
    });

    it("a choice answered after Stop here is decided but shows nothing, and Start then skips it", async () => {
      let release: () => void = () => {};
      const wait = new Promise<void>((r) => {
        release = r;
      });
      const { p, ids, shown, closed, start, stop, choose } = load((s) =>
        s.url === "/home/keep" ? { status: 200, body: KEEP_CHANGE, wait } : fine(s),
      );
      await start();
      await choose("keep");
      await stop();
      release();
      await p.settle();
      expect(shown()).toEqual([]);
      expect(closed()).toBe(true);
      await start();
      expect(shown()).toEqual([ids[1]]);
    });

    it("an Undo after Stop here brings the link back undecided and leaves the tray closed", async () => {
      const { p, ids, shown, closed, start, stop, choose, undo } = load();
      await start();
      await choose("archive");
      await stop();
      await undo();
      expect(p.sent[1]).toEqual(post("/home/undo-state", { id: ids[0], change: ARCHIVE_CHANGE }));
      expect(shown()).toEqual([]);
      expect(closed()).toBe(true);
      await start();
      expect(shown()).toEqual([ids[0]]);
    });

    it("Close hides the tray and moves focus to Your spaces", async () => {
      const { p, finished, gone, start, choose, close } = load(fine, 1);
      await start();
      await choose("keep");
      expect(finished()).toBe(true);
      await close();
      expect(gone()).toBe(true);
      const heading = p.$("#spaces");
      expect(p.focused().at(-1)).toBe(heading);
      expect(heading.getAttribute("tabindex")).toBe("-1");
    });

    it("Close moves focus to the search field when there are no spaces", async () => {
      const { p, gone, start, choose, close } = load(fine, 1, "");
      await start();
      await choose("keep");
      await close();
      expect(gone()).toBe(true);
      expect(p.focused().at(-1)).toBe(p.$("#q"));
    });

    it("an Undo after Close brings the link back and returns the tray to closed, never open", async () => {
      const { p, ids, shown, finished, closed, gone, start, close, choose, undo } = load(fine, 1);
      await start();
      await choose("archive");
      await close();
      expect(gone()).toBe(true);
      await undo();
      expect(gone()).toBe(false);
      expect(closed()).toBe(true);
      expect(finished()).toBe(false);
      expect(shown()).toEqual([]);
      expect(p.sent[1]).toEqual(post("/home/undo-state", { id: ids[0], change: ARCHIVE_CHANGE }));
      await start();
      expect(shown()).toEqual([ids[0]]);
    });

    it("Start with every link already decided shows the finish screen", async () => {
      let release: () => void = () => {};
      const wait = new Promise<void>((r) => {
        release = r;
      });
      const { p, finished, start, stop, choose } = load(
        (s) => (s.url === "/home/keep" ? { status: 200, body: KEEP_CHANGE, wait } : fine(s)),
        1,
      );
      await start();
      await choose("keep");
      await stop();
      release();
      await p.settle();
      await start();
      expect(finished()).toBe(true);
    });
  });

  it.each([
    ["keep", "/home/keep"],
    ["archive", "/home/archive"],
  ])("%s posts once to %s with the link's id and shows the next link", async (act, url) => {
    const { p, ids, shown, start, choose } = load();
    await start();
    await choose(act);
    expect(p.sent).toEqual([post(url, { id: ids[0] })]);
    expect(shown()).toEqual([ids[1]]);
  });

  it("Keep offers its bar, and its Undo posts the change to /home/undo-intent", async () => {
    const { p, ids, shown, start, choose, undo } = load();
    await start();
    await choose("keep");
    expect(p.$("#undo-bar").hidden).toBe(false);
    expect(p.$("#undo-bar span").textContent).toBe("Kept. Marked To keep. Explore won't show it.");
    await undo();
    expect(p.sent[1]).toEqual(post("/home/undo-intent", { id: ids[0], change: KEEP_CHANGE }));
    expect(shown()).toEqual([ids[0]]);
  });

  it("Skip posts /home/snooze, offers its bar, and its Undo posts /home/unsnooze with the until it got", async () => {
    const { p, ids, shown, start, choose, undo } = load();
    await start();
    await choose("skip");
    expect(p.sent).toEqual([post("/home/snooze", { id: ids[0] })]);
    expect(p.$("#undo-bar strong").textContent).toBe("Skipped.");
    expect(p.$("#undo-bar span").textContent).toBe("Skipped. Back in two weeks.");
    expect(shown()).toEqual([ids[1]]);
    await undo();
    expect(p.sent[1]).toEqual(post("/home/unsnooze", { id: ids[0], ...SNOOZE }));
    expect(shown()).toEqual([ids[0]]);
  });

  it("Archive offers its bar, title first", async () => {
    const { p, start, choose } = load();
    await start();
    await choose("archive");
    expect(p.$("#undo-bar span").textContent).toBe(
      "Archived. Off Home, All links and your spaces. Still findable in search.",
    );
    expect(p.$("#undo-bar strong").textContent).toBe("Archived.");
  });

  it("Undo posts undo-state with the change it received and shows that link again", async () => {
    const { p, ids, shown, start, choose, undo } = load();
    await start();
    await choose("archive");
    await undo();
    expect(p.sent[1]).toEqual(post("/home/undo-state", { id: ids[0], change: ARCHIVE_CHANGE }));
    expect(shown()).toEqual([ids[0]]);
  });

  it("an undone link can be decided again, differently, without a reload", async () => {
    const { p, ids, shown, start, choose, undo } = load();
    await start();
    await choose("archive");
    await undo();
    await choose("keep");
    expect(urls(p)).toEqual(["/home/archive", "/home/undo-state", "/home/keep"]);
    expect(p.sent[2]).toEqual(post("/home/keep", { id: ids[0] }));
    expect(shown()).toEqual([ids[1]]);
  });

  it("after an Undo the session continues with the first undecided link, never one decided later", async () => {
    const { p, ids, shown, start, choose, undo } = load();
    await start();
    await choose("archive");
    await choose("keep");
    await undo();
    expect(shown()).toEqual([ids[1]]);
    await choose("keep");
    expect(shown()).toEqual([ids[2]]);
    const kept = p.sent.filter((s) => s.url === "/home/keep").map((s) => s.body);
    expect(kept).toEqual([{ id: ids[1] }, { id: ids[1] }]);
  });

  it("shows the finish screen after the fifth, and an Undo there brings the link back to a step", async () => {
    const { ids, shown, finished, start, choose, undo } = load();
    await start();
    for (let i = 0; i < 4; i++) await choose("keep");
    expect(finished()).toBe(false);
    await choose("archive");
    expect(finished()).toBe(true);
    expect(shown()).toEqual([]);
    await undo();
    expect(shown()).toEqual([ids[4]]);
    expect(finished()).toBe(false);
    await choose("keep");
    expect(finished()).toBe(true);
  });

  it("an Undo while a choice on the next link is in flight waits for it, then runs", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    let archives = 0;
    const { p, ids, shown, start, choose, undo } = load((s) =>
      s.url === "/home/archive" && ++archives === 2 ? { ...fine(s), wait } : fine(s),
    );
    await start();
    await choose("archive");
    p.dispatch(p.$(".tidy-step:not([hidden]) button[data-act=archive]"), "click");
    await undo();
    expect(urls(p)).toEqual(["/home/archive", "/home/archive"]);
    release();
    await p.settle();
    expect(urls(p)).toEqual(["/home/archive", "/home/archive", "/home/undo-state"]);
    expect(p.sent[2]).toEqual(post("/home/undo-state", { id: ids[0], change: ARCHIVE_CHANGE }));
    expect(shown()).toEqual([ids[0]]);
  });

  it("sends one request for a double click", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const { p, ids, shown, start } = load((s) => ({ ...fine(s), wait }));
    await start();
    const button = p.$(".tidy-step:not([hidden]) button[data-act=keep]");
    p.dispatch(button, "click");
    p.dispatch(button, "click");
    release();
    await p.settle();
    expect(p.sent).toEqual([post("/home/keep", { id: ids[0] })]);
    expect(shown()).toEqual([ids[1]]);
  });

  it("a 409 shows the refusal's message, does not advance and offers no Undo", async () => {
    const { p, ids, shown, start, choose } = load(() => ({
      status: 409,
      body: { code: "conflict", message: "That link changed. Reload the page." },
    }));
    await start();
    for (const act of ["keep", "archive"]) {
      await choose(act);
      expect(p.$("#tidy-error").textContent).toBe("That link changed. Reload the page.");
      expect(shown()).toEqual([ids[0]]);
    }
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("a request that fails says to reload, and does not advance", async () => {
    const { p, ids, shown, start, choose } = load(() => ({ status: 200, networkFails: true }));
    await start();
    await choose("archive");
    expect(p.$("#tidy-error").textContent).toBe(
      "That did not work. Reload the page and try again.",
    );
    expect(shown()).toEqual([ids[0]]);
  });

  it("a later success clears the message", async () => {
    let refuse = true;
    const { p, start, choose } = load((s) =>
      refuse ? { status: 409, body: { code: "conflict", message: "Nope." } } : fine(s),
    );
    await start();
    await choose("keep");
    expect(p.$("#tidy-error").textContent).toBe("Nope.");
    refuse = false;
    await choose("keep");
    expect(p.$("#tidy-error").textContent).toBe("");
  });

  it("a refused Undo shows the message and leaves the view as it is", async () => {
    const { p, ids, shown, start, choose, undo } = load((s) =>
      s.url === "/home/undo-state"
        ? { status: 409, body: { code: "conflict", message: "Changed since." } }
        : fine(s),
    );
    await start();
    await choose("archive");
    await undo();
    expect(p.$("#tidy-error").textContent).toBe("Changed since.");
    expect(shown()).toEqual([ids[1]]);
  });

  describe("the keys", () => {
    it.each([
      ["1", "/home/keep"],
      ["2", "/home/snooze"],
      ["3", "/home/archive"],
    ])("key %s posts %s for the shown link", async (k, url) => {
      const { p, ids, start, key } = load();
      await start();
      await key(k);
      expect(p.sent).toEqual([post(url, { id: ids[0] })]);
    });

    it.each(["1", "2", "3"])("key %s does nothing while the tray is closed", async (k) => {
      const { p, shown, key } = load();
      await key(k);
      expect(p.sent).toEqual([]);
      expect(shown()).toEqual([]);
    });

    it.each(["1", "2", "3"])("key %s does nothing after Stop here, or after Close", async (k) => {
      const { p, start, stop, close, choose, key } = load(fine, 2);
      await start();
      await stop();
      await key(k);
      expect(p.sent).toEqual([]);
      await start();
      await choose("keep");
      await choose("keep");
      await close();
      await key(k);
      expect(p.sent).toHaveLength(2);
    });

    it.each(["1", "2", "3"])("key %s does nothing while a dialog is open", async (k) => {
      const { p, shown, ids, start, key } = load();
      await start();
      const dialog = p.$("dialog");
      dialog.setAttribute("open", "");
      await key(k);
      expect(p.sent).toEqual([]);
      expect(shown()).toEqual([ids[0]]);
      dialog.removeAttribute("open");
      await key(k);
      expect(p.sent).toHaveLength(1);
    });

    it.each(["1", "2", "3"])("key %s does nothing while the Ask AI panel is open", async (k) => {
      const { p, shown, ids, start, key } = load();
      await start();
      p.document.body.setAttribute("data-panel", "");
      await key(k);
      expect(p.sent).toEqual([]);
      expect(shown()).toEqual([ids[0]]);
      p.document.body.removeAttribute("data-panel");
      await key(k);
      expect(p.sent).toHaveLength(1);
    });

    it("act on the link currently shown, after an Undo too", async () => {
      const { p, ids, start, choose, undo, key } = load();
      await start();
      await choose("archive");
      await undo();
      await key("1");
      expect(p.sent.at(-1)).toEqual(post("/home/keep", { id: ids[0] }));
    });

    it.each(["1", "2", "3"])("an auto-repeated key %s picks nothing", async (k) => {
      const { p, ids, shown, start, key } = load();
      await start();
      await key(k, { repeat: true });
      expect(p.sent).toEqual([]);
      expect(shown()).toEqual([ids[0]]);
    });

    it("are ignored in a field, with a modifier held, and on the finish screen", async () => {
      const { p, finished, start, choose, key } = load(fine, 1);
      await start();
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
      await key("2", { shiftKey: true });
      await key("x");
      expect(p.sent).toEqual([]);
      await choose("keep");
      expect(finished()).toBe(true);
      await key("2");
      expect(p.sent).toHaveLength(1);
    });
  });

  it("moves focus to the new link's title, and to the finish heading", async () => {
    const { p, ids, start, choose } = load(fine, 2);
    await start();
    await choose("keep");
    const title = p.$(`.tidy-step[data-id='${ids[1]}'] .tidy-title`);
    // The Undo bar then takes focus, as it does after Archive.
    expect(p.focused().includes(title)).toBe(true);
    expect(p.focused().at(-1)).toBe(p.$("#undo-bar button"));
    expect(title.getAttribute("tabindex")).toBe("-1");
    await choose("keep");
    expect(p.focused().includes(p.$(".tidy-done h3"))).toBe(true);
  });

  it("hints each choice's key, off the screen reader's path", () => {
    const keys = [...first(queue(1)).querySelectorAll("button[data-act] .key")];
    expect(keys.map((k) => k.textContent)).toEqual(["1", "2", "3"]);
    expect(keys.every((k) => k.getAttribute("aria-hidden") === "true")).toBe(true);
  });
});

describe("a Tidy up choice that is slow to answer (#314)", () => {
  const WORDS = [
    ["keep", "Keeping…", "1"],
    ["skip", "Skipping…", "2"],
    ["archive", "Archiving…", "3"],
  ] as const;

  const slow = async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p = runPage(render(queue(3)), (s) =>
      s.url === "/home/keep" ? { status: 204, wait: gate } : { ...fine(s), wait: gate },
    );
    p.dispatch(p.$("button[data-tidy=start]"), "click");
    await p.settle();
    const step = p.$(".tidy-step:not([hidden])");
    return { p, step, release };
  };
  const choice = (step: Element, act: string) =>
    step.querySelector(`button[data-act=${act}]`) as Element;

  it.each(WORDS)(
    "%s: after 300ms the step dims and only the choice's title changes, then both clear",
    async (act, word) => {
      const { p, step, release } = await slow();
      const button = choice(step, act);
      const before = button.innerHTML;
      p.dispatch(button, "click");
      await p.settle();
      expect(p.timers.pending(300)).toBe(1);
      expect(step.hasAttribute("data-busy")).toBe(false);
      p.timers.fire();
      expect(step.hasAttribute("data-busy")).toBe(true);
      expect(p.$("#tidy").hasAttribute("data-busy")).toBe(false);
      expect(button.querySelector("b")?.textContent).toBe(word);
      expect(button.innerHTML).toBe(before.replace(/<b>[^<]*<\/b>/, `<b>${word}</b>`));
      release();
      await p.settle();
      expect(p.document.querySelector("[data-busy]")).toBeNull();
      expect(button.innerHTML).toBe(before);
    },
  );

  it.each(WORDS)(
    "the %s number key does the same, finding the choice from the step and the action",
    async (act, word, key) => {
      const { p, step, release } = await slow();
      const button = choice(step, act);
      const before = button.innerHTML;
      p.dispatch(p.document.body, "keydown", { key });
      await p.settle();
      p.timers.fire();
      expect(button.querySelector("b")?.textContent).toBe(word);
      expect(button.innerHTML).toBe(before.replace(/<b>[^<]*<\/b>/, `<b>${word}</b>`));
      expect(button.querySelector("kbd")?.textContent).toBe(key);
      expect(step.hasAttribute("data-busy")).toBe(true);
      for (const other of step.querySelectorAll("button[data-act]")) {
        if (other !== button) expect(other.querySelector("b")?.textContent).not.toBe(word);
      }
      release();
      await p.settle();
      expect(button.innerHTML).toBe(before);
      expect(p.document.querySelector("[data-busy]")).toBeNull();
    },
  );

  it("a second choice while one is out sends nothing and changes no title", async () => {
    const { p, step, release } = await slow();
    p.dispatch(choice(step, "keep"), "click");
    await p.settle();
    p.dispatch(choice(step, "archive"), "click");
    p.dispatch(p.document.body, "keydown", { key: "3" });
    await p.settle();
    p.timers.fire();
    expect(choice(step, "archive").querySelector("b")?.textContent).toBe("Archive");
    expect(p.sent.map((s) => s.url)).toEqual(["/home/keep"]);
    release();
    await p.settle();
  });
});

describe("the Tidy up session on a gone page (#340)", () => {
  const goneQueue = (): TidyLink[] => [
    { link: link(), gone: true, fit: null },
    { link: link(), gone: false, fit: null },
  ];
  const start = (answer: (s: Post) => Answer = fine) => {
    const q = goneQueue();
    const p = runPage(render(q), answer);
    const shown = () =>
      [...p.document.querySelectorAll(".tidy-step")]
        .filter((s) => !s.hasAttribute("hidden"))
        .map((s) => s.getAttribute("data-id"));
    const key = async (k: string) => {
      p.dispatch(p.document.body, "keydown", { key: k });
      await p.settle();
    };
    return { p, q, shown, key };
  };

  it("key 1 posts /links/still-works, and its Undo posts the check and previous it got, bringing the step back", async () => {
    const { p, q, shown, key } = start();
    p.dispatch(p.$("button[data-tidy=start]"), "click");
    await p.settle();
    expect(shown()).toEqual([q[0]?.link.id]);
    await key("1");
    expect(p.sent).toEqual([post("/links/still-works", { id: q[0]?.link.id })]);
    expect(p.$("#undo-bar span").textContent).toBe("Marked as working.");
    expect(shown()).toEqual([q[1]?.link.id]);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toEqual(
      post("/links/still-works/undo", {
        id: q[0]?.link.id,
        check: STILL_WORKS.check,
        previous: STILL_WORKS.previous,
      }),
    );
    expect(shown()).toEqual([q[0]?.link.id]);
  });

  it("key 3 does nothing on a gone step, and key 2 archives it", async () => {
    const { p, q, shown, key } = start();
    p.dispatch(p.$("button[data-tidy=start]"), "click");
    await p.settle();
    await key("3");
    expect(p.sent).toEqual([]);
    expect(shown()).toEqual([q[0]?.link.id]);
    await key("2");
    expect(p.sent).toEqual([post("/home/archive", { id: q[0]?.link.id })]);
  });

  it("a refused It still works shows the message, does not advance and offers no Undo", async () => {
    const { p, q, shown, key } = start((s) =>
      s.url === "/links/still-works"
        ? { status: 409, body: { code: "conflict", message: "That page was checked since." } }
        : fine(s),
    );
    p.dispatch(p.$("button[data-tidy=start]"), "click");
    await p.settle();
    await key("1");
    expect(p.$("#tidy-error").textContent).toBe("That page was checked since.");
    expect(shown()).toEqual([q[0]?.link.id]);
    expect(p.$("#undo-bar").hidden).toBe(true);
  });
});
