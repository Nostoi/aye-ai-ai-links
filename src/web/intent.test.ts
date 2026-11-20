import { describe, expect, it } from "vitest";
import type { Link } from "../core/types.js";
import { cardLine } from "./card-line.js";
import { deleteLinkScript } from "./delete-link.js";
import { editMenu } from "./edit-link.js";
import { intentLinkScript } from "./intent.js";
import { keepHandyScript } from "./keep-handy.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { page } from "./page.js";
import { CARD_FETCH } from "./tell-why.js";

const link = (over: Partial<Link> = {}): Link => ({
  id: "7",
  url: "https://school.example/attendance",
  urlKey: "school.example/attendance",
  title: "Attendance",
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-10-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
  intent: "explore",
  intentSource: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});
const EXPLORE = { intent: "explore", intentSource: null };
const STATED = { intent: "keep", intentSource: "stated" };
const KEEP_CHANGE = { before: EXPLORE, after: STATED, at: "2026-11-19T10:00:00.000Z" };

function load(answer: (sent: Post) => Answer, { leaves = false, over = {} } = {}) {
  const l = link(over);
  const html = page(
    "Test",
    `<h1>Test</h1>
<p id="list-error" role="alert"></p>
<ul id="list"><li data-id="7" data-intent="${l.intent}" data-intent-source="${l.intentSource ?? ""}">
${cardLine(l, { intent: true })}${editMenu(l)}</li></ul>
<script>
${CARD_FETCH}
${deleteLinkScript("list", "list-error")}
${keepHandyScript("list", "list-error")}
${intentLinkScript("list", "list-error", leaves)}
</script>`,
    { undo: true },
  );
  return runPage(html, answer);
}
type Page = ReturnType<typeof runPage>;
const rows = (p: Page) =>
  ["intent-keep", "intent-explore"].map(
    (act) => (p.$(`button[data-act=${act}]`) as HTMLElement).hidden,
  );
const lineText = (p: Page) => {
  const part = p.$("[data-intent-line]") as HTMLElement;
  return part.hidden ? null : part.textContent;
};
const press = async (p: Page, act: string) => {
  p.dispatch(p.$(`button[data-act=${act}]`), "click");
  await p.settle();
};

describe("Keep it and Explore it on a card (#339)", () => {
  it("Keep it posts /home/keep, swaps the menu row, shows To keep and offers an Undo that restores explore", async () => {
    const p = load((s) =>
      s.url === "/home/keep" ? { status: 200, body: KEEP_CHANGE } : { status: 204 },
    );
    expect([rows(p), lineText(p)]).toEqual([[false, true], null]);
    await press(p, "intent-keep");
    expect(p.sent[0]).toMatchObject({ url: "/home/keep", body: { id: "7" } });
    expect([rows(p), lineText(p)]).toEqual([[true, false], "To keep"]);
    expect((p.$("[data-id='7']") as HTMLElement).dataset.intent).toBe("keep");
    expect(p.$("#undo-bar span").textContent).toContain("Marked To keep.");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({
      url: "/home/undo-intent",
      body: { id: "7", change: KEEP_CHANGE },
    });
    expect([rows(p), lineText(p)]).toEqual([[false, true], null]);
    expect((p.$("[data-id='7']") as HTMLElement).dataset.intent).toBe("explore");
  });

  it("Explore it on a guessed keep shows explore, and its Undo brings the guess back", async () => {
    const change = {
      before: { intent: "keep", intentSource: "inferred" },
      after: { intent: "explore", intentSource: "stated" },
      at: "2026-11-19T10:00:00.000Z",
    };
    const p = load(
      (s) => (s.url === "/home/explore" ? { status: 200, body: change } : { status: 204 }),
      {
        over: { intent: "keep", intentSource: "inferred" },
      },
    );
    expect(lineText(p)).toBe("To keep (a guess)");
    await press(p, "intent-explore");
    expect([rows(p), lineText(p)]).toEqual([[false, true], null]);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(lineText(p)).toBe("To keep (a guess)");
    expect((p.$("[data-id='7']") as HTMLElement).dataset.intentSource).toBe("inferred");
  });

  it("a refusal changes nothing on the card, shows its words and offers no Undo", async () => {
    const p = load(() => ({
      status: 409,
      body: { code: "conflict", message: "This link is already archived. Reload." },
    }));
    await press(p, "intent-keep");
    expect([rows(p), lineText(p)]).toEqual([[false, true], null]);
    expect(p.$("#list-error").textContent).toBe("This link is already archived. Reload.");
    expect((p.$("#undo-bar") as HTMLElement).hidden).toBe(true);
  });

  it("on Home's Today cards (leaves) Keep it takes the card out, and Undo puts it back", async () => {
    const p = load(
      (s) => (s.url === "/home/keep" ? { status: 200, body: KEEP_CHANGE } : { status: 204 }),
      {
        leaves: true,
      },
    );
    await press(p, "intent-keep");
    expect((p.$("[data-id='7']") as HTMLElement).hidden).toBe(true);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect((p.$("[data-id='7']") as HTMLElement).hidden).toBe(false);
  });
});

describe("Keep handy on a card with the intent rows (#339)", () => {
  const MOVED = {
    tool: {
      status: "kept",
      source: "stated",
      since: "2026-11-19T10:00:00.000Z",
      answeredAt: null,
      waitDays: 30,
    },
    previous: null,
    intent: { before: EXPLORE, after: STATED },
  };

  it("hides both intent rows and shows To keep; Undo sends the intent move back and restores them", async () => {
    const p = load((s) =>
      s.url === "/tools/keep" ? { status: 200, body: MOVED } : { status: 204 },
    );
    await press(p, "keep");
    expect([rows(p), lineText(p)]).toEqual([[true, true], "To keep"]);
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    expect(p.sent[1]).toMatchObject({
      url: "/tools/undo",
      body: { id: "7", tool: MOVED.tool, previous: null, intent: MOVED.intent },
    });
    expect([rows(p), lineText(p)]).toEqual([[false, true], null]);
  });

  it("Not handy anymore brings back the row for the intent the link kept", async () => {
    const answer = (s: Post): Answer =>
      s.url === "/tools/keep"
        ? { status: 200, body: MOVED }
        : s.url === "/tools/not-handy"
          ? {
              status: 200,
              body: {
                tool: { ...MOVED.tool, status: "declined" },
                previous: MOVED.tool,
                intent: null,
              },
            }
          : { status: 204 };
    const p = load(answer);
    await press(p, "keep");
    await press(p, "not-handy");
    expect([rows(p), lineText(p)]).toEqual([[true, false], "To keep"]);
  });
});
