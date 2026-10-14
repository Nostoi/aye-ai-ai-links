import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { UNDO_WINDOW_MS } from "../auth/agent-keys.js";
import { page, UNDO_BAR_MAX_MS, UNDO_BAR_MS } from "./page.js";

/**
 * A page with the Undo bar in linkedom, its script run with recorded timers. linkedom has no
 * focus tracking, so `focused` stands in for `document.activeElement` and each focus call sets it.
 * As in Chrome, disabling the focused button moves focus to the body.
 */
function load() {
  const html = page(
    "t",
    '<main><button id="pin" type="button">Unpin</button><button id="pin2" type="button">Unpin</button></main>',
    { undo: true },
  );
  const { document, window } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.includes("showUndo"))
    .join("\n");
  const fire = (target: Element, type: string, init: Record<string, unknown> = {}) =>
    target.dispatchEvent(Object.assign(new window.Event(type, { bubbles: true }), init));
  let focused: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => focused });
  for (const el of document.querySelectorAll("button")) {
    (el as HTMLElement).focus = () => {
      const before = focused;
      if (before === el) return;
      focused = document.body;
      if (before && before !== document.body) fire(before, "focusout", { relatedTarget: el });
      focused = el;
      fire(el, "focusin", { relatedTarget: before });
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
  let nextId = 1;
  let now = 0;
  const timers = new Map<number, { fn: () => void; ms: number; due: number }>();
  const showUndo = new Function(
    "document",
    "setTimeout",
    "clearTimeout",
    `${code}\nreturn showUndo;`,
  )(
    document,
    (fn: () => void, ms: number) => {
      timers.set(nextId, { fn, ms, due: now + ms });
      return nextId++;
    },
    (id: number) => timers.delete(id),
  ) as (message: string, undo: () => Promise<void>) => void;
  const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
  const bar = $("#undo-bar");
  const undoButton = $("#undo-bar button");
  /** Moves the clock on by `ms`, running each timer that falls due, in order. */
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers]
        .filter(([, t]) => t.due <= until)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].due;
      next[1].fn();
    }
    now = until;
  };
  const waits = () => [...timers.values()].map((t) => t.ms).sort((a, b) => a - b);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    $,
    bar,
    undoButton,
    showUndo,
    waits,
    fire,
    advance,
    settle,
    focus: (el: HTMLElement) => el.focus(),
    focused: () => focused,
  };
}

describe("the Undo bar", () => {
  it("shows the message and moves focus to its Undo button", () => {
    const p = load();
    p.focus(p.$("#pin"));
    p.showUndo("Kitchen unpinned.", async () => {});
    expect(p.bar.hidden).toBe(false);
    expect(p.$("#undo-bar span").textContent).toBe("Kitchen unpinned.");
    expect(p.focused()).toBe(p.undoButton);
  });

  it("closes UNDO_BAR_MS after focus leaves it", () => {
    const p = load();
    p.showUndo("Kitchen unpinned.", async () => {});
    p.focus(p.$("#pin"));
    p.advance(UNDO_BAR_MS - 1);
    expect(p.bar.hidden).toBe(false);
    p.advance(1);
    expect(p.bar.hidden).toBe(true);
  });

  it("does not close at UNDO_BAR_MS while it has focus, and starts that time again when focus leaves", () => {
    const p = load();
    p.showUndo("Kitchen unpinned.", async () => {});
    p.advance(UNDO_BAR_MS);
    expect(p.bar.hidden).toBe(false);
    p.focus(p.$("#pin"));
    expect(p.waits()).toEqual([UNDO_BAR_MS, UNDO_BAR_MAX_MS]);
    p.advance(UNDO_BAR_MS);
    expect(p.bar.hidden).toBe(true);
  });

  it("does not close at UNDO_BAR_MS while the pointer is over it, nor when the pointer leaves while it has focus", () => {
    const p = load();
    p.showUndo("Kitchen unpinned.", async () => {});
    p.focus(p.$("#pin"));
    p.fire(p.bar, "mouseenter");
    expect(p.waits()).toEqual([UNDO_BAR_MAX_MS]);
    p.focus(p.undoButton);
    p.fire(p.bar, "mouseleave");
    expect(p.waits()).toEqual([UNDO_BAR_MAX_MS]);
    p.fire(p.undoButton, "focusout", { relatedTarget: null });
    expect(p.waits()).toEqual([UNDO_BAR_MS, UNDO_BAR_MAX_MS]);
  });

  it("closes UNDO_BAR_MAX_MS after it was shown even with focus and the pointer on it, and gives focus back", () => {
    const p = load();
    p.focus(p.$("#pin"));
    p.showUndo("Kitchen unpinned.", async () => {});
    p.fire(p.bar, "mouseenter");
    p.advance(UNDO_BAR_MAX_MS - 1);
    expect(p.bar.hidden).toBe(false);
    p.advance(1);
    expect(p.bar.hidden).toBe(true);
    expect(p.focused()).toBe(p.$("#pin"));
  });

  it("a newer message starts the UNDO_BAR_MAX_MS ceiling again", () => {
    const p = load();
    p.showUndo("Kitchen unpinned.", async () => {});
    p.advance(UNDO_BAR_MAX_MS - 1_000);
    p.showUndo("Baking unpinned.", async () => {});
    p.advance(1_000);
    expect(p.bar.hidden).toBe(false);
    p.advance(UNDO_BAR_MAX_MS - 1_000);
    expect(p.bar.hidden).toBe(true);
  });

  it("closes well before the server stops allowing an undo", () => {
    expect(UNDO_BAR_MAX_MS).toBeLessThanOrEqual(UNDO_WINDOW_MS - 10_000);
  });

  it("after Undo, closes and gives focus back to what had it before", async () => {
    const p = load();
    let undone = 0;
    p.focus(p.$("#pin"));
    p.showUndo("Kitchen unpinned.", async () => {
      undone++;
    });
    p.fire(p.undoButton, "click");
    await p.settle();
    expect(undone).toBe(1);
    expect(p.bar.hidden).toBe(true);
    expect(p.focused()).toBe(p.$("#pin"));
  });

  it("gives focus to nothing removed from the page on close", async () => {
    const p = load();
    const pin = p.$("#pin");
    p.focus(pin);
    p.showUndo("Kitchen unpinned.", async () => {
      pin.remove();
    });
    p.fire(p.undoButton, "click");
    await p.settle();
    expect(p.bar.hidden).toBe(true);
    expect(p.focused()).not.toBe(pin);
  });

  it("a second message keeps the first one's place to give focus back to", async () => {
    const p = load();
    p.focus(p.$("#pin"));
    p.showUndo("Kitchen unpinned.", async () => {});
    p.showUndo("Baking unpinned.", async () => {});
    p.fire(p.undoButton, "click");
    await p.settle();
    expect(p.focused()).toBe(p.$("#pin"));
  });
});
