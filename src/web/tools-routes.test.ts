import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { addSecondUser, allRows, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { recordOpening, saveLink, updateLink } from "../core/links.js";
import type { ToolRecord } from "../core/tool-store.js";
import { keepHandy, notHandy, stillUsing } from "../core/tools.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const DAY = 86_400_000;
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
/** The deps with the clock at `when`, to seed the rows a past action wrote. */
const at = (world: World, when: Date) => ({ ...linkDeps(world), now: () => when });
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** A's links and Keep handy rows: what another owner's request must leave alone. */
const ownedRows = (world: World, owner: string) => ({
  links: world.links.prepare("SELECT * FROM links WHERE owner_id = ? ORDER BY id").all(owner),
  tools: world.links
    .prepare("SELECT * FROM link_tools WHERE owner_id = ? ORDER BY link_id")
    .all(owner),
});
const toolRow = (world: World, id: string) =>
  world.links
    .prepare(
      "SELECT status, source, since, answered_at, wait_days FROM link_tools WHERE link_id = ?",
    )
    .get(Number(id)) ?? null;
/** A row as the page sends it back. */
const wire = (t: ToolRecord) => ({
  status: t.status,
  source: t.source,
  since: t.since.toISOString(),
  answeredAt: t.answeredAt?.toISOString() ?? null,
  waitDays: t.waitDays,
});

async function tools(title = "School attendance") {
  const world = await oauthWorld();
  const { link } = await saveLink(linkDeps(world), A, {
    url: "https://a.example/attendance",
    savedBy: "seed",
    title,
  });
  const browser = await signedIn(world);
  return { world, browser, id: link.id };
}

async function signedIn(world: World) {
  const browser = world.agent();
  await browser.signIn();
  return browser;
}

const post = (json: unknown) => ({ method: "POST", json });
type Moved = { tool: ReturnType<typeof wire>; previous: ReturnType<typeof wire> | null };

describe("POST /tools/keep", () => {
  it("keeps the link as stated with the first wait, answering the row it wrote and none before: 200, uncached", async () => {
    const { world, browser, id } = await tools();
    const res = await browser.send("/tools/keep", post({ id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = res.body as Moved;
    expect(body).toEqual({
      tool: {
        status: "kept",
        source: "stated",
        since: expect.any(String),
        answeredAt: null,
        waitDays: 30,
      },
      previous: null,
    });
    expect(toolRow(world, id)).toEqual({
      status: "kept",
      source: "stated",
      since: Date.parse(body.tool.since),
      answered_at: null,
      wait_days: 30,
    });
  });

  it("keeps a declined link, answering the declined row it replaced", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(5)), A, id, "stated");
    const declined = await notHandy(at(world, daysAgo(4)), A, id, "stated");
    const res = await browser.send("/tools/keep", post({ id }));
    expect(res.status).toBe(200);
    expect((res.body as Moved).previous).toEqual(wire(declined.tool));
    expect(toolRow(world, id)).toMatchObject({ status: "kept", source: "stated", wait_days: 30 });
  });

  it("answers 404 in the page's own words for a link that is gone, writing no row", async () => {
    const { world, browser } = await tools();
    const res = await browser.send("/tools/keep", post({ id: "999999" }));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "not_found", message: "That link is gone. Reload the page." });
    expect(world.links.prepare("SELECT count(*) AS n FROM link_tools").get()).toEqual({ n: 0 });
  });
});

describe("POST /tools/not-handy", () => {
  it("declines a kept tool as stated, answering the kept row it replaced", async () => {
    const { world, browser, id } = await tools();
    const kept = await keepHandy(at(world, daysAgo(3)), A, id, "stated");
    const res = await browser.send("/tools/not-handy", post({ id }));
    expect(res.status).toBe(200);
    const body = res.body as Moved;
    expect(body.previous).toEqual(wire(kept.tool));
    expect(body.tool).toMatchObject({ status: "declined", source: "stated", waitDays: 30 });
    expect(toolRow(world, id)).toMatchObject({ status: "declined", source: "stated" });
  });
});

describe("POST /tools/still-using", () => {
  it("answered while due with no opening, doubles the wait, records the answer and keeps the row's source", async () => {
    const { world, browser, id } = await tools();
    const kept = await keepHandy(at(world, daysAgo(31)), A, id, "stated");
    const res = await browser.send("/tools/still-using", post({ id }));
    expect(res.status).toBe(200);
    const body = res.body as Moved;
    expect(body.previous).toEqual(wire(kept.tool));
    expect(body.tool).toMatchObject({ status: "kept", source: "stated", waitDays: 60 });
    expect(toolRow(world, id)).toMatchObject({
      wait_days: 60,
      answered_at: Date.parse(body.tool.answeredAt as string),
    });
  });

  it("on a link that is not kept is a 409 in the page's words, writing no row", async () => {
    const { world, browser, id } = await tools();
    const res = await browser.send("/tools/still-using", post({ id }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "conflict",
      message: "That link's Keep handy state changed. Reload the page.",
    });
    expect(toolRow(world, id)).toBeNull();
  });
});

describe("POST /tools/suggestion", () => {
  it("Yes keeps a suggested link as asked, No declines it as asked", async () => {
    for (const [keep, status] of [
      [true, "kept"],
      [false, "declined"],
    ] as const) {
      const { world, browser, id } = await tools();
      const suggested = await keepHandy(at(world, daysAgo(2)), A, id, "inferred");
      const res = await browser.send("/tools/suggestion", post({ id, keep }));
      expect(res.status).toBe(200);
      expect((res.body as Moved).previous).toEqual(wire(suggested.tool));
      expect(toolRow(world, id)).toMatchObject({ status, source: "asked", wait_days: 30 });
    }
  });

  it("on a link with no suggestion is a 409, leaving its row", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(2)), A, id, "stated");
    const before = toolRow(world, id);
    const res = await browser.send("/tools/suggestion", post({ id, keep: false }));
    expect(res.status).toBe(409);
    expect(toolRow(world, id)).toEqual(before);
  });

  it("refuses a keep that is not a boolean, and every row stays", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(2)), A, id, "inferred");
    const before = allRows(world);
    for (const keep of ["yes", 1, null, undefined]) {
      const res = await browser.send("/tools/suggestion", post({ id, keep }));
      expect(res.status, String(keep)).toBe(400);
    }
    expect(allRows(world)).toEqual(before);
  });
});

/** Each POST, with the seed of A's link it acts on; the seed returns the request's body. */
const ROUTES: [string, (world: World, id: string) => Promise<Record<string, unknown>>][] = [
  ["/tools/keep", async (_, id) => ({ id })],
  [
    "/tools/not-handy",
    async (world, id) => {
      await keepHandy(at(world, daysAgo(3)), A, id, "stated");
      return { id };
    },
  ],
  [
    "/tools/still-using",
    async (world, id) => {
      await keepHandy(at(world, daysAgo(31)), A, id, "stated");
      return { id };
    },
  ],
  [
    "/tools/suggestion",
    async (world, id) => {
      await keepHandy(at(world, daysAgo(2)), A, id, "inferred");
      return { id, keep: true };
    },
  ],
  [
    "/tools/undo",
    async (world, id) => {
      const kept = await keepHandy(at(world, daysAgo(1)), A, id, "stated");
      return { id, tool: wire(kept.tool), previous: null };
    },
  ],
];

describe.each(ROUTES)("POST %s", (path, seed) => {
  it("acts for the signed-in owner only: B naming A's link gets 404 and A's rows are unchanged", async () => {
    const { world, browser, id } = await tools();
    const body = await seed(world, id);
    const bBrowser = await addSecondUser(world);
    const before = ownedRows(world, A);
    const res = await bBrowser.send(path, post(body));
    expect(res.status).toBe(404);
    expect(ownedRows(world, A)).toEqual(before);
    // The same request from A is accepted, so B's 404 is down to whose link it is.
    expect((await browser.send(path, post(body))).status).toBeLessThan(300);
  });

  const OVER = "x".repeat(AUTH_BODY_LIMIT);
  it.each([
    ["without an Origin", (json: object) => ({ json, origin: false }), 403],
    [
      "with a foreign Origin",
      (json: object) => ({ json, headers: { origin: "https://evil.example" } }),
      403,
    ],
    ["without a session", (json: object) => ({ json, anonymous: true }), 302],
    [
      "with a body over the cap, before reading any session",
      (json: object) => ({ json: { ...json, pad: OVER }, anonymous: true }),
      413,
    ],
    ["with a body that is not JSON", () => ({ rawForm: "id=1" }), 400],
    ["without an id", () => ({ json: { keep: true } }), 400],
  ])("refuses a request %s, and every row stays", async (_, how, status) => {
    const { world, id } = await tools();
    const body = await seed(world, id);
    const before = allRows(world);
    const { anonymous, ...options } = how(body) as { anonymous?: true };
    const browser = anonymous ? world.agent() : await signedIn(world);
    const res = await browser.send(path, { method: "POST", ...options });
    expect(res.status).toBe(status);
    expect(allRows(world)).toEqual(before);
  });
});

describe("POST /tools/undo", () => {
  /** Sends the action, then its Undo with exactly the rows the action answered. */
  function roundTrip(path: string, extra: Record<string, unknown> = {}) {
    return async (world: World, browser: Awaited<ReturnType<typeof signedIn>>, id: string) => {
      const before = toolRow(world, id);
      const res = await browser.send(path, post({ id, ...extra }));
      expect(res.status).toBe(200);
      const moved = res.body as Moved;
      const undo = await browser.send("/tools/undo", post({ id, ...moved }));
      expect(undo.status).toBe(204);
      expect(undo.headers.get("cache-control")).toBe("no-store");
      expect(toolRow(world, id)).toEqual(before);
      return moved;
    };
  }

  it("restores an asked row with a 60-day wait and a recorded answer after Still using it", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(100)), A, id, "asked");
    await stillUsing(at(world, daysAgo(65)), A, id, "asked"); // due at 35 days: wait 30 → 60
    const moved = await roundTrip("/tools/still-using")(world, browser, id);
    expect(moved.previous).toMatchObject({
      source: "asked",
      waitDays: 60,
      answeredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(moved.tool.waitDays).toBe(120); // due again at 65 days: 60 → 120
  });

  it("restores an asked row with a 120-day wait and a recorded answer after Not handy anymore", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(300)), A, id, "asked");
    await stillUsing(at(world, daysAgo(260)), A, id, "asked"); // 40 days: 30 → 60
    const answered = await stillUsing(at(world, daysAgo(190)), A, id, "asked"); // 70: 60 → 120
    expect(answered.tool).toMatchObject({ waitDays: 120, source: "asked" });
    const moved = await roundTrip("/tools/not-handy")(world, browser, id);
    expect(moved.previous).toEqual(wire(answered.tool));
  });

  it("removes the row again after a first keep, whose previous is null", async () => {
    const { world, browser, id } = await tools();
    const moved = await roundTrip("/tools/keep")(world, browser, id);
    expect(moved.previous).toBeNull();
    expect(toolRow(world, id)).toBeNull();
  });

  it("puts a suggestion back, as inferred, after No", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(2)), A, id, "inferred");
    await roundTrip("/tools/suggestion", { keep: false })(world, browser, id);
    expect(toolRow(world, id)).toMatchObject({ status: "suggested", source: "inferred" });
  });

  it("undo after an AI changed the row is a 409 in the page's words, and the AI's row stays", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(3)), A, id, "stated");
    const moved = (await browser.send("/tools/not-handy", post({ id }))).body as Moved;
    await keepHandy(linkDeps(world), A, id, "asked");
    const ai = toolRow(world, id);
    const res = await browser.send("/tools/undo", post({ id, ...moved }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "conflict",
      message: "That link's Keep handy state changed. Reload the page.",
    });
    expect(toolRow(world, id)).toEqual(ai);
  });

  it("refuses a previous row no action could write with a 400, leaving the row", async () => {
    const { world, browser, id } = await tools();
    const kept = await keepHandy(at(world, daysAgo(1)), A, id, "stated");
    const before = toolRow(world, id);
    const future = new Date(Date.now() + DAY).toISOString();
    for (const previous of [
      { ...wire(kept.tool), source: "inferred" },
      { ...wire(kept.tool), status: "suggested", source: "stated" },
      { ...wire(kept.tool), since: future },
    ]) {
      const res = await browser.send("/tools/undo", post({ id, tool: wire(kept.tool), previous }));
      expect(res.status, JSON.stringify(previous)).toBe(400);
      expect(res.body).toEqual({
        code: "invalid_input",
        message: "That can't be undone. Reload the page.",
      });
    }
    expect(toolRow(world, id)).toEqual(before);
  });

  it("refuses a body whose rows are missing, mistyped or out of range, before core, and every row stays", async () => {
    const { world, browser, id } = await tools();
    const kept = await keepHandy(at(world, daysAgo(1)), A, id, "stated");
    const tool = wire(kept.tool);
    const before = allRows(world);
    const bad: Record<string, unknown>[] = [
      { tool: undefined },
      { tool: null },
      { previous: undefined },
      { previous: "null" },
      { previous: {} },
      { tool: { ...tool, status: "archived" } },
      { tool: { ...tool, source: "guessed" } },
      { tool: { ...tool, waitDays: 45 } },
      { tool: { ...tool, waitDays: "30" } },
      { tool: { ...tool, since: "soon" } },
      { tool: { ...tool, since: undefined } },
      { tool: { ...tool, answeredAt: "soon" } },
      { tool: { ...tool, answeredAt: undefined } },
      { previous: { ...tool, waitDays: 0 } },
    ];
    for (const change of bad) {
      const res = await browser.send("/tools/undo", post({ id, tool, previous: null, ...change }));
      expect(res.status, JSON.stringify(change)).toBe(400);
      expect(res.body).toEqual({
        code: "BAD_REQUEST",
        message: "Send a JSON body with id and tool and previous.",
      });
    }
    expect(allRows(world)).toEqual(before);
  });
});

describe("Keep handy on the pages that list links", () => {
  const visible = (html: string, id: string) => {
    const c = parseHTML(html).document.querySelector(`[data-id="${id}"] [data-handy]`);
    const keep = c?.querySelector("button[data-act=keep]") as HTMLElement | undefined;
    return keep ? (keep.hidden ? "kept" : "keep") : null;
  };

  it("search, All links and the space page show a kept link as kept, and another as Keep handy", async () => {
    const { world, browser, id } = await tools();
    const deps = linkDeps(world);
    const { link: other } = await saveLink(deps, A, {
      url: "https://a.example/lunch",
      savedBy: "seed",
      title: "Lunch order",
    });
    for (const linkId of [id, other.id]) {
      await updateLink(deps, A, linkId, { tags: [{ name: "School", source: "stated" }] });
    }
    expect((await browser.send("/tools/keep", post({ id }))).status).toBe(200);
    for (const path of ["/search?q=", "/all", "/spaces?tag=School"]) {
      const html = String((await browser.send(path)).body);
      expect(visible(html, id), path).toBe("kept");
      expect(visible(html, other.id), path).toBe("keep");
    }
  });
});

describe("GET / and the Handy shelf", () => {
  const shelf = (html: string) =>
    [...parseHTML(html).document.querySelectorAll("#handy-shelf .handy-tile")] as HTMLElement[];

  it("shows a due tool first, then kept tools most recently opened first, then never opened newest kept first, 8 before Show all", async () => {
    const world = await oauthWorld();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { link } = await saveLink(linkDeps(world), A, {
        url: `https://a.example/t${i}`,
        savedBy: "seed",
        title: `Tool ${i}`,
      });
      await keepHandy(at(world, daysAgo(20 - i)), A, link.id, "stated");
      ids.push(link.id);
    }
    await recordOpening(at(world, daysAgo(2)), A, ids[3] as string);
    await recordOpening(at(world, daysAgo(1)), A, ids[7] as string);
    const { link: stale } = await saveLink(linkDeps(world), A, {
      url: "https://a.example/stale",
      savedBy: "seed",
      title: "Old tool",
    });
    await keepHandy(at(world, daysAgo(40)), A, stale.id, "stated");
    const html = String((await (await signedIn(world)).send("/")).body);
    const tiles = shelf(html);
    expect(tiles.map((t) => t.dataset.id)).toEqual([
      stale.id,
      ...[7, 3, 9, 8, 6, 5, 4, 2, 1, 0].map((i) => ids[i]),
    ]);
    expect(tiles.map((t) => t.hidden)).toEqual([...Array(8).fill(false), true, true, true]);
    expect(tiles[0]?.classList.contains("needs-you")).toBe(true);
    const main = parseHTML(html).document.querySelector("main.home") as HTMLElement;
    expect([...main.children].map((c) => c.className)).toEqual(["home-search", "handy", "spaces"]);
  });

  it("marks a tool kept 31 days ago and never opened as due, and puts a suggestion at the end", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(31)), A, id, "stated");
    const { link: offer } = await saveLink(linkDeps(world), A, {
      url: "https://a.example/form",
      savedBy: "seed",
      title: "Lunch form",
    });
    await keepHandy(at(world, daysAgo(1)), A, offer.id, "inferred");
    const tiles = shelf(String((await browser.send("/")).body));
    expect(tiles.map((t) => t.dataset.id)).toEqual([id, offer.id]);
    expect(tiles[0]?.classList.contains("needs-you")).toBe(true);
    expect(tiles[0]?.textContent).toContain("Still using?");
    expect(tiles[1]?.classList.contains("guess")).toBe(true);
  });

  it("shows a tool whose link seems gone first, with the gone ask in place of Still using?", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(31)), A, id, "stated");
    const { link: other } = await saveLink(linkDeps(world), A, {
      url: "https://a.example/other",
      savedBy: "seed",
      title: "Other tool",
    });
    await keepHandy(at(world, daysAgo(40)), A, other.id, "stated");
    await linkDeps(world).checks.updateCheckIf(A, id, null, {
      checkedAt: daysAgo(1),
      result: "dead",
      detail: "http:404",
      firstDeadAt: daysAgo(20),
      flaggedAt: daysAgo(10),
      stillWorksAt: null,
    });
    const tiles = shelf(String((await browser.send("/")).body));
    expect(tiles.map((t) => t.dataset.id)).toEqual([id, other.id]);
    expect(tiles[0]?.classList.contains("needs-you")).toBe(true);
    expect(tiles[0]?.textContent).toContain("This page seems gone");
    expect(tiles[0]?.textContent).not.toContain("Still using?");
    expect(tiles[1]?.textContent).toContain("Still using?");
  });

  it("Done archives: the tool leaves the shelf and Undo brings it back, its Keep handy row untouched", async () => {
    const { world, browser, id } = await tools();
    await keepHandy(at(world, daysAgo(31)), A, id, "stated");
    const row = toolRow(world, id);
    expect((await browser.send("/home/archive", post({ id }))).status).toBe(204);
    expect(shelf(String((await browser.send("/")).body))).toHaveLength(0);
    expect(toolRow(world, id)).toEqual(row);
    expect((await browser.send("/home/unarchive", post({ id }))).status).toBe(204);
    expect(shelf(String((await browser.send("/")).body)).map((t) => t.dataset.id)).toEqual([id]);
    expect(toolRow(world, id)).toEqual(row);
  });

  it("an empty shelf shows its one line, and looking at home with a shelf leaves every row byte-identical", async () => {
    const { world, browser, id } = await tools();
    expect(String((await browser.send("/")).body)).toContain("Keep links you use often here");
    await keepHandy(at(world, daysAgo(31)), A, id, "stated");
    const before = allRows(world);
    expect((await browser.send("/")).status).toBe(200);
    expect(allRows(world)).toEqual(before);
  });
});
