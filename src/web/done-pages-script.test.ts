import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { spacePage } from "./space-page.js";

const NOW = new Date("2026-10-19T12:00:00Z");
const KITCHEN: Tag = {
  key: "kitchen",
  name: "Kitchen",
  kind: "topic",
  kindSource: "stated",
  color: "clay",
  pinned: true,
  description: null,
  projectStatus: null,
};
const link: Link = {
  id: "7",
  url: "https://ex.com/7",
  urlKey: "ex.com/7",
  title: "Link 7",
  summary: null,
  why: { text: "because 7", source: "stated" },
  tags: [
    { key: "kitchen", name: "Kitchen", source: "stated", kind: "topic", kindSource: "stated" },
  ],
  savedAt: NOW,
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "archived",
  snapshot: null,
};
const common = {
  links: [link],
  older: null,
  catalog: [KITCHEN],
  images: new Map(),
  handy: new Map(),
  copies: new Map([["7", { madeAt: NOW }]]),
  now: NOW,
  done: true,
};
const post = (url: string, body: unknown): Post => ({
  url,
  body,
  redirect: "manual",
  keepalive: undefined,
});
const REFUSED = "That link is not there any more. Reload the page.";

describe.each([
  ["/all/done", "all-error", () => allPage({ ...common, order: "newest" })],
  ["/spaces/done", "space-error", () => spacePage({ ...common, tag: KITCHEN })],
])("the controls on %s", (_, alert, html) => {
  const load = (answer?: (sent: Post) => Answer) => {
    const p = runPage(html(), answer);
    return { p, dialog: stubDialog(p) };
  };
  const click = async (p: ReturnType<typeof runPage>, selector: string) => {
    p.dispatch(p.$(selector), "click");
    await p.settle();
  };

  it("Delete link posts, removes the card and offers Undo", async () => {
    const { p } = load();
    await click(p, "[data-id='7'] button[data-act=delete-link]");
    expect(p.sent).toEqual([post("/links/delete", { id: "7" })]);
    expect(p.$("[data-id='7']")).toBeNull();
    expect(p.$("#undo-bar").hidden).toBe(false);
    expect(p.$("#undo-bar span").textContent).toBe("Link deleted.");
  });

  it("a refused delete shows its message in the page's alert and keeps the card", async () => {
    const { p } = load(() => ({ status: 404, body: { code: "not_found", message: REFUSED } }));
    await click(p, "[data-id='7'] button[data-act=delete-link]");
    expect(p.$(`#${alert}`).textContent).toBe(REFUSED);
    expect(p.$("[data-id='7']")).not.toBeNull();
  });

  it("the ⋯ Edit opens the dialog", async () => {
    const { p, dialog } = load();
    await click(p, "[data-id='7'] button[data-act=edit]");
    expect(dialog.open).toBe(true);
  });

  it("Remove saved copy posts its request", async () => {
    const { p } = load();
    await click(p, "[data-id='7'] button[data-act=remove-copy]");
    expect(p.sent).toEqual([post("/links/copy/remove", { id: "7" })]);
  });
});
