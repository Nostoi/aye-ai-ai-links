import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { addSecondUser, allRows, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink, updateLink } from "../core/links.js";
import type { Labelled, LinkPatch } from "../core/types.js";
import { SNOOZE_MS } from "../core/worth-a-look.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { SqliteImageStore } from "../store/sqlite-image-store.js";

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
    expect(html).toContain("Worth a look today");
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
  it("/home/opened records the opening and the surfacing: 204, uncached", async () => {
    const { world, browser, id } = await home();
    const res = await browser.send("/home/opened", post({ id }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(row(world, id).last_opened_at).toEqual(expect.any(Number));
    expect(row(world, id).last_surfaced_at).toEqual(row(world, id).last_opened_at);
    expect(world.links.prepare("SELECT count(*) AS n FROM search_log").get()).toEqual({ n: 0 });
  });

  it("/home/opened on a put-away link brings it back to active: putAwayAt cleared, opening recorded", async () => {
    const { world, browser, id } = await home();
    await linkDeps(world).store.update(A, id, {
      state: "archived",
      putAwayAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect((await browser.send("/home/opened", post({ id }))).status).toBe(204);
    expect(row(world, id)).toMatchObject({
      state: "active",
      put_away_at: null,
      last_opened_at: expect.any(Number),
    });
  });

  it("/home/opened on a stale link records the opening and leaves it stale", async () => {
    const { world, browser, id } = await home();
    await linkDeps(world).store.update(A, id, { state: "archived", putAwayAt: null });
    expect((await browser.send("/home/opened", post({ id }))).status).toBe(204);
    expect(row(world, id)).toMatchObject({ state: "archived", put_away_at: null });
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

  it("/home/snooze marks it surfaced and snoozes two weeks, answering both; /home/unsnooze reverses both, so the card is back", async () => {
    const { world, browser, id } = await home();
    const res = await browser.send("/home/snooze", post({ id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const snooze = res.body as Record<string, string | null>;
    const r = row(world, id);
    expect(snooze).toEqual({
      until: new Date(r.snoozed_until as number).toISOString(),
      claimedAt: new Date(r.last_surfaced_at as number).toISOString(),
      previousSurfacedAt: null,
    });
    expect(r.snoozed_until).toBe((r.last_surfaced_at as number) + SNOOZE_MS);
    expect(String((await browser.send("/")).body)).not.toContain("Worth a look today");
    const back = await browser.send("/home/unsnooze", post({ id, ...snooze }));
    expect(back.status).toBe(204);
    expect(row(world, id)).toMatchObject({ snoozed_until: null, last_surfaced_at: null });
    expect(String((await browser.send("/")).body)).toContain(`data-id="${id}"`);
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

  it("/home/snooze after an AI archived the link is a 409, changing nothing", async () => {
    const { world, browser, id } = await home();
    await browser.send("/");
    await updateLink(linkDeps(world), A, id, { state: "archived" });
    const before = row(world, id);
    const res = await browser.send("/home/snooze", post({ id }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      message: "This link is already out of your lists. Reload.",
    });
    expect(row(world, id)).toEqual(before);
  });

  it("/home/archive answers the change as JSON, and /home/undo-state with it makes the link active again; a second undo is a 409", async () => {
    const { world, browser, id } = await home();
    const res = await browser.send("/home/archive", post({ id }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      before: { state: "active", putAwayAt: null, snoozedUntil: null },
      after: { state: "archived", putAwayAt: null },
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

  it("/home/put-away marks it put away with an ISO date; its Undo restores the snooze it cleared", async () => {
    const { world, browser, id } = await home();
    await browser.send("/home/snooze", post({ id }));
    const snoozed = row(world, id).snoozed_until;
    expect(snoozed).not.toBeNull();
    const res = await browser.send("/home/put-away", post({ id }));
    expect(res.status).toBe(200);
    const change = res.body as {
      before: { snoozedUntil: string };
      after: { state: string; putAwayAt: string };
    };
    expect(change.after.state).toBe("archived");
    expect(new Date(change.after.putAwayAt).toISOString()).toBe(change.after.putAwayAt);
    expect(typeof change.before.snoozedUntil).toBe("string");
    expect(row(world, id)).toMatchObject({ state: "archived", snoozed_until: null });
    expect(row(world, id).put_away_at).not.toBeNull();
    expect((await browser.send("/home/undo-state", post({ id, change }))).status).toBe(204);
    expect(row(world, id)).toMatchObject({ state: "active", snoozed_until: snoozed });
    expect(row(world, id).put_away_at).toBeNull();
  });

  it("undo-state without at is refused, leaving the link put away and its event in place", async () => {
    const { world, browser, id } = await home();
    const { body } = await browser.send("/home/put-away", post({ id }));
    const { at: _at, ...withoutAt } = body as Record<string, unknown>;
    const res = await browser.send("/home/undo-state", post({ id, change: withoutAt }));
    expect(res.status).toBe(400);
    expect(row(world, id).state).toBe("archived");
    expect(eventKinds(world, id)).toEqual(["put_away"]);
  });

  it("/home/put-away on a link that is already out of your lists is a 409, changing nothing", async () => {
    const { world, browser, id } = await home();
    await browser.send("/home/archive", post({ id }));
    const before = row(world, id);
    expect((await browser.send("/home/put-away", post({ id }))).status).toBe(409);
    expect(row(world, id)).toEqual(before);
  });

  it("/home/bring-back makes a put-away link active, clears the marker and answers the change; a link already active is a 200 that writes nothing", async () => {
    const { world, browser, id } = await home();
    await browser.send("/home/put-away", post({ id }));
    const res = await browser.send("/home/bring-back", post({ id }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      before: { state: "archived" },
      after: { state: "active", putAwayAt: null },
    });
    expect(row(world, id)).toMatchObject({ state: "active", put_away_at: null });
    const before = row(world, id);
    const again = await browser.send("/home/bring-back", post({ id }));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      before: { state: "active", putAwayAt: null },
      after: { state: "active", putAwayAt: null },
    });
    expect(row(world, id)).toEqual(before);
    const undone = await browser.send("/home/undo-state", post({ id, change: again.body }));
    expect(undone.status).toBe(204);
    expect(row(world, id)).toEqual(before);
  });

  it("/home/undo-state refuses a change that sends an active link back with a put-away date, 400, changing nothing", async () => {
    const { world, browser, id } = await home();
    const put = await browser.send("/home/put-away", post({ id }));
    const good = put.body as { before: Record<string, unknown>; after: Record<string, unknown> };
    const before = allRows(world);
    const date = "2026-01-01T00:00:00.000Z";
    for (const bad of [
      { ...good, before: { ...good.before, state: "active", putAwayAt: date } },
      { ...good, after: { ...good.after, state: "active", putAwayAt: date } },
    ]) {
      const res = await browser.send("/home/undo-state", post({ id, change: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(allRows(world)).toEqual(before);
  });

  it("/home/undo-state is a 409 once the link has moved on (put away, then stale, then the first Undo)", async () => {
    const { world, browser, id } = await home();
    const put = await browser.send("/home/put-away", post({ id }));
    await browser.send("/home/archive", post({ id }));
    const before = row(world, id);
    const res = await browser.send("/home/undo-state", post({ id, change: put.body }));
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
      { ...good, before: { ...good.before, putAwayAt: "soon" } },
      { ...good, before: { ...good.before, putAwayAt: undefined } },
      { ...good, before: { ...good.before, snoozedUntil: 5 } },
      { ...good, before: { ...good.before, snoozedUntil: undefined } },
      { ...good, after: { ...good.after, state: 3 } },
      { ...good, after: { ...good.after, putAwayAt: "soon" } },
      { ...good, after: { ...good.after, putAwayAt: undefined } },
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

/** A snooze and its claim the two-owner test seeds, which the unsnooze body names. */
const SEED_UNTIL = new Date("2030-01-01T00:00:00.000Z");
const SEED_CLAIM = new Date("2029-12-18T00:00:00.000Z");

type Seed = LinkPatch & { lastSurfacedAt?: Date };

/** Each POST, with a body naming the card's link, and the state of A's link it acts on. */
const ROUTES: [string, (id: string) => Record<string, unknown>, Seed][] = [
  ["/home/opened", (id) => ({ id }), {}],
  ["/links/opened", (id) => ({ id }), {}],
  ["/home/snooze", (id) => ({ id }), {}],
  [
    "/home/unsnooze",
    (id) => ({
      id,
      until: SEED_UNTIL.toISOString(),
      claimedAt: SEED_CLAIM.toISOString(),
      previousSurfacedAt: null,
    }),
    { snoozedUntil: SEED_UNTIL, lastSurfacedAt: SEED_CLAIM },
  ],
  ["/home/archive", (id) => ({ id }), {}],
  ["/home/put-away", (id) => ({ id }), {}],
  ["/home/bring-back", (id) => ({ id }), { state: "archived" }],
  [
    "/home/undo-state",
    (id) => ({
      id,
      change: {
        before: { state: "active", putAwayAt: null, snoozedUntil: null },
        after: { state: "archived", putAwayAt: null },
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
    const { lastSurfacedAt, ...patch } = seed;
    await updateLink(linkDeps(world), A, id, patch);
    if (lastSurfacedAt) {
      world.links
        .prepare("UPDATE links SET last_surfaced_at = ? WHERE id = ?")
        .run(lastSurfacedAt.getTime(), Number(id));
    }
    const bBrowser = await addSecondUser(world);
    const before = ownedRows(world, A);
    const res = await bBrowser.send(path, post(body(id)));
    expect(res.status).toBe(404);
    expect(ownedRows(world, A)).toEqual(before);
    // The same request from A is accepted, so B's 404 is down to whose link it is.
    expect((await browser.send(path, post(body(id)))).status).toBeLessThan(300);
    if (lastSurfacedAt) expect(row(world, id).last_surfaced_at).toBeNull();
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
  const undo = {
    id,
    until: SEED_UNTIL.toISOString(),
    claimedAt: SEED_CLAIM.toISOString(),
    previousSurfacedAt: null,
  };
  for (const bad of [
    { until: "soon" },
    { until: null },
    { claimedAt: "soon" },
    { claimedAt: undefined },
    { previousSurfacedAt: "soon" },
    { previousSurfacedAt: undefined },
    { previousSurfacedAt: SEED_UNTIL.toISOString() },
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

describe("GET / with a link that seems gone (#128)", () => {
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

  it("shows it once, as the gone row with its warning, though it is also a reading candidate", async () => {
    const { browser, gone } = await withGone();
    const html = String((await browser.send("/")).body);
    expect(html.split(`data-id="${gone.id}"`)).toHaveLength(2);
    expect(html).toMatch(new RegExp(`class="worth-row worth-gone[^"]*" data-id="${gone.id}"`));
    expect(html).toContain("This page seems gone");
    expect(html).not.toContain('class="worth-card worth-feature');
  });

  it("reads the pictures and saved copies of every card it shows, the gone one too", async () => {
    const { world, deps, browser, gone } = await withGone();
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
      expect(asked(spy.mock.calls)).toEqual(expect.arrayContaining([pick.id, gone.id]));
    }
    expect(html.match(/<dialog class="edit-link"/g)).toHaveLength(1);
  });
});

describe("GET / Tidy up start line", () => {
  const DAY = 86_400_000;
  async function oldLinks(count: number) {
    const world = await oauthWorld();
    for (let i = 0; i < count; i++) {
      const { link } = await saveLink(linkDeps(world), A, {
        url: `https://a.example/tidy-old-${i}`,
        savedBy: "seed",
        title: `Old ${i}`,
      });
      world.links
        .prepare("UPDATE links SET saved_at = ? WHERE id = ?")
        .run(Date.now() - 60 * DAY, Number(link.id));
    }
    const browser = world.agent();
    await browser.signIn();
    return String((await browser.send("/")).body);
  }

  it("shows at exactly five qualifying links and links to /tidy", async () => {
    const html = await oldLinks(5);
    expect(html).toContain("Clear out a few old links?");
    expect(html).toContain('href="/tidy"');
  });

  it("is absent at four", async () => {
    expect(await oldLinks(4)).not.toContain("Clear out a few old links?");
  });
});
