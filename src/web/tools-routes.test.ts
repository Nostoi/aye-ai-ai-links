import { describe, expect, it } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { addSecondUser, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import type { ToolRecord } from "../core/tool-store.js";
import { keepHandy, notHandy } from "../core/tools.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const DAY = 86_400_000;
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
/** The deps with the clock at `when`, to seed the rows a past action wrote. */
const at = (world: World, when: Date) => ({ ...linkDeps(world), now: () => when });
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** Every row of every table, so a request can be shown to have changed nothing at all. */
const allRows = (world: World) => {
  const tables = world.links
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [name, world.links.prepare(`SELECT * FROM "${name}"`).all()]),
  );
};
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
