import { describe, expect, it } from "vitest";
import { oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink, updateLink } from "../core/links.js";
import { keepHandy } from "../core/tools.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
const post = (json: unknown) => ({ method: "POST", json });
const intentOf = (world: World, id: string) =>
  world.links
    .prepare("SELECT intent, intent_source AS intentSource FROM links WHERE id = ?")
    .get(Number(id)) as { intent: string; intentSource: string | null };
const toolStatus = (world: World, id: string) =>
  (world.links.prepare("SELECT status, source FROM link_tools WHERE link_id = ?").get(Number(id)) as
    | { status: string; source: string }
    | undefined) ?? null;

async function handy() {
  const world = await oauthWorld();
  const { link } = await saveLink(linkDeps(world), A, {
    url: "https://a.example/bills",
    savedBy: "seed",
    title: "Bills",
  });
  const browser = world.agent();
  await browser.signIn();
  return { world, browser, id: link.id };
}

describe("Keep handy and intent", () => {
  it("(a) Keep handy writes the kept row and To keep, as stated, in one answer that says what moved", async () => {
    const { world, browser, id } = await handy();
    const res = await browser.send("/tools/keep", post({ id }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tool: { status: "kept", source: "stated" },
      previous: null,
      intent: {
        before: { intent: "explore", intentSource: null },
        after: { intent: "keep", intentSource: "stated" },
      },
    });
    expect(toolStatus(world, id)).toEqual({ status: "kept", source: "stated" });
    expect(intentOf(world, id)).toEqual({ intent: "keep", intentSource: "stated" });
  });

  it("(b) an answered suggestion gives keep/asked; an owner's later keep/stated survives the Undo, which still puts the suggestion back", async () => {
    const { world, browser, id } = await handy();
    await keepHandy(linkDeps(world), A, id, "inferred");
    expect(intentOf(world, id)).toEqual({ intent: "explore", intentSource: null });
    const res = await browser.send("/tools/suggestion", post({ id, keep: true }));
    expect(intentOf(world, id)).toEqual({ intent: "keep", intentSource: "asked" });
    await updateLink(linkDeps(world), A, id, { intent: "keep", intentSource: "stated" });
    expect(intentOf(world, id)).toEqual({ intent: "keep", intentSource: "stated" });
    const body = res.body as Record<string, unknown>;
    const undo = await browser.send("/tools/undo", post({ id, ...body }));
    expect(undo.status).toBe(204);
    expect(toolStatus(world, id)).toEqual({ status: "suggested", source: "inferred" });
    expect(intentOf(world, id)).toEqual({ intent: "keep", intentSource: "stated" });
  });

  it("(c) with nothing in between, Undo of Keep handy puts the row and explore back", async () => {
    const { world, browser, id } = await handy();
    const res = await browser.send("/tools/keep", post({ id }));
    const undo = await browser.send("/tools/undo", post({ id, ...(res.body as object) }));
    expect(undo.status).toBe(204);
    expect(toolStatus(world, id)).toBeNull();
    expect(intentOf(world, id)).toEqual({ intent: "explore", intentSource: null });
  });

  it("(d) a suggestion leaves intent alone, and Not handy anymore leaves To keep", async () => {
    const { world, browser, id } = await handy();
    await keepHandy(linkDeps(world), A, id, "inferred");
    expect(intentOf(world, id)).toEqual({ intent: "explore", intentSource: null });
    await browser.send("/tools/suggestion", post({ id, keep: true }));
    const gone = await browser.send("/tools/not-handy", post({ id }));
    expect(gone.body).toMatchObject({ intent: null });
    expect(toolStatus(world, id)).toMatchObject({ status: "declined" });
    expect(intentOf(world, id)).toEqual({ intent: "keep", intentSource: "asked" });
  });

  it("keeps an owner's own keep as it was: Keep handy writes no intent over a stated keep", async () => {
    const { world, browser, id } = await handy();
    await browser.send("/home/keep", post({ id }));
    const res = await browser.send("/tools/keep", post({ id }));
    expect((res.body as { intent: unknown }).intent).toBeNull();
    expect(intentOf(world, id)).toEqual({ intent: "keep", intentSource: "stated" });
  });

  it("Undo refuses an intent pair the store could not hold, changing nothing", async () => {
    const { world, browser, id } = await handy();
    const res = await browser.send("/tools/keep", post({ id }));
    const body = res.body as { tool: unknown; previous: unknown };
    const bad = {
      before: { intent: "keep", intentSource: null },
      after: { intent: "keep", intentSource: "stated" },
    };
    const undo = await browser.send(
      "/tools/undo",
      post({ id, tool: body.tool, previous: body.previous, intent: bad }),
    );
    expect(undo.status).toBe(400);
    expect(toolStatus(world, id)).toEqual({ status: "kept", source: "stated" });
    expect(intentOf(world, id)).toEqual({ intent: "keep", intentSource: "stated" });
  });

  it("Undo is a 409 once the row moved on, leaving the row and the intent", async () => {
    const { world, browser, id } = await handy();
    const first = await browser.send("/tools/keep", post({ id }));
    await browser.send("/tools/still-using", post({ id }));
    const undo = await browser.send("/tools/undo", post({ id, ...(first.body as object) }));
    expect(undo.status).toBe(409);
    expect(toolStatus(world, id)).toMatchObject({ status: "kept" });
    expect(intentOf(world, id)).toEqual({ intent: "keep", intentSource: "stated" });
  });
});
