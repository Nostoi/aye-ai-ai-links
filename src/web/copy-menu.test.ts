import { describe, expect, it } from "vitest";
import type { GoneView } from "../core/link-check.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { Link } from "../core/types.js";
import { type Answer, type Post, runPage } from "./opened-test-kit.js";
import { searchPage } from "./pages.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const INFO: CopyInfo = { madeAt: new Date("2026-10-01T00:00:00Z") };
const GONE: GoneView = {
  since: new Date("2026-10-10T00:00:00Z"),
  checkedAt: new Date("2026-10-13T00:00:00Z"),
};
const link = (id: string): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  summarySource: null,
  why: { text: `because ${id}`, source: "stated" },
  tags: [],
  savedAt: new Date("2026-10-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});

/** A search page with gone links "7" and "8", both with a saved copy. */
const load = (answer: (sent: Post) => Answer) =>
  runPage(
    searchPage({
      query: "",
      links: [link("7"), link("8")],
      now: NOW,
      gone: new Map([
        ["7", GONE],
        ["8", GONE],
      ]),
      copies: new Map([
        ["7", INFO],
        ["8", INFO],
      ]),
    }),
    answer,
  );
const post = (url: string, body: unknown): Post => ({
  url,
  body,
  redirect: "manual",
  keepalive: undefined,
});
const click = async (p: ReturnType<typeof runPage>, selector: string) => {
  p.dispatch(p.$(selector), "click");
  await p.settle();
};
const REMOVE = "[data-id='7'] button[data-act=remove-copy]";
const READ = "[data-id='7'] .card-line a[data-act=read-copy]";

describe("the Remove saved copy row's script", () => {
  it("leaves another card's row and grey-line link alone, through remove and Undo", async () => {
    const p = load(() => ({ status: 204 }));
    const others = [
      "[data-id='8'] button[data-act=remove-copy]",
      "[data-id='8'] .card-line a[data-act=read-copy]",
    ];
    await click(p, REMOVE);
    expect(p.$(REMOVE).hidden).toBe(true);
    for (const s of others) expect(p.$(s).hidden).toBe(false);
    await click(p, "#undo-bar button");
    for (const s of others) expect(p.$(s).hidden).toBe(false);
  });

  it("sends one request for a second click while the first is waiting", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const p = load(() => ({ status: 204, wait }));
    p.dispatch(p.$(REMOVE), "click");
    p.dispatch(p.$(REMOVE), "click");
    release();
    await p.settle();
    expect(p.sent).toEqual([post("/links/copy/remove", { id: "7" })]);
  });

  it("a 204 posts the id, hides the row and the grey line's link, and offers Undo", async () => {
    const p = load(() => ({ status: 204 }));
    const menu = p.$("[data-id='7'] details.card-menu");
    (menu as HTMLDetailsElement).open = true;
    await click(p, REMOVE);
    expect(p.sent).toEqual([post("/links/copy/remove", { id: "7" })]);
    expect(p.$(REMOVE).hidden).toBe(true);
    expect(p.$(READ).hidden).toBe(true);
    expect((menu as HTMLDetailsElement).open).toBe(false);
    // Focus goes to the ⋯ first, so the Undo bar hands it back there when it closes.
    expect(p.focused()[0]).toBe(p.$("[data-id='7'] details.card-menu summary"));
    expect(p.$("#undo-bar span").textContent).toBe("Saved copy removed.");
  });

  it("Undo posts the restore and shows the rows again on a 204", async () => {
    const p = load(() => ({ status: 204 }));
    await click(p, REMOVE);
    await click(p, "#undo-bar button");
    expect(p.sent[1]).toEqual(post("/links/copy/restore", { id: "7" }));
    expect(p.$(REMOVE).hidden).toBe(false);
    expect(p.$(READ).hidden).toBe(false);
  });

  it("an Undo that is refused shows the message and keeps the rows hidden", async () => {
    const p = load((s) =>
      s.url === "/links/copy/restore"
        ? { status: 404, body: { code: "not_found", message: "Too late." } }
        : { status: 204 },
    );
    await click(p, REMOVE);
    await click(p, "#undo-bar button");
    expect(p.$("#results-error").textContent).toBe("Too late.");
    expect(p.$(REMOVE).hidden).toBe(true);
    expect(p.$(READ).hidden).toBe(true);
  });

  it("a 404 puts the message in #results-error and hides nothing", async () => {
    const p = load(() => ({
      status: 404,
      body: { code: "not_found", message: "That saved copy is not there any more." },
    }));
    await click(p, REMOVE);
    expect(p.$("#results-error").textContent).toBe("That saved copy is not there any more.");
    expect(p.$(REMOVE).hidden).toBe(false);
    expect(p.$(READ).hidden).toBe(false);
    expect(p.$("#undo-bar").hidden).toBe(true);
  });
});
