import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CARD_FETCH } from "./tell-why.js";

/**
 * `CARD_FETCH` run alone in linkedom, with vitest's fake timers standing in for the page's, so
 * 299ms and 300ms can be told apart. The page-level tests (`card-busy.test.ts` and each action's
 * own) cover the callers; this covers the primitive.
 */
const PAGE = `<article id="card" data-id="7">
<button id="slide" class="slide" data-act="done"><svg id="icon"></svg><span class="slide-words"><span id="label">Done with it</span><small id="hint">Still findable in search</small></span></button>
<button id="plain" data-act="keep">Keep handy</button>
<button id="tidy" data-act="tidy"><b id="title">Keep</b><span id="line">Stays where it is.</span><kbd id="key">1</kbd></button>
<section data-busy-scope id="scope"><button id="scoped" data-act="end">Bring it back</button></section>
</article>`;

function load() {
  const { document } = parseHTML(`<html><body>${PAGE}</body></html>`);
  const code = `${CARD_FETCH}\nreturn { whileBusy, whenFree, busyLook, cardBusy };`;
  const api = new Function("document", "setTimeout", "clearTimeout", code)(
    document,
    setTimeout,
    clearTimeout,
  ) as {
    whileBusy: (card: Element, run: () => unknown, look?: object) => Promise<unknown>;
    whenFree: (card: Element, run: () => unknown, look?: object) => Promise<unknown>;
    busyLook: (el: Element, button: Element | null, word: string) => () => void;
    cardBusy: WeakSet<Element>;
  };
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  return { ...api, $, document };
}

/** A promise a test settles when it likes, to hold `run` open. */
const gate = () => {
  let open: (value?: unknown) => void = () => {};
  let fail: (reason: unknown) => void = () => {};
  const held = new Promise((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { held, open, fail };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("busyLook", () => {
  it("shows nothing at 299ms, and at 300ms dims the element and swaps the label's words", () => {
    const p = load();
    p.busyLook(p.$("card"), p.$("slide"), "Marking done…");
    vi.advanceTimersByTime(299);
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);
    expect(p.$("label").textContent).toBe("Done with it");
    vi.advanceTimersByTime(1);
    expect(p.$("card").hasAttribute("data-busy")).toBe(true);
    expect(p.$("label").textContent).toBe("Marking done…");
  });

  it("changes only the label node: the icon, the hint and the button's own markup stay", () => {
    const p = load();
    const before = p.$("slide").innerHTML.replace("Done with it", "");
    p.busyLook(p.$("card"), p.$("slide"), "Marking done…");
    vi.advanceTimersByTime(300);
    expect(p.$("slide").contains(p.$("icon"))).toBe(true);
    expect(p.$("hint").textContent).toBe("Still findable in search");
    expect(p.$("slide").innerHTML.replace("Marking done…", "")).toBe(before);
  });

  it("marks the working button, so an icon button shows its words as if open", () => {
    const p = load();
    p.busyLook(p.$("card"), p.$("slide"), "Marking done…");
    expect(p.$("slide").hasAttribute("data-working")).toBe(false);
    vi.advanceTimersByTime(300);
    expect(p.$("slide").hasAttribute("data-working")).toBe(true);
  });

  it("swaps a plain button's own words, and a Tidy choice's title only", () => {
    const p = load();
    p.busyLook(p.$("card"), p.$("plain"), "Keeping handy…");
    p.busyLook(p.$("card"), p.$("tidy"), "Keeping…");
    vi.advanceTimersByTime(300);
    expect(p.$("plain").textContent).toBe("Keeping handy…");
    expect(p.$("title").textContent).toBe("Keeping…");
    expect(p.$("line").textContent).toBe("Stays where it is.");
    expect(p.$("key").textContent).toBe("1");
  });

  it("with no button, only dims; with no word it leaves the label alone", () => {
    const p = load();
    p.busyLook(p.$("card"), null, "Deleting…");
    vi.advanceTimersByTime(300);
    expect(p.$("card").hasAttribute("data-busy")).toBe(true);
    expect(p.$("label").textContent).toBe("Done with it");
    expect(p.$("plain").textContent).toBe("Keep handy");
  });

  it("does not touch the label of a button that has left the page by then, and still dims", () => {
    const p = load();
    p.busyLook(p.$("card"), p.$("plain"), "Keeping handy…");
    const plain = p.$("plain");
    plain.remove();
    vi.advanceTimersByTime(300);
    expect(p.$("card").hasAttribute("data-busy")).toBe(true);
    expect(plain.textContent).toBe("Keep handy");
  });

  it("clears what it set, and nothing if the answer came first", () => {
    const quick = load();
    const clearQuick = quick.busyLook(quick.$("card"), quick.$("slide"), "Marking done…");
    vi.advanceTimersByTime(100);
    clearQuick();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(quick.$("card").hasAttribute("data-busy")).toBe(false);
    expect(quick.$("label").textContent).toBe("Done with it");
    expect(quick.$("slide").hasAttribute("data-working")).toBe(false);

    const slow = load();
    const clearSlow = slow.busyLook(slow.$("card"), slow.$("slide"), "Marking done…");
    vi.advanceTimersByTime(300);
    clearSlow();
    expect(slow.$("card").hasAttribute("data-busy")).toBe(false);
    expect(slow.$("label").textContent).toBe("Done with it");
    expect(slow.$("slide").hasAttribute("data-working")).toBe(false);
  });

  it("undoes only what it set: words the page wrote meanwhile are kept", () => {
    const p = load();
    const clear = p.busyLook(p.$("card"), p.$("slide"), "Marking done…");
    vi.advanceTimersByTime(300);
    p.$("label").textContent = "Brought back";
    clear();
    expect(p.$("label").textContent).toBe("Brought back");
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);
  });

  it("leaves aria-busy alone", () => {
    const p = load();
    p.$("card").setAttribute("aria-busy", "true");
    const clear = p.busyLook(p.$("card"), p.$("slide"), "Marking done…");
    vi.advanceTimersByTime(300);
    clear();
    expect(p.$("card").getAttribute("aria-busy")).toBe("true");
    const other = load();
    other.busyLook(other.$("card"), other.$("slide"), "Marking done…");
    vi.advanceTimersByTime(300);
    expect(other.$("card").hasAttribute("aria-busy")).toBe(false);
  });
});

describe("whileBusy with a look", () => {
  it("shows the look at 300ms of a slow action and clears it, on the lock's release", async () => {
    const p = load();
    const slow = gate();
    const done = p.whileBusy(p.$("card"), () => slow.held, {
      button: p.$("slide"),
      word: "Marking done…",
    });
    vi.advanceTimersByTime(299);
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(p.$("card").hasAttribute("data-busy")).toBe(true);
    expect(p.$("label").textContent).toBe("Marking done…");
    slow.open("fine");
    expect(await done).toBe("fine");
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);
    expect(p.$("label").textContent).toBe("Done with it");
    expect(p.$("slide").hasAttribute("data-working")).toBe(false);
    expect(p.cardBusy.has(p.$("card"))).toBe(false);
  });

  it("restores everything when the action is refused (returns early) and when it throws", async () => {
    const p = load();
    const refused = gate();
    const first = p.whileBusy(p.$("card"), () => refused.held, {
      button: p.$("slide"),
      word: "Marking done…",
    });
    vi.advanceTimersByTime(300);
    refused.open(undefined);
    await first;
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);
    expect(p.$("label").textContent).toBe("Done with it");

    const boom = gate();
    const second = p.whileBusy(p.$("card"), () => boom.held, {
      button: p.$("slide"),
      word: "Marking done…",
    });
    vi.advanceTimersByTime(300);
    expect(p.$("label").textContent).toBe("Marking done…");
    boom.fail(new Error("boom"));
    await expect(second).rejects.toThrow("boom");
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);
    expect(p.$("label").textContent).toBe("Done with it");
    expect(p.$("slide").hasAttribute("data-working")).toBe(false);
    expect(p.cardBusy.has(p.$("card"))).toBe(false);
  });

  it("starts no timer for a fast answer, so nothing flashes", async () => {
    const p = load();
    await p.whileBusy(p.$("card"), async () => "quick", {
      button: p.$("slide"),
      word: "Marking done…",
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);
    expect(p.$("label").textContent).toBe("Done with it");
  });

  it("a second press runs nothing and swaps nothing, even on another button", async () => {
    const p = load();
    const slow = gate();
    const run = vi.fn(() => slow.held);
    const first = p.whileBusy(p.$("card"), run, { button: p.$("slide"), word: "Marking done…" });
    const again = vi.fn();
    expect(
      await p.whileBusy(p.$("card"), again, { button: p.$("plain"), word: "Keeping handy…" }),
    ).toBeUndefined();
    vi.advanceTimersByTime(300);
    expect(again).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(p.$("plain").textContent).toBe("Keep handy");
    expect(p.$("plain").hasAttribute("data-working")).toBe(false);
    expect(p.$("label").textContent).toBe("Marking done…");
    slow.open();
    await first;
    expect(p.$("plain").textContent).toBe("Keep handy");
  });

  it("dims the nearest data-busy-scope instead of the card, and an explicit element over both", async () => {
    const p = load();
    const slow = gate();
    const scoped = p.whileBusy(p.$("card"), () => slow.held, {
      button: p.$("scoped"),
      word: "Bringing back…",
    });
    vi.advanceTimersByTime(300);
    expect(p.$("scope").hasAttribute("data-busy")).toBe(true);
    expect(p.$("scoped").textContent).toBe("Bringing back…");
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);
    slow.open();
    await scoped;
    expect(p.$("scope").hasAttribute("data-busy")).toBe(false);

    const second = gate();
    const explicit = p.whileBusy(p.$("card"), () => second.held, {
      el: p.$("line"),
      button: p.$("tidy"),
      word: "Keeping…",
    });
    vi.advanceTimersByTime(300);
    expect(p.$("line").hasAttribute("data-busy")).toBe(true);
    expect(p.$("scope").hasAttribute("data-busy")).toBe(false);
    second.open();
    await explicit;
    expect(p.$("line").hasAttribute("data-busy")).toBe(false);
  });

  it("dims the card with an empty look, and shows no look without one", async () => {
    const p = load();
    const slow = gate();
    const dimmed = p.whileBusy(p.$("card"), () => slow.held, {});
    vi.advanceTimersByTime(300);
    expect(p.$("card").hasAttribute("data-busy")).toBe(true);
    slow.open();
    await dimmed;
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);

    const none = gate();
    const plain = p.whileBusy(p.$("card"), () => none.held);
    vi.advanceTimersByTime(1000);
    expect(p.$("card").hasAttribute("data-busy")).toBe(false);
    none.open();
    await plain;
  });

  it("passes the look through whenFree, once the earlier action has finished", async () => {
    const p = load();
    const first = gate();
    const held = p.whileBusy(p.$("card"), () => first.held);
    const queued = p.whenFree(p.$("card"), async () => "undone", {
      button: p.$("plain"),
      word: "Keeping handy…",
    });
    first.open();
    await held;
    expect(await queued).toBe("undone");
    expect(vi.getTimerCount()).toBe(0);
    const next = gate();
    const second = p.whenFree(p.$("card"), () => next.held, {
      button: p.$("plain"),
      word: "Keeping handy…",
    });
    await Promise.resolve();
    vi.advanceTimersByTime(300);
    expect(p.$("plain").textContent).toBe("Keeping handy…");
    next.open();
    await second;
    expect(p.$("plain").textContent).toBe("Keep handy");
  });
});
