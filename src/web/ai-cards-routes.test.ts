import { describe, expect, it } from "vitest";
import { IN_APP_INSTRUCTIONS } from "../ai/chat-turn.js";
import { AiUnavailable, type ModelReply, type ToolCall } from "../ai/model.js";
import { scriptedModel } from "../ai/model-test-kit.js";
import { addSecondUser, oauthWorld, SECOND_USER, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import type { Change } from "../mcp/changes.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { chatAnswer } from "./ai-answer.js";

const A = "owner";
const B = SECOND_USER.id;
const SECRET = "Quokka habitat notes";
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
const calls = (...called: [string, unknown][]): ModelReply => ({
  text: "",
  toolCalls: called.map(([name, args], i): ToolCall => ({ id: `c${i}`, name, arguments: args })),
});
const says = (text: string): ModelReply => ({ text, toolCalls: [] });

type Answer = {
  ok: boolean;
  message?: string;
  segments?: ({ text: string } | { card: string })[];
  remember: string;
  cards: Record<string, string>;
  changes: Change[];
};

async function chatting(steps: Parameters<typeof scriptedModel>[1]) {
  const world = await oauthWorld({ ai: scriptedModel("Fake", steps) });
  const browser = world.agent();
  await browser.signIn();
  return { world, browser };
}
const post = (json: unknown) => ({ method: "POST", json });
const asked = async (t: Awaited<ReturnType<typeof chatting>>) =>
  (await t.browser.send("/ai/chat", post({ history: [], text: "Show me" }))).body as Answer;

/** A's titled link; the AI first reads it (so the turn has seen it) unless `read` is false, then says `reply`. */
async function citing(reply: (id: string) => string, read = true) {
  let id = "";
  const t = await chatting([
    ...(read ? [() => calls(["get_link", { id }])] : []),
    () => says(reply(id)),
  ]);
  ({ id } = (
    await saveLink(linkDeps(t.world), A, {
      url: "https://a.example/q",
      savedBy: "s",
      title: SECRET,
    })
  ).link);
  return { ...t, id };
}

describe("the chat answer's segments and remember", () => {
  it("turns a marker for a seen, owned link into its card and keeps the text around it", async () => {
    const t = await citing((id) => `Here it is.\n\n[[link:${id}]]\nA note.\n`);
    const body = await asked(t);
    expect(body.segments).toHaveLength(3);
    expect(body.segments?.[0]).toEqual({ text: "Here it is." });
    const card = JSON.stringify(body.segments?.[1]);
    expect(card).toContain(SECRET);
    expect(card).toContain(`data-id=\\"${t.id}\\"`);
    expect(body.segments?.[2]).toEqual({ text: "A note." });
  });

  it("removes a marker for a link the turn didn't see", async () => {
    const t = await citing((id) => `Look: [[link:${id}]] done`, false);
    const body = await asked(t);
    expect(body.segments).toEqual([{ text: "Look:  done" }]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("gives a repeated marker one card", async () => {
    const t = await citing((id) => `[[link:${id}]]\nagain\n[[link:${id}]]`);
    const body = await asked(t);
    expect(body.segments?.filter((s) => "card" in s)).toHaveLength(1);
    expect(body.segments?.at(-1)).toEqual({ text: "again" });
  });

  it("remembers a shown link as the model's own marker, and drops a dropped one", async () => {
    const t = await citing((id) => `See [[link:${id}]] and [[link:999]]`);
    expect((await asked(t)).remember).toBe(`See [[link:${t.id}]] and`);
  });

  it("remembers a reply of only dropped markers as no answer, never empty", async () => {
    const t = await citing(() => "[[link:999]]", false);
    const body = await asked(t);
    expect(body.segments).toEqual([]);
    expect(body.remember).toBe("Fake gave no answer.");
  });
});

describe("the chat answer's cards and failure message", () => {
  it("puts a changed link with no marker in cards, and a cited one only in segments", async () => {
    let cited = "";
    const t = await chatting([
      calls(["save_link", { url: "https://ex.com/one", title: "One" }]),
      calls(["save_link", { url: "https://ex.com/two", title: "Two" }]),
      () => says(`Saved both. [[link:${cited}]]`),
    ]);
    // The second save's id is only known after the first request, so read it from a dry run's shape:
    // links are numbered in order, so predict it from the first save in this fresh world.
    const next = (
      t.world.links.prepare("SELECT COALESCE(MAX(id), 0) + 2 AS id FROM links").get() as {
        id: number;
      }
    ).id;
    cited = String(next);
    const body = await asked(t);
    const ids = body.changes.map((c) => (c.kind === "link" ? c.linkId : ""));
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(cited);
    expect(Object.keys(body.cards)).toEqual([ids[0]]);
    expect(body.cards[ids[0] ?? ""]).toContain("One");
    expect(body.segments?.some((s) => "card" in s && s.card.includes("Two"))).toBe(true);
  });

  it("says a failure after a save stopped before it finished, and one with no changes didn't answer", async () => {
    const saved = await chatting([
      calls(["save_link", { url: "https://ex.com/b" }]),
      new AiUnavailable("the connection timed out"),
    ]);
    expect((await asked(saved)).message).toBe(
      "Fake stopped before it finished: the connection timed out.",
    );
    const none = await chatting([new AiUnavailable("the connection timed out")]);
    expect((await asked(none)).message).toBe("Fake didn't answer: the connection timed out.");
  });
});

describe("two owners and a deleted link", () => {
  it("never renders B's link for A's marker, even when the id exists and the turn saw it", async () => {
    let bId = "";
    const t = await chatting([() => says(`[[link:${bId}]]`)]);
    await addSecondUser(t.world);
    ({ id: bId } = (
      await saveLink(linkDeps(t.world), B, {
        url: "https://b.example/secret",
        savedBy: "s",
        title: "B private title",
      })
    ).link);
    const body = await asked(t);
    expect(body.segments).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("B private title");
    // The second gate: a foreign id that did reach `seen` still has no card.
    const answer = await chatAnswer(linkDeps(t.world), A, "Fake", {
      ok: true,
      reply: `[[link:${bId}]]`,
      changes: [],
      seen: [bId],
    });
    expect(answer).toMatchObject({ ok: true, segments: [], remember: "Fake gave no answer." });
  });
});

it("tells the in-app AI how to show a link", () => {
  expect(IN_APP_INSTRUCTIONS).toContain("write [[link:ID]] on its own line");
});

describe("GET /ai/card/:id", () => {
  async function owned() {
    const world = await oauthWorld();
    const browser = world.agent();
    await browser.signIn();
    const { link } = await saveLink(linkDeps(world), A, {
      url: "https://a.example/q",
      savedBy: "s",
      title: SECRET,
    });
    return { world, browser, id: link.id };
  }

  it("answers the owner's card, with no AI set up", async () => {
    const { browser, id } = await owned();
    const res = await browser.send(`/ai/card/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((res.body as { card: string }).card).toContain(SECRET);
  });

  it("refuses a request from another site, like every signed-in page", async () => {
    const { browser, id } = await owned();
    const res = await browser.send(`/ai/card/${id}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("answers 404 for another owner's id, with none of its data", async () => {
    const { world, id } = await owned();
    const b = await addSecondUser(world);
    const res = await b.send(`/ai/card/${id}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "not_found" });
  });

  it("answers 404 for a deleted link", async () => {
    const { browser, id } = await owned();
    expect((await browser.send("/links/delete", post({ id }))).status).toBe(204);
    const res = await browser.send(`/ai/card/${id}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});
