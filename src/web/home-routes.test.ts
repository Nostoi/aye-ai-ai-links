import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { addSecondUser, allRows, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink, updateLink } from "../core/links.js";
import { keepHandy } from "../core/tools.js";
import type { Labelled, LinkPatch } from "../core/types.js";
import { SNOOZE_MS } from "../core/worth-a-look.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { SqliteImageStore } from "../store/sqlite-image-store.js";
import { SHELF_SIZE } from "./handy-shelf.js";

const A = "owner";
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));

const ownedRows = (world: World, owner: string) =>
  world.links.prepare("SELECT * FROM links WHERE owner_id = ? ORDER BY id").all(owner);
const row = (world: World, id: string) =>
  world.links.prepare("SELECT * FROM links WHERE id = ?").get(Number(id)) as Record<
    string,
    unknown
  >;

const eventKinds = (world: World, id: string) =>
  (
    world.links
      .prepare("SELECT kind FROM link_events WHERE link_id = ? ORDER BY at, rowid")
      .all(Number(id)) as { kind: string }[]
  ).map((e) => e.kind);

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
    expect(html).toContain(">Explore</h2>");
    expect(html).toContain("A&#39;s home card");
    expect(html).toContain(`data-id="${id}"`);
    expect(html).toContain("Tell me why");
  });

  it("colors a pick by the owner's pinned space", async () => {
    const world = await oauthWorld();
    const deps = linkDeps(world);
    const { link } = await saveLink(deps, A, {
      url: "https://a.example/kitchen-card",
      savedBy: "seed",
      tags: [{ name: "Kitchen", source: "stated" }],
    });
    await deps.store.pinTag(A, "kitchen", { pinned: true, color: "clay" });
    const browser = world.agent();
    await browser.signIn();
    const html = String((await browser.send("/")).body);
    expect(html).toMatch(
      new RegExp(`class="worth-card worth-feature[^"]* space-clay" data-id="${link.id}"`),
    );
  });

  it("shows no link on a space card that Home shows above it: kept (even behind Show all), suggested or picked (#303)", async () => {
    const world = await oauthWorld();
    const deps = linkDeps(world);
    const mk = async (n: string) =>
      (
        await saveLink(deps, A, {
          url: `https://a.example/${n}`,
          savedBy: "seed",
          title: `Card ${n}`,
          tags: [{ name: "Kitchen", source: "stated" }],
        })
      ).link.id;
    // More kept links than the shelf shows at once, so some sit behind Show all.
    const kept: string[] = [];
    for (let i = 0; i < SHELF_SIZE + 2; i++) kept.push(await mk(`kept${i}`));
    for (const id of kept) await keepHandy(deps, A, id, "stated");
    const suggested = await mk("suggested");
    await keepHandy(deps, A, suggested, "inferred");
    const picked = await mk("picked");
    await deps.store.pinTag(A, "kitchen", { pinned: true, color: "clay" });
    const browser = world.agent();
    await browser.signIn();
    const html = String((await browser.send("/")).body);
    const spaces = html.slice(html.indexOf('<section class="spaces"'));
    expect(html).toContain(`data-id="${picked}"`);
    expect(spaces).toContain("home-space-name");
    for (const id of [...kept, suggested, picked]) {
      expect(spaces).not.toContain(`data-id="${id}"`);
    }
  });

  it("refuses another site's Origin or Host with 403, showing no card; a plain GET still shows it", async () => {
    const { browser } = await home();
    const foreign: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { host: "evil.example" },
    ];
    for (const headers of foreign) {
      const res = await browser.send("/", { headers });
      expect(res.status).toBe(403);
      expect(String(res.body)).not.toContain("A&#39;s home card");
    }
    const plain = await browser.send("/", { origin: false });
    expect(plain.status).toBe(200);
    expect(String(plain.body)).toContain("A&#39;s home card");
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
  it("the address Home's own script posts an opening to records the opening and nothing else, and the card stays with its opened line (#340)", async () => {
    const { world, browser, id } = await home();
    const html = String((await browser.send("/")).body);
    const at = html.indexOf('const openRoot = document.getElementById("worth-cards");');
    expect(at).toBeGreaterThan(-1);
    const address = html.slice(at).match(/fetch\("([^"]+)"/)?.[1] as string;
    expect(address).toBe("/links/opened");
    const before = row(world, id);
    const res = await browser.send(address, post({ id }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(row(world, id)).toEqual({ ...before, last_opened_at: expect.any(Number) });
    expect(row(world, id).last_surfaced_at).toBeNull();
    const again = String((await browser.send("/")).body);
    expect(again).toContain(`data-id="${id}"`);
    expect(again).toMatch(/<p class="opened" data-opened>/);
    expect(world.links.prepare("SELECT count(*) AS n FROM search_log").get()).toEqual({ n: 0 });
  });

  it("/home/opened is gone: a 404 that changes nothing", async () => {
    const { world, browser, id } = await home();
    const before = allRows(world);
    expect((await browser.send("/home/opened", post({ id }))).status).toBe(404);
    expect(allRows(world)).toEqual(before);
  });

  it("/links/opened, from any other page, records the opening only: not surfaced, not logged", async () => {
    const { world, browser, id } = await home();
    const res = await browser.send("/links/opened", post({ id }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(row(world, id).last_opened_at).toEqual(expect.any(Number));
    expect(row(world, id).last_surfaced_at).toBeNull();
    expect(world.links.prepare("SELECT count(*) AS n FROM search_log").get()).toEqual({ n: 0 });
  });

  it("/home/snooze snoozes two weeks and answers until; it writes no surfacing, and /home/unsnooze reverses it, so the card is back (#340)", async () => {
    const { world, browser, id } = await home();
    const res = await browser.send("/home/snooze", post({ id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const snooze = res.body as Record<string, string | null>;
    const r = row(world, id);
    expect(snooze).toEqual({
      until: new Date(r.snoozed_until as number).toISOString(),
      previous: null,
    });
    expect(r.snoozed_until as number).toBeGreaterThan(Date.now() + SNOOZE_MS - 60_000);
    expect(r.last_surfaced_at).toBeNull();
    expect(String((await browser.send("/")).body)).not.toContain(`data-id="${id}"`);
    const back = await browser.send("/home/unsnooze", post({ id, ...snooze }));
    expect(back.status).toBe(204);
    expect(row(world, id)).toMatchObject({ snoozed_until: null, last_surfaced_at: null });
    expect(String((await browser.send("/")).body)).toContain(`data-id="${id}"`);
  });

  it("/home/snooze on a link an agent snoozed far ahead answers the old date, and /home/unsnooze with it puts that date back exactly (#340)", async () => {
    const { world, browser, id } = await home();
    const far = new Date("2099-01-01T00:00:00.000Z");
    await updateLink(linkDeps(world), A, id, { snoozedUntil: far });
    const res = await browser.send("/home/snooze", post({ id }));
    expect(res.status).toBe(200);
    const snooze = res.body as { until: string; previous: string | null };
    expect(snooze.previous).toBe(far.toISOString());
    expect(row(world, id).snoozed_until).toBe(Date.parse(snooze.until));
    expect((await browser.send("/home/unsnooze", post({ id, ...snooze }))).status).toBe(204);
    expect(row(world, id).snoozed_until).toBe(far.getTime());
  });

  it("/home/unsnooze with no previous, as a tab loaded before #340 sends it, restores no snooze", async () => {
    const { world, browser, id } = await home();
    const { until } = (await browser.send("/home/snooze", post({ id }))).body as { until: string };
    expect(row(world, id).snoozed_until).toBe(Date.parse(until));
    expect((await browser.send("/home/unsnooze", post({ id, until }))).status).toBe(204);
    expect(row(world, id)).toMatchObject({ snoozed_until: null, last_surfaced_at: null });
  });

  it("/home/unsnooze after an AI changed the snooze is a 409 and leaves the AI's value", async () => {
    const { world, browser, id } = await home();
    const snooze = (await browser.send("/home/snooze", post({ id }))).body as { until: string };
    const ai = new Date(Date.parse(snooze.until) + 86_400_000);
    await updateLink(linkDeps(world), A, id, { snoozedUntil: ai });
    const res = await browser.send("/home/unsnooze", post({ id, ...snooze }));
    expect(res.status).toBe(409);
    expect(row(world, id).snoozed_until).toBe(ai.getTime());
  });

  it("/home/snooze after an AI snoozed the link is a 409, leaving its snooze as it was", async () => {
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

  it("/home/snooze after an AI archived the link is a 409, changing nothing", async () => {
    const { world, browser, id } = await home();
    await browser.send("/");
    await updateLink(linkDeps(world), A, id, { state: "archived" });
    const before = row(world, id);
    const res = await browser.send("/home/snooze", post({ id }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      message: "This link is already archived. Reload.",
    });
    expect(row(world, id)).toEqual(before);
  });

  it("/home/snooze on an archived link is a 409, leaving its snooze, surfacing and events as they were", async () => {
    const { world, browser, id } = await home();
    await linkDeps(world).store.update(A, id, { state: "archived" });
    const before = row(world, id);
    const events = eventKinds(world, id);
    const res = await browser.send("/home/snooze", post({ id }));
    expect(res.status).toBe(409);
    expect(row(world, id)).toEqual(before);
    expect(row(world, id)).toMatchObject({ snoozed_until: null, last_surfaced_at: null });
    expect(eventKinds(world, id)).toEqual(events);
  });

  it("/home/archive answers the change as JSON, and /home/undo-state with it makes the link active again; a second undo is a 409", async () => {
    const { world, browser, id } = await home();
    const res = await browser.send("/home/archive", post({ id }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      before: { state: "active", snoozedUntil: null },
      after: { state: "archived" },
      at: expect.any(String),
    });
    expect(row(world, id).state).toBe("archived");
    expect(eventKinds(world, id)).toEqual(["stale"]);
    const undo = post({ id, change: res.body });
    expect((await browser.send("/home/undo-state", undo)).status).toBe(204);
    expect(eventKinds(world, id)).toEqual([]);
    expect(row(world, id).state).toBe("active");
    expect((await browser.send("/home/undo-state", undo)).status).toBe(409);
  });

  it("/home/undo-state accepts a change with no put-away date and restores the link, with the stale event removed", async () => {
    const { world, browser, id } = await home();
    const at = "2026-11-19T12:00:00.000Z";
    await linkDeps(world).store.update(A, id, { state: "archived" }, [
      { record: "stale", at: new Date(at) },
    ]);
    expect(eventKinds(world, id)).toEqual(["stale"]);
    const change = {
      before: { state: "active", snoozedUntil: null },
      after: { state: "archived" },
      at,
    };
    expect((await browser.send("/home/undo-state", post({ id, change }))).status).toBe(204);
    expect(row(world, id).state).toBe("active");
    expect(eventKinds(world, id)).toEqual([]);
  });

  it("/home/put-away is gone: a 404, changing nothing", async () => {
    const { world, browser, id } = await home();
    const before = allRows(world);
    expect((await browser.send("/home/put-away", post({ id }))).status).toBe(404);
    expect(allRows(world)).toEqual(before);
  });

  it("undo-state without at is refused, leaving the link archived and its event in place", async () => {
    const { world, browser, id } = await home();
    const { body } = await browser.send("/home/archive", post({ id }));
    const { at: _at, ...withoutAt } = body as Record<string, unknown>;
    const res = await browser.send("/home/undo-state", post({ id, change: withoutAt }));
    expect(res.status).toBe(400);
    expect(row(world, id).state).toBe("archived");
    expect(eventKinds(world, id)).toEqual(["stale"]);
  });

  it("/home/bring-back makes an archived link active and answers the change; a link already active is a 200 that writes nothing", async () => {
    const { world, browser, id } = await home();
    await browser.send("/home/archive", post({ id }));
    const res = await browser.send("/home/bring-back", post({ id }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      before: { state: "archived" },
      after: { state: "active" },
    });
    expect(row(world, id)).toMatchObject({ state: "active" });
    const before = row(world, id);
    const again = await browser.send("/home/bring-back", post({ id }));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      before: { state: "active" },
      after: { state: "active" },
    });
    expect(row(world, id)).toEqual(before);
    const undone = await browser.send("/home/undo-state", post({ id, change: again.body }));
    expect(undone.status).toBe(204);
    expect(row(world, id)).toEqual(before);
  });

  it("/home/undo-state is a 409 once the link has moved on (archived, brought back, then the first Undo)", async () => {
    const { world, browser, id } = await home();
    const first = await browser.send("/home/archive", post({ id }));
    await browser.send("/home/bring-back", post({ id }));
    const before = row(world, id);
    const res = await browser.send("/home/undo-state", post({ id, change: first.body }));
    expect(res.status).toBe(409);
    expect(row(world, id)).toEqual(before);
  });

  it("/home/undo-state refuses a change that is malformed with 400, changing nothing", async () => {
    const { world, browser, id } = await home();
    const archived = await browser.send("/home/archive", post({ id }));
    const good = archived.body as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    const before = allRows(world);
    for (const bad of [
      undefined,
      null,
      "x",
      {},
      { before: good.before },
      { after: good.after },
      { ...good, before: { ...good.before, state: "gone" } },
      { ...good, before: { ...good.before, snoozedUntil: 5 } },
      { ...good, before: { ...good.before, snoozedUntil: undefined } },
      { ...good, after: { ...good.after, state: 3 } },
      { ...good, at: undefined },
      { ...good, at: null },
      { ...good, at: "soon" },
      { ...good, at: 5 },
    ]) {
      const res = await browser.send("/home/undo-state", post({ id, change: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(allRows(world)).toEqual(before);
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

type Seed = LinkPatch;

/** Each POST, with a body naming the card's link, and the state of A's link it acts on. */
const ROUTES: [string, (id: string) => Record<string, unknown>, Seed][] = [
  ["/links/opened", (id) => ({ id }), {}],
  ["/home/snooze", (id) => ({ id }), {}],
  [
    "/home/unsnooze",
    (id) => ({ id, until: SEED_UNTIL.toISOString(), previous: null }),
    { snoozedUntil: SEED_UNTIL },
  ],
  ["/home/archive", (id) => ({ id }), {}],
  ["/home/bring-back", (id) => ({ id }), { state: "archived" }],
  [
    "/home/undo-state",
    (id) => ({
      id,
      change: {
        before: { state: "active", snoozedUntil: null },
        after: { state: "archived" },
        at: "2026-01-01T00:00:00.000Z",
      },
    }),
    { state: "archived" },
  ],
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

it("POST /home/unsnooze refuses a time that is missing or not a date, and /home/why a text that is not a string", async () => {
  const { world, browser, id } = await home();
  const before = allRows(world);
  const undo = { id, until: SEED_UNTIL.toISOString(), previous: null };
  for (const bad of [
    { until: "soon" },
    { until: null },
    { until: undefined },
    { previous: "soon" },
    { previous: 7 },
  ]) {
    const res = await browser.send("/home/unsnooze", post({ ...undo, ...bad }));
    expect(res.status, JSON.stringify(bad)).toBe(400);
  }
  expect((await browser.send("/home/why", post({ id, text: 7 }))).status).toBe(400);
  expect(allRows(world)).toEqual(before);
});

async function signedIn(world: World) {
  const browser = world.agent();
  await browser.signIn();
  return browser;
}

describe("GET / with a link that seems gone (#128, #340)", () => {
  afterEach(() => vi.restoreAllMocks());

  const withGone = async () => {
    const world = await oauthWorld();
    const deps = linkDeps(world);
    const { link } = await saveLink(deps, A, {
      url: "https://a.example/old",
      savedBy: "seed",
      title: "Old page",
    });
    const day = 86_400_000;
    await deps.checks.updateCheckIf(A, link.id, null, {
      checkedAt: new Date(Date.now() - day),
      result: "dead",
      detail: "http:404",
      firstDeadAt: new Date(Date.now() - 20 * day),
      flaggedAt: new Date(Date.now() - 10 * day),
      stillWorksAt: null,
    });
    const browser = world.agent();
    await browser.signIn();
    return { world, deps, browser, gone: link };
  };

  it("draws no gone card in Explore, and Tidy's first step is the gone page with It still works and Archive and no Keep", async () => {
    const { browser, gone } = await withGone();
    const html = String((await browser.send("/")).body);
    expect(html).not.toMatch(/class="[^"]*worth-gone/);
    expect(html).not.toMatch(/class="[^"]*gone-band/);
    expect(html).not.toMatch(new RegExp(`class="worth-[^"]*" data-id="${gone.id}"`));
    const tidy = html.slice(html.indexOf('<section class="tidy-tray"'));
    const step = tidy.slice(tidy.indexOf(`data-id="${gone.id}"`));
    expect(step.slice(0, step.indexOf("</article>"))).toContain("This page seems gone.");
    const acts = [
      ...step.slice(0, step.indexOf("</article>")).matchAll(/data-act="([a-z]+)"/g),
    ].map((m) => m[1]);
    expect(acts).toEqual(["works", "archive"]);
  });

  it("gives Tidy's gone step Read the saved copy only when the link has one", async () => {
    const { world, browser, gone } = await withGone();
    const stepOf = async () => {
      const html = String((await browser.send("/")).body);
      const tidy = html.slice(html.indexOf('<section class="tidy-tray"'));
      const step = tidy.slice(tidy.indexOf(`data-id="${gone.id}"`));
      return step.slice(0, step.indexOf("</article>"));
    };
    expect(await stepOf()).not.toContain("read-copy");
    vi.spyOn(world.savedCopies, "copyInfo").mockImplementation(
      async (_owner, ids) =>
        new Map(ids.filter((id) => id === gone.id).map((id) => [id, { madeAt: new Date() }])),
    );
    expect(await stepOf()).toContain(`href="/links/${gone.id}/copy?from=%2F"`);
  });

  it("reads the pictures and saved copies of every Explore card", async () => {
    const { world, deps, browser } = await withGone();
    const { link: pick } = await saveLink(deps, A, {
      url: "https://a.example/pick",
      savedBy: "seed",
      title: "A pick",
    });
    const copies = vi.spyOn(world.savedCopies, "copyInfo");
    const pictures = vi.spyOn(SqliteImageStore.prototype, "pictureInfo");
    const html = String((await browser.send("/")).body);
    expect(html).toContain(`data-id="${pick.id}"`);
    const asked = (calls: unknown[][]) => calls.flatMap((c) => c[1] as string[]);
    for (const spy of [copies, pictures]) {
      expect(asked(spy.mock.calls)).toEqual(expect.arrayContaining([pick.id]));
    }
    expect(html.match(/<dialog class="edit-link"/g)).toHaveLength(1);
  });
});
