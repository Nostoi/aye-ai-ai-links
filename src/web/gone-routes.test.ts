import { describe, expect, it } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { addSecondUser, allRows, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import type { LinkCheck } from "../core/link-check-store.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const DAY = 86_400_000;
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** A flagged row: dead for 20 days, flagged 10 days ago. */
const flagged = (): LinkCheck => ({
  checkedAt: daysAgo(1),
  result: "dead",
  detail: "http:404",
  firstDeadAt: daysAgo(20),
  flaggedAt: daysAgo(10),
  stillWorksAt: null,
});
/** A row as the page sends it back. */
const wire = (c: LinkCheck) => ({
  checkedAt: c.checkedAt.toISOString(),
  result: c.result,
  detail: c.detail,
  firstDeadAt: c.firstDeadAt?.toISOString() ?? null,
  flaggedAt: c.flaggedAt?.toISOString() ?? null,
  stillWorksAt: c.stillWorksAt?.toISOString() ?? null,
});

/** A's links and check rows: what another owner's request must leave alone. */
const ownedRows = (world: World, owner: string) => ({
  links: world.links.prepare("SELECT * FROM links WHERE owner_id = ? ORDER BY id").all(owner),
  checks: world.links
    .prepare("SELECT * FROM link_checks WHERE owner_id = ? ORDER BY link_id")
    .all(owner),
});
const checkRow = (world: World, id: string) =>
  world.links.prepare("SELECT * FROM link_checks WHERE link_id = ?").get(Number(id)) ?? null;

async function signedIn(world: World) {
  const browser = world.agent();
  await browser.signIn();
  return browser;
}

/** A signed-in browser and A's link, with `row` as its check row when given. */
async function gone(row: LinkCheck | null = flagged()) {
  const world = await oauthWorld();
  const deps = linkDeps(world);
  const { link } = await saveLink(deps, A, {
    url: "https://a.example/page",
    savedBy: "seed",
    title: "Old page",
  });
  if (row) await deps.checks.updateCheckIf(A, link.id, null, row);
  return { world, deps, browser: await signedIn(world), id: link.id };
}

const post = (json: unknown) => ({ method: "POST", json });
type Moved = { check: ReturnType<typeof wire>; previous: ReturnType<typeof wire> };

describe("POST /links/still-works", () => {
  it("clears the flag and the streak and records when, answering the rows for Undo: 200, uncached", async () => {
    const { world, browser, id } = await gone();
    const res = await browser.send("/links/still-works", post({ id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = res.body as Moved;
    expect(body.previous).toMatchObject({ result: "dead", detail: "http:404" });
    expect(body.previous.flaggedAt).toEqual(expect.any(String));
    expect(body.check).toMatchObject({ firstDeadAt: null, flaggedAt: null });
    expect(body.check.stillWorksAt).toEqual(expect.any(String));
    expect(checkRow(world, id)).toMatchObject({
      first_dead_at: null,
      flagged_at: null,
      still_works_at: Date.parse(body.check.stillWorksAt as string),
    });
  });

  it("on a link that is not marked gone is a 409 with core's words, leaving the row", async () => {
    const alive: LinkCheck = {
      ...flagged(),
      result: "alive",
      detail: null,
      firstDeadAt: null,
      flaggedAt: null,
    };
    const { world, browser, id } = await gone(alive);
    const before = checkRow(world, id);
    const res = await browser.send("/links/still-works", post({ id }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "conflict",
      message: "This link isn't marked as gone. Reload the page.",
    });
    expect(checkRow(world, id)).toEqual(before);
  });

  it("answers 404 in the page's own words for a link that is gone", async () => {
    const { browser } = await gone(null);
    const res = await browser.send("/links/still-works", post({ id: "999999" }));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "not_found", message: "That link is gone. Reload the page." });
  });
});

describe("POST /links/still-works/undo", () => {
  async function stillWorked() {
    const world = await gone();
    const res = await world.browser.send("/links/still-works", post({ id: world.id }));
    return { ...world, moved: res.body as Moved };
  }

  it("puts the flag, the streak and the old answer back: 204, uncached", async () => {
    const { world, browser, id, moved } = await stillWorked();
    const res = await browser.send("/links/still-works/undo", post({ id, ...moved }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(checkRow(world, id)).toMatchObject({
      first_dead_at: Date.parse(moved.previous.firstDeadAt as string),
      flagged_at: Date.parse(moved.previous.flaggedAt as string),
      still_works_at: null,
    });
  });

  it("after a check in between is a 409 with core's words, and the check's row stays", async () => {
    const { world, deps, browser, id, moved } = await stillWorked();
    const current = await deps.checks.getCheck(A, id);
    const newer = { ...(current as LinkCheck), checkedAt: new Date(), result: "unknown" as const };
    await deps.checks.updateCheckIf(A, id, current, newer);
    const after = checkRow(world, id);
    const res = await browser.send("/links/still-works/undo", post({ id, ...moved }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "conflict",
      message: "This link was checked since, so it stays as it is.",
    });
    expect(checkRow(world, id)).toEqual(after);
  });

  it("refuses a previous row no check could have left with a 400, leaving the row", async () => {
    const { world, browser, id, moved } = await stillWorked();
    const before = checkRow(world, id);
    const previous = { ...moved.previous, flaggedAt: null };
    const res = await browser.send(
      "/links/still-works/undo",
      post({ id, check: moved.check, previous }),
    );
    expect(res.status).toBe(400);
    expect(checkRow(world, id)).toEqual(before);
  });

  it("refuses a body whose rows are missing or mistyped, before core, and every row stays", async () => {
    const { world, browser, id, moved } = await stillWorked();
    const before = allRows(world);
    const bad: Record<string, unknown>[] = [
      { check: undefined },
      { check: null },
      { previous: undefined },
      { previous: null },
      { previous: {} },
      { check: { ...moved.check, result: "missing" } },
      { check: { ...moved.check, detail: 5 } },
      { check: { ...moved.check, checkedAt: "soon" } },
      { check: { ...moved.check, checkedAt: undefined } },
      { check: { ...moved.check, firstDeadAt: "soon" } },
      { previous: { ...moved.previous, flaggedAt: undefined } },
      { previous: { ...moved.previous, stillWorksAt: "soon" } },
    ];
    for (const change of bad) {
      const res = await browser.send("/links/still-works/undo", post({ id, ...moved, ...change }));
      expect(res.status, JSON.stringify(change)).toBe(400);
      expect(res.body).toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(allRows(world)).toEqual(before);
  });
});

type Seed = (world: World, id: string) => Promise<object>;
const ROUTES: [string, Seed][] = [
  ["/links/still-works", async (_, id) => ({ id })],
  [
    "/links/still-works/undo",
    async (world, id) => {
      const deps = linkDeps(world);
      const current = (await deps.checks.getCheck(A, id)) as LinkCheck;
      const next = { ...current, flaggedAt: null, firstDeadAt: null };
      await deps.checks.updateCheckIf(A, id, current, next);
      return { id, check: wire(next), previous: wire(current) };
    },
  ],
];

describe.each(ROUTES)("POST %s", (path, seed) => {
  it("acts for the signed-in owner only: B naming A's link gets 404 and A's rows are unchanged", async () => {
    const { world, browser, id } = await gone();
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
    const { world, id } = await gone();
    const body = await seed(world, id);
    const before = allRows(world);
    const { anonymous, ...options } = how(body) as { anonymous?: true };
    const browser = anonymous ? world.agent() : await signedIn(world);
    const res = await browser.send(path, { method: "POST", ...options });
    expect(res.status).toBe(status);
    expect(allRows(world)).toEqual(before);
  });
});
