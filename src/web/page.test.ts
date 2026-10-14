import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { page, UNDO_BAR_MS } from "./page.js";

/**
 * A page with the Undo bar in linkedom, its script run with recorded timers. linkedom has no
 * focus tracking, so `focused` stands in for `document.activeElement` and each focus call sets it.
 */
function load() {
  const html = page("t", '<main><button id="pin" type="button">Unpin</button></main>', {
    undo: true,
  });
  const { document, window } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.includes("showUndo"))
    .join("\n");
  let focused: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => focused });
  for (const el of document.querySelectorAll("button")) {
    (el as HTMLElement).focus = () => {
      focused = el;
    };
  }
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const showUndo = new Function(
    "document",
    "setTimeout",
    "clearTimeout",
    `${code}\nreturn showUndo;`,
  )(
    document,
    (fn: () => void, ms: number) => {
      timers.set(nextId, { fn, ms });
      return nextId++;
    },
    (id: number) => timers.delete(id),
  ) as (message: string, undo: () => Promise<void>) => void;
  const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
  const bar = $("#undo-bar");
  const undoButton = $("#undo-bar button");
  const fire = (target: HTMLElement, type: string, init: Record<string, unknown> = {}) =>
    target.dispatchEvent(Object.assign(new window.Event(type, { bubbles: true }), init));
  /** Runs every pending timer, as if its time had passed. */
  const elapse = () => {
    for (const [id, t] of [...timers]) {
      timers.delete(id);
      t.fn();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    $,
    bar,
    undoButton,
    showUndo,
    timers,
    fire,
    elapse,
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

  it("closes after UNDO_BAR_MS when nothing is on it", () => {
    const p = load();
    p.showUndo("Kitchen unpinned.", async () => {});
    expect([...p.timers.values()].map((t) => t.ms)).toEqual([UNDO_BAR_MS]);
    p.elapse();
    expect(p.bar.hidden).toBe(true);
  });

  it("does not close while it has focus, and starts its time again when focus leaves", () => {
    const p = load();
    p.showUndo("Kitchen unpinned.", async () => {});
    p.fire(p.undoButton, "focusin");
    expect(p.timers.size).toBe(0);
    p.fire(p.undoButton, "focusout", { relatedTarget: p.$("#pin") });
    expect([...p.timers.values()].map((t) => t.ms)).toEqual([UNDO_BAR_MS]);
    p.elapse();
    expect(p.bar.hidden).toBe(true);
  });

  it("does not close while the pointer is over it, nor when the pointer leaves while it has focus", () => {
    const p = load();
    p.showUndo("Kitchen unpinned.", async () => {});
    p.fire(p.bar, "mouseenter");
    expect(p.timers.size).toBe(0);
    p.fire(p.undoButton, "focusin");
    p.fire(p.bar, "mouseleave");
    expect(p.timers.size).toBe(0);
    p.fire(p.undoButton, "focusout", { relatedTarget: null });
    expect(p.timers.size).toBe(1);
  });

  it("after Undo, closes and gives focus back to what had it before", async () => {
    const p = load();
    let undone = 0;
    p.focus(p.$("#pin"));
    p.showUndo("Kitchen unpinned.", async () => {
      undone++;
    });
    p.fire(p.undoButton, "focusin");
    p.fire(p.undoButton, "click");
    await p.settle();
    expect(undone).toBe(1);
    expect(p.bar.hidden).toBe(true);
    expect(p.focused()).toBe(p.$("#pin"));
  });

  it("leaves focus alone on close when what had it before is gone", async () => {
    const p = load();
    const pin = p.$("#pin");
    p.focus(pin);
    p.showUndo("Kitchen unpinned.", async () => {
      pin.remove();
    });
    p.fire(p.undoButton, "click");
    await p.settle();
    expect(p.bar.hidden).toBe(true);
    expect(p.focused()).toBe(p.undoButton);
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
