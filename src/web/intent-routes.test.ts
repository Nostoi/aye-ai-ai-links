import { describe, expect, it } from "vitest";
import { addSecondUser, allRows, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { KEPT_TOOL_STAYS } from "../core/intent.js";
import { saveLink } from "../core/links.js";
import { keepHandy } from "../core/tools.js";
import type { LinkPatch } from "../core/types.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
const post = (json: unknown) => ({ method: "POST", json });
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

async function home(patch: LinkPatch = {}) {
  const world = await oauthWorld();
  const deps = linkDeps(world);
  const { link } = await saveLink(deps, A, {
    url: "https://a.example/intent-card",
    savedBy: "seed",
    title: "An intent card",
    tags: [{ name: "Bills", source: "stated" }],
  });
  if (Object.keys(patch).length > 0) await deps.store.update(A, link.id, patch);
  const browser = world.agent();
  await browser.signIn();
  return { world, browser, id: link.id };
}

/** Every column of the link's row except its intent pair, which the tests assert on their own. */
const beyondIntent = (world: World, id: string) => {
  const { intent: _i, intent_source: _s, ...rest } = row(world, id);
  return rest;
};

describe("POST /home/keep and /home/explore", () => {
  it("Keep it answers the change as JSON and keeps the link as stated; its Undo restores explore, and a second Undo is a 409", async () => {
    const { world, browser, id } = await home();
    const before = beyondIntent(world, id);
    const res = await browser.send("/home/keep", post({ id }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      before: { intent: "explore", intentSource: null },
      after: { intent: "keep", intentSource: "stated" },
      at: expect.any(String),
    });
    expect(row(world, id)).toMatchObject({ intent: "keep", intent_source: "stated" });
    expect(beyondIntent(world, id)).toEqual(before);
    const undo = post({ id, change: res.body });
    expect((await browser.send("/home/undo-intent", undo)).status).toBe(204);
    expect(row(world, id)).toMatchObject({ intent: "explore", intent_source: null });
    expect(beyondIntent(world, id)).toEqual(before);
    expect(eventKinds(world, id)).toEqual([]);
    expect((await browser.send("/home/undo-intent", undo)).status).toBe(409);
  });

  it("Explore it turns a guessed To keep into To explore as stated, and its Undo brings the guess back", async () => {
    const { world, browser, id } = await home({ intent: "keep", intentSource: "inferred" });
    const res = await browser.send("/home/explore", post({ id }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      before: { intent: "keep", intentSource: "inferred" },
      after: { intent: "explore", intentSource: "stated" },
    });
    expect(row(world, id)).toMatchObject({ intent: "explore", intent_source: "stated" });
    expect((await browser.send("/home/undo-intent", post({ id, change: res.body }))).status).toBe(
      204,
    );
    expect(row(world, id)).toMatchObject({ intent: "keep", intent_source: "inferred" });
  });

  it("refuses an archived link with the Reload words, leaving its row and events as they were", async () => {
    const { world, browser, id } = await home();
    await browser.send("/home/archive", post({ id }));
    const before = row(world, id);
    const events = eventKinds(world, id);
    for (const path of ["/home/keep", "/home/explore"]) {
      const res = await browser.send(path, post({ id }));
      expect(res.status, path).toBe(409);
      expect(res.body, path).toMatchObject({ message: "This link is already archived. Reload." });
    }
    expect(row(world, id)).toEqual(before);
    expect(eventKinds(world, id)).toEqual(events);
  });

  it("refuses Explore it on a kept tool by name, leaving the link, its tool row and events as they were", async () => {
    const { world, browser, id } = await home();
    await keepHandy(linkDeps(world), A, id, "stated");
    const before = row(world, id);
    const tools = allRows(world);
    expect(before).toMatchObject({ intent: "keep", intent_source: "stated" });
    const res = await browser.send("/home/explore", post({ id }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ message: KEPT_TOOL_STAYS });
    expect(row(world, id)).toEqual(before);
    expect(allRows(world)).toEqual(tools);
  });

  it("Undo of Keep it leaves a Not now made in between: only the intent goes back", async () => {
    const { world, browser, id } = await home();
    const kept = await browser.send("/home/keep", post({ id }));
    expect((await browser.send("/home/snooze", post({ id }))).status).toBe(200);
    const snoozed = row(world, id).snoozed_until;
    expect(snoozed).not.toBeNull();
    expect((await browser.send("/home/undo-intent", post({ id, change: kept.body }))).status).toBe(
      204,
    );
    expect(row(world, id)).toMatchObject({
      intent: "explore",
      intent_source: null,
      snoozed_until: snoozed,
      state: "active",
    });
    expect(eventKinds(world, id)).toEqual(["not_now"]);
  });

  it("an Undo is a 409 once the intent moved on, keeping what is there", async () => {
    const { world, browser, id } = await home();
    const kept = await browser.send("/home/keep", post({ id }));
    await browser.send("/home/explore", post({ id }));
    const res = await browser.send("/home/undo-intent", post({ id, change: kept.body }));
    expect(res.status).toBe(409);
    expect(row(world, id)).toMatchObject({ intent: "explore", intent_source: "stated" });
  });

  it("refuses a change with an unknown intent or a source-less keep, changing nothing", async () => {
    const { world, browser, id } = await home();
    const before = allRows(world);
    const at = "2026-11-19T12:00:00.000Z";
    for (const after of [
      { intent: "maybe", intentSource: "stated" },
      { intent: "keep", intentSource: null },
      { intent: "keep" },
    ]) {
      const change = { before: { intent: "explore", intentSource: null }, after, at };
      const res = await browser.send("/home/undo-intent", post({ id, change }));
      expect(res.status, JSON.stringify(after)).toBe(400);
    }
    const change = {
      before: { intent: "keep", intentSource: null },
      after: { intent: "explore", intentSource: null },
      at,
    };
    expect((await browser.send("/home/undo-intent", post({ id, change }))).status).toBe(400);
    expect(allRows(world)).toEqual(before);
  });
});

describe("the intent routes and other owners and sites", () => {
  it("the two-owner test of POST /home/keep, /home/explore and /home/undo-intent: B changes nothing of A's", async () => {
    const { world, id, browser } = await home();
    const kept = await browser.send("/home/keep", post({ id }));
    const b = await addSecondUser(world);
    const before = allRows(world);
    const change = kept.body;
    for (const [path, body] of [
      ["/home/keep", { id }],
      ["/home/explore", { id }],
      ["/home/undo-intent", { id, change }],
    ] as const) {
      expect((await b.send(path, post(body))).status, path).toBe(404);
    }
    expect(allRows(world)).toEqual(before);
  });

  it("refuses another site's Origin with 403, writing nothing", async () => {
    const { world, id, browser } = await home();
    const before = allRows(world);
    for (const path of ["/home/keep", "/home/explore", "/home/undo-intent"]) {
      const res = await browser.send(path, {
        ...post({ id }),
        headers: { origin: "https://evil.example" },
      });
      expect(res.status, path).toBe(403);
    }
    expect(allRows(world)).toEqual(before);
  });
});
