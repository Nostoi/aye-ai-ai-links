import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { HandyView } from "../core/tools.js";
import type { Link } from "../core/types.js";
import { handyControl, keepHandyScript } from "./keep-handy.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { page } from "./page.js";
import { CARD_FETCH } from "./tell-why.js";

const link = (over: Partial<Link> = {}): Link => ({
  id: "7",
  url: "https://school.example/attendance",
  urlKey: "school.example/attendance",
  title: "Attendance",
  summary: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-10-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});
const view = (status: HandyView["status"]): HandyView => ({ status, source: "stated", due: false });

/** What the control shows: the visible part's text, or null for no control. */
const shown = (html: string) => {
  const control = parseHTML(`<div>${html}</div>`).document.querySelector("[data-handy]");
  if (!control) return null;
  const keep = control.querySelector("button[data-act=keep]") as HTMLElement;
  const on = control.querySelector(".handy-on") as HTMLElement;
  expect(keep.hidden).toBe(!on.hidden);
  return (keep.hidden ? on.textContent : keep.textContent)?.replace(/\s+/g, " ").trim();
};

describe("handyControl", () => {
  it("reads Keep handy for an ordinary, suggested or declined link, and Handy · Not handy anymore once kept", () => {
    expect(shown(handyControl(link(), null))).toBe("Keep handy");
    expect(shown(handyControl(link(), undefined))).toBe("Keep handy");
    expect(shown(handyControl(link(), view("suggested")))).toBe("Keep handy");
    expect(shown(handyControl(link(), view("declined")))).toBe("Keep handy");
    expect(shown(handyControl(link(), view("kept")))).toBe("Handy · Not handy anymore");
  });

  it("gives an archived link no control: it can't be on the shelf", () => {
    expect(handyControl(link({ state: "archived" }), view("kept"))).toBe("");
    expect(handyControl(link({ state: "archived" }), null)).toBe("");
  });

  it("uses the small text buttons, which are 44px tall", () => {
    const control = parseHTML(handyControl(link(), null)).document.querySelector("[data-handy]");
    expect(control?.classList.contains("small-actions")).toBe(true);
    for (const b of control?.querySelectorAll("button") ?? []) {
      expect(b.getAttribute("type")).toBe("button");
    }
  });
});

const MOVED = {
  tool: {
    status: "declined",
    source: "stated",
    since: "2026-10-16T10:00:00.000Z",
    answeredAt: null,
    waitDays: 30,
  },
  previous: {
    status: "kept",
    source: "stated",
    since: "2026-10-01T10:00:00.000Z",
    answeredAt: null,
    waitDays: 30,
  },
};

/** A list of one card with the control, its error line and the script, on a page with Undo. */
function load(kept: boolean, answer: (sent: Post) => Answer) {
  const html = page(
    "Test",
    `<p id="list-error" role="alert"></p>
<ul id="list"><li data-id="7">${handyControl(link(), kept ? view("kept") : null)}</li></ul>
<script>
${CARD_FETCH}
${keepHandyScript("list", "list-error")}
</script>`,
    { undo: true },
  );
  return runPage(html, answer);
}
const state = (p: ReturnType<typeof runPage>) =>
  p.$("button[data-act=keep]").hidden ? "kept" : "not kept";

describe("the Keep handy script", () => {
  it("Keep handy posts /tools/keep and shows Handy · Not handy anymore, offering no Undo", async () => {
    const p = load(false, () => ({
      status: 200,
      body: { ...MOVED, tool: MOVED.previous, previous: null },
    }));
    p.dispatch(p.$("button[data-act=keep]"), "click");
    await p.settle();
    expect(p.sent).toEqual([
      { url: "/tools/keep", body: { id: "7" }, redirect: "manual", keepalive: undefined },
    ]);
    expect(state(p)).toBe("kept");
    expect(p.$("#undo-bar").hidden).toBe(true);
  });

  it("Not handy anymore posts /tools/not-handy, shows Keep handy and offers Undo, which sends back the rows it got", async () => {
    const p = load(true, (s) =>
      s.url === "/tools/undo" ? { status: 204 } : { status: 200, body: MOVED },
    );
    p.dispatch(p.$("button[data-act=not-handy]"), "click");
    await p.settle();
    expect(state(p)).toBe("not kept");
    expect(p.$("#undo-bar span").textContent).toBe("Not handy anymore.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toEqual({
      url: "/tools/undo",
      body: { id: "7", tool: MOVED.tool, previous: MOVED.previous },
      redirect: "manual",
      keepalive: undefined,
    });
    expect(state(p)).toBe("kept");
  });

  it.each([
    [
      "a 409",
      {
        status: 409,
        body: {
          code: "conflict",
          message: "That link's Keep handy state changed. Reload the page.",
        },
      },
      "That link's Keep handy state changed. Reload the page.",
    ],
    [
      "a redirect to the sign-in page",
      { status: 0, type: "opaqueredirect" },
      "That did not work. Reload the page and try again.",
    ],
    [
      "a 200 with no rows",
      { status: 200, body: {} },
      "That did not work. Reload the page and try again.",
    ],
  ])(
    "leaves the control as it was, offers no Undo and says why on %s",
    async (_, answer, message) => {
      const p = load(true, () => answer as Answer);
      p.dispatch(p.$("button[data-act=not-handy]"), "click");
      await p.settle();
      expect(state(p)).toBe("kept");
      expect(p.$("#undo-bar").hidden).toBe(true);
      expect(p.$("#list-error").textContent).toBe(message);
    },
  );

  it("keeps Keep handy showing and says why when Undo is refused", async () => {
    const p = load(true, (s) =>
      s.url === "/tools/undo"
        ? { status: 409, body: { message: "Changed." } }
        : { status: 200, body: MOVED },
    );
    p.dispatch(p.$("button[data-act=not-handy]"), "click");
    await p.settle();
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(state(p)).toBe("not kept");
    expect(p.$("#list-error").textContent).toBe("Changed.");
  });

  it("sends nothing for a second click while the first is still waiting", async () => {
    const p = load(false, () => ({ status: 200, body: { tool: MOVED.previous, previous: null } }));
    const keep = p.$("button[data-act=keep]");
    p.dispatch(keep, "click");
    p.dispatch(keep, "click");
    await p.settle();
    expect(p.sent).toHaveLength(1);
  });
});
