import { describe, expect, it } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { addSecondUser, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink, updateLink } from "../core/links.js";
import type { Labelled, LinkPatch } from "../core/types.js";
import { SNOOZE_MS } from "../core/worth-a-look.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));

/** Every row of every table, so a request can be shown to have changed nothing at all. */
const allRows = (world: World) => {
  const tables = world.links
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [name, world.links.prepare(`SELECT * FROM "${name}"`).all()]),
  );
};
const ownedRows = (world: World, owner: string) =>
  world.links.prepare("SELECT * FROM links WHERE owner_id = ? ORDER BY id").all(owner);
const row = (world: World, id: string) =>
  world.links.prepare("SELECT * FROM links WHERE id = ?").get(Number(id)) as Record<
    string,
    unknown
  >;

async function home(why: Labelled | null = null) {
  const world = await oauthWorld();
  const { link } = await saveLink(linkDeps(world), A, {
    url: "https://a.example/home-card",
    savedBy: "seed",
    title: "A's home card",
    why,
  });
  const browser = world.agent();
  await browser.signIn();
  return { world, browser, id: link.id };
}

const post = (json: unknown) => ({ method: "POST", json });

describe("GET /", () => {
  it("shows the owner's pick with its buttons", async () => {
    const { browser, id } = await home();
    const res = await browser.send("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = String(res.body);
    expect(html).toContain("Worth a look today");
    expect(html).toContain("A&#39;s home card");
    expect(html).toContain(`data-id="${id}"`);
    expect(html).toContain("Tell me why");
  });

  it("twice leaves every row byte-identical", async () => {
    const { world, browser } = await home();
    const before = allRows(world);
    expect((await browser.send("/")).status).toBe(200);
    expect((await browser.send("/")).status).toBe(200);
    expect(allRows(world)).toEqual(before);
  });
});

describe("the home card actions", () => {
  it("/home/opened records the opening and the surfacing: 204, uncached", async () => {
    const { world, browser, id } = await home();
    const res = await browser.send("/home/opened", post({ id }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(row(world, id).last_opened_at).toEqual(expect.any(Number));
    expect(row(world, id).last_surfaced_at).toEqual(row(world, id).last_opened_at);
    expect(world.links.prepare("SELECT count(*) AS n FROM search_log").get()).toEqual({ n: 0 });
  });

  it("/home/snooze marks it surfaced and snoozes two weeks, answering when; /home/unsnooze reverses the snooze", async () => {
    const { world, browser, id } = await home();
    const res = await browser.send("/home/snooze", post({ id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const until = (res.body as { until: string }).until;
    const r = row(world, id);
    expect(r.snoozed_until).toBe(Date.parse(until));
    expect(r.snoozed_until).toBe((r.last_surfaced_at as number) + SNOOZE_MS);
    expect(String((await browser.send("/")).body)).not.toContain("Worth a look today");
    const back = await browser.send("/home/unsnooze", post({ id, until }));
    expect(back.status).toBe(204);
    expect(row(world, id).snoozed_until).toBeNull();
  });

  it("/home/unsnooze after an AI changed the snooze is a 409 and leaves the AI's value", async () => {
    const { world, browser, id } = await home();
    const { until } = (await browser.send("/home/snooze", post({ id }))).body as { until: string };
    const ai = new Date(Date.parse(until) + 86_400_000);
    await updateLink(linkDeps(world), A, id, { snoozedUntil: ai });
    const res = await browser.send("/home/unsnooze", post({ id, until }));
    expect(res.status).toBe(409);
    expect(row(world, id).snoozed_until).toBe(ai.getTime());
  });

  it("/home/snooze after an AI snoozed the link is a 409, leaving its snooze and surfacing as they were", async () => {
    const { world, browser, id } = await home();
    await browser.send("/");
    const ai = new Date(Date.now() + 3 * 86_400_000);
    await updateLink(linkDeps(world), A, id, { snoozedUntil: ai });
    const before = row(world, id);
    const res = await browser.send("/home/snooze", post({ id }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ message: "This link is already put off. Reload." });
    expect(row(world, id)).toEqual(before);
    expect(before).toMatchObject({ snoozed_until: ai.getTime(), last_surfaced_at: null });
  });

  it("/home/archive archives it and /home/unarchive makes it active again; a second undo is a 409", async () => {
    const { world, browser, id } = await home();
    expect((await browser.send("/home/archive", post({ id }))).status).toBe(204);
    expect(row(world, id).state).toBe("archived");
    expect((await browser.send("/home/unarchive", post({ id }))).status).toBe(204);
    expect(row(world, id).state).toBe("active");
    expect((await browser.send("/home/unarchive", post({ id }))).status).toBe(409);
  });

  it("/home/archive after an AI archived the link is a 409, changing nothing", async () => {
    const { world, browser, id } = await home();
    await browser.send("/");
    await updateLink(linkDeps(world), A, id, { state: "archived" });
    const before = row(world, id);
    const res = await browser.send("/home/archive", post({ id }));
    expect(res.status).toBe(409);
    expect(row(world, id)).toEqual(before);
  });

  it("/home/why records the owner's answer as asked, over an agent's guess", async () => {
    const { world, browser, id } = await home({ text: "a guess", source: "inferred" });
    const res = await browser.send("/home/why", post({ id, text: " to compare " }));
    expect(res.status).toBe(204);
    expect(row(world, id)).toMatchObject({ why_text: "to compare", why_source: "asked" });
  });

  it("/home/why refuses blank text with 400 and a stated why with 409, changing nothing", async () => {
    const blank = await home({ text: "a guess", source: "inferred" });
    const before = ownedRows(blank.world, A);
    const res = await blank.browser.send("/home/why", post({ id: blank.id, text: "  " }));
    expect(res.status).toBe(400);
    expect(ownedRows(blank.world, A)).toEqual(before);

    const said = await home({ text: "mine", source: "stated" });
    const kept = ownedRows(said.world, A);
    const conflict = await said.browser.send("/home/why", post({ id: said.id, text: "new" }));
    expect(conflict.status).toBe(409);
    expect((conflict.body as { message: string }).message).toBe(
      "This link already has a reason. Reload.",
    );
    expect(ownedRows(said.world, A)).toEqual(kept);
  });

  it("answers 404 with the page's own words for a link that is gone", async () => {
    const { browser } = await home();
    const res = await browser.send("/home/archive", post({ id: "999999" }));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "not_found", message: "That link is gone. Reload the page." });
  });
});

/** A snooze the two-owner test seeds, which the unsnooze body names. */
const SEED_UNTIL = new Date("2030-01-01T00:00:00.000Z");

/** Each POST, with a body naming the card's link, and the state of A's link it acts on. */
const ROUTES: [string, (id: string) => Record<string, unknown>, LinkPatch][] = [
  ["/home/opened", (id) => ({ id }), {}],
  ["/home/snooze", (id) => ({ id }), {}],
  [
    "/home/unsnooze",
    (id) => ({ id, until: SEED_UNTIL.toISOString() }),
    { snoozedUntil: SEED_UNTIL },
  ],
  ["/home/archive", (id) => ({ id }), {}],
  ["/home/unarchive", (id) => ({ id }), { state: "archived" }],
  ["/home/why", (id) => ({ id, text: "because" }), {}],
];

describe.each(ROUTES)("POST %s", (path, body, seed) => {
  it("acts for the signed-in owner only: B naming A's link gets 404 and A's rows are unchanged", async () => {
    const { world, browser, id } = await home();
    await updateLink(linkDeps(world), A, id, seed);
    const bBrowser = await addSecondUser(world);
    const before = ownedRows(world, A);
    const res = await bBrowser.send(path, post(body(id)));
    expect(res.status).toBe(404);
    expect(ownedRows(world, A)).toEqual(before);
    // The same request from A is accepted, so B's 404 is down to whose link it is.
    expect((await browser.send(path, post(body(id)))).status).toBeLessThan(300);
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
    ["without an id", () => ({ json: { text: "x", until: new Date().toISOString() } }), 400],
  ])("refuses a request %s, and every row stays", async (_, how, status) => {
    const { world, id } = await home();
    const before = allRows(world);
    const { anonymous, ...options } = how(body(id)) as { anonymous?: true };
    const browser = anonymous ? world.agent() : await signedIn(world);
    const res = await browser.send(path, { method: "POST", ...options });
    expect(res.status).toBe(status);
    expect(allRows(world)).toEqual(before);
  });
});

it("POST /home/unsnooze refuses an until that is not a date, and /home/why a text that is not a string", async () => {
  const { world, browser, id } = await home();
  const before = allRows(world);
  expect((await browser.send("/home/unsnooze", post({ id, until: "soon" }))).status).toBe(400);
  expect((await browser.send("/home/why", post({ id, text: 7 }))).status).toBe(400);
  expect(allRows(world)).toEqual(before);
});

async function signedIn(world: World) {
  const browser = world.agent();
  await browser.signIn();
  return browser;
}
