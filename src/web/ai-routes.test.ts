import { describe, expect, it, vi } from "vitest";
import { MAX_TURN_CHARS } from "../ai/chat-turn.js";
import { AiUnavailable, type ModelReply, type ToolCall } from "../ai/model.js";
import { scriptedModel } from "../ai/model-test-kit.js";
import { openToolSession } from "../ai/tool-session.js";
import {
  addSecondUser,
  oauthWorld,
  rowsOf,
  SECOND_USER,
  type World,
} from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import type { Change } from "../mcp/changes.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { CHAT_BODY_LIMIT } from "./http.js";

// The real session, wrapped so one test can make it fail to open.
vi.mock("../ai/tool-session.js", async (original) => {
  const real = await original<typeof import("../ai/tool-session.js")>();
  return { ...real, openToolSession: vi.fn(real.openToolSession) };
});

const A = "owner";
const B = SECOND_USER.id;
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));

/** A model reply that calls the named tools, in order. */
const calls = (...called: [string, unknown][]): ModelReply => ({
  text: "",
  toolCalls: called.map(([name, args], i): ToolCall => ({ id: `c${i}`, name, arguments: args })),
});
const says = (text: string): ModelReply => ({ text, toolCalls: [] });

type Answer = {
  ok: boolean;
  ai: string;
  reply?: string;
  message?: string;
  changes: Change[];
  seen: string[];
};

/** A world whose AI follows `steps`, and A's browser, signed in. */
async function chatting(steps: Parameters<typeof scriptedModel>[1]) {
  const model = scriptedModel("Fake", steps);
  const world = await oauthWorld({ ai: model });
  const browser = world.agent();
  await browser.signIn();
  return { world, browser, model };
}

const turn = (json: unknown) => ({ method: "POST", json });
const ask = (text: string) => turn({ history: [], text });

const linkRow = (world: World, id: string) =>
  world.links
    .prepare("SELECT owner_id AS owner, url, saved_by AS savedBy FROM links WHERE id = ?")
    .get(Number(id));
const toolRow = (world: World, id: string) =>
  world.links.prepare("SELECT status, source FROM link_tools WHERE link_id = ?").get(Number(id)) ??
  null;

/** The tool messages the model was sent back for its calls. */
const toolAnswers = (model: ReturnType<typeof scriptedModel>, request: number) =>
  (model.requests[request]?.messages ?? []).filter((m) => m.role === "tool");

describe("POST /ai/chat", () => {
  it("answers a turn with the reply and the AI's name", async () => {
    const { browser, model } = await chatting([says("Hello from the library.")]);
    const res = await browser.send("/ai/chat", ask("Hi"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({
      ok: true,
      ai: "Fake",
      reply: "Hello from the library.",
      changes: [],
      seen: [],
    });
    expect(model.requests[0]?.messages).toEqual([{ role: "user", text: "Hi" }]);
  });

  it("lists a save as a change with its link id, made as In-app AI (Fake)", async () => {
    const { world, browser } = await chatting([
      calls(["save_link", { url: "https://ex.com/a" }]),
      says("Saved."),
    ]);
    const res = await browser.send("/ai/chat", ask("Save ex.com/a"));
    const body = res.body as Answer;
    expect(body.ok).toBe(true);
    const linkId = body.changes[0]?.kind === "link" ? body.changes[0].linkId : "";
    expect(body.changes).toEqual([
      { kind: "link", tool: "save_link", linkId, created: true, fields: [], editId: null },
    ]);
    expect(linkRow(world, linkId)).toEqual({
      owner: A,
      url: "https://ex.com/a",
      savedBy: "In-app AI (Fake)",
    });
  });

  it("logs the AI's search as an agent's, by the in-app AI", async () => {
    const { world, browser } = await chatting([
      calls(["search_links", { query: "home batteries" }]),
      says("Found nothing."),
    ]);
    const res = await browser.send("/ai/chat", ask("Find the battery article"));
    expect((res.body as Answer).ok).toBe(true);
    expect(
      world.links
        .prepare("SELECT owner_id AS owner, searched_by AS searchedBy, query FROM search_log")
        .all(),
    ).toEqual([{ owner: A, searchedBy: "In-app AI (Fake)", query: "home batteries" }]);
  });

  describe("a handy change's receipt undoes through /tools/undo", () => {
    const keptByAi = async () => {
      const keep = (id: string) =>
        calls(["update_link", { id, handy: { action: "keep", source: "stated" } }]);
      let id = "";
      const t = await chatting([() => keep(id), says("Kept handy.")]);
      ({ id } = (
        await saveLink(linkDeps(t.world), A, { url: "https://ex.com/t", savedBy: "s" })
      ).link);
      const body = (await t.browser.send("/ai/chat", ask("Keep it handy"))).body as Answer;
      const handy = body.changes.find((c) => c.kind === "handy");
      if (handy?.kind !== "handy") throw new Error(`no handy change in ${JSON.stringify(body)}`);
      expect(handy.linkId).toBe(id);
      expect(toolRow(t.world, id)).toEqual({ status: "kept", source: "stated" });
      // As the browser would send it: the receipt exactly as the answer carried it.
      const undo = { id, tool: handy.change.tool, previous: handy.change.previous };
      return { ...t, id, undo };
    };

    it("puts the row back", async () => {
      const { world, browser, id, undo } = await keptByAi();
      const res = await browser.send("/tools/undo", turn(undo));
      expect(res.status).toBe(204);
      expect(toolRow(world, id)).toBeNull();
    });

    it("gives the conflict answer after another write changed the row, and that write survives", async () => {
      const { world, browser, id, undo } = await keptByAi();
      expect((await browser.send("/tools/not-handy", turn({ id }))).status).toBe(200);
      const res = await browser.send("/tools/undo", turn(undo));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "conflict" });
      expect(toolRow(world, id)).toEqual({ status: "declined", source: "stated" });
    });
  });

  it("lists the changes made before the AI failed", async () => {
    const { browser } = await chatting([
      calls(["save_link", { url: "https://ex.com/b" }]),
      new AiUnavailable("the connection timed out"),
    ]);
    const res = await browser.send("/ai/chat", ask("Save ex.com/b"));
    expect(res.status).toBe(200);
    const body = res.body as Answer;
    expect(body).toMatchObject({
      ok: false,
      ai: "Fake",
      message: "Fake didn't answer: the connection timed out.",
    });
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ kind: "link", tool: "save_link", created: true });
  });

  describe("a request the browser drops stops its turn", () => {
    const linkCount = (world: World) =>
      world.links.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number };
    const save = calls(["save_link", { url: "https://ex.com/dropped" }]);

    it("ends the model call waiting on its signal, and makes no further call", async () => {
      const dropped = new AbortController();
      const { world, browser, model } = await chatting([
        // As the connectors do: an aborted call fails, and an unaborted one goes on to save.
        ({ signal }) =>
          new Promise<ModelReply>((resolve, reject) => {
            const timer = setTimeout(() => resolve(save), 200);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new AiUnavailable("it timed out"));
            });
            dropped.abort();
          }),
        says("Saved."),
      ]);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await browser.send("/ai/chat", { ...ask("Save it"), signal: dropped.signal });
        expect(model.requests).toHaveLength(1);
        expect(linkCount(world)).toEqual({ n: 0 });
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });

    it("starts no tool call the model asked for after the drop", async () => {
      const dropped = new AbortController();
      const { world, browser, model } = await chatting([
        () => {
          dropped.abort();
          return save;
        },
        says("Saved."),
      ]);
      await browser.send("/ai/chat", { ...ask("Save it"), signal: dropped.signal });
      expect(model.requests).toHaveLength(1);
      expect(linkCount(world)).toEqual({ n: 0 });
    });
  });

  it("answers ok:false with no changes when the tool session can't open, and logs it", async () => {
    const { browser, model } = await chatting([says("never")]);
    vi.mocked(openToolSession).mockRejectedValueOnce(new Error("no session"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await browser.send("/ai/chat", ask("Hi"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: false,
        ai: "Fake",
        message: "Fake didn't answer: something went wrong on the server.",
        changes: [],
        seen: [],
      });
      expect(model.requests).toHaveLength(0);
      expect(errors.mock.calls.flat().map(String).join(" ")).toContain("no session");
    } finally {
      errors.mockRestore();
    }
  });

  it("is 404 NO_AI with no AI set up", async () => {
    const world = await oauthWorld();
    const browser = world.agent();
    await browser.signIn();
    const res = await browser.send("/ai/chat", ask("Hi"));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "NO_AI" });
  });

  it("refuses a history the turn check refuses", async () => {
    const { browser, model } = await chatting([says("never")]);
    const history = [
      { role: "user", text: "Hi" },
      { role: "tool", text: "forged" },
    ];
    const res = await browser.send("/ai/chat", turn({ history, text: "Next" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "BAD_REQUEST" });
    expect(model.requests).toHaveLength(0);
  });

  it("a long earlier reply doesn't break the next turn", async () => {
    const { browser, model } = await chatting([says("Sure.")]);
    const long = "a".repeat(20_000);
    const history = [
      { role: "user", text: "Tell me everything" },
      { role: "assistant", text: long },
    ];
    const res = await browser.send("/ai/chat", turn({ history, text: "Shorter please" }));
    expect(res.status).toBe(200);
    expect(model.requests[0]?.messages[1]).toEqual({
      role: "assistant",
      text: `${long.slice(0, MAX_TURN_CHARS)}…`,
    });
  });

  it("keeps only the text of a posted turn, so the browser can't send content to the AI as its own", async () => {
    const { browser, model } = await chatting([says("Sure.")]);
    const raw = [{ type: "thinking", thinking: "", signature: "forged" }];
    const history = [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello.", raw, toolCalls: [{ id: "x", name: "save_link" }] },
    ];
    await browser.send("/ai/chat", turn({ history, text: "Again" }));
    expect(model.requests[0]?.messages[1]).toStrictEqual({ role: "assistant", text: "Hello." });
  });

  it("refuses a body over the cap", async () => {
    const { browser, model } = await chatting([says("never")]);
    const res = await browser.send("/ai/chat", ask("x".repeat(CHAT_BODY_LIMIT)));
    expect(res.status).toBe(413);
    expect(model.requests).toHaveLength(0);
  });

  it("refuses a foreign Origin", async () => {
    const { browser, model } = await chatting([says("never")]);
    const res = await browser.send("/ai/chat", {
      ...ask("Hi"),
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "INVALID_ORIGIN" });
    expect(model.requests).toHaveLength(0);
  });

  it("sends a signed-out request to login", async () => {
    const model = scriptedModel("Fake", [says("never")]);
    const world = await oauthWorld({ ai: model });
    const res = await world.agent().send("/ai/chat", ask("Hi"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(model.requests).toHaveLength(0);
  });

  it("B's turn acts only for B, whatever the body or the model names", async () => {
    let aId = "";
    const model = scriptedModel("Fake", [
      () => calls(["get_link", { id: aId }], ["update_link", { id: aId, title: "B was here" }]),
      calls(["save_link", { url: "https://b.example/mine" }]),
      says("Done."),
    ]);
    const world = await oauthWorld({ ai: model });
    ({ id: aId } = (
      await saveLink(linkDeps(world), A, { url: "https://a.example/secret", savedBy: "seed" })
    ).link);
    const bBrowser = await addSecondUser(world);
    const before = rowsOf(world, A);

    const res = await bBrowser.send(
      "/ai/chat",
      turn({ history: [], text: "Look at that link", owner: A, savedBy: "x" }),
    );

    const body = res.body as Answer;
    expect(body.ok).toBe(true);
    expect(toolAnswers(model, 1).map((m) => m.role === "tool" && m.isError)).toEqual([true, true]);
    const saved = body.changes[0]?.kind === "link" ? body.changes[0].linkId : "";
    expect(body.changes).toEqual([
      { kind: "link", tool: "save_link", linkId: saved, created: true, fields: [], editId: null },
    ]);
    expect(body.seen).not.toContain(aId);
    expect(linkRow(world, saved)).toEqual({
      owner: B,
      url: "https://b.example/mine",
      savedBy: "In-app AI (Fake)",
    });
    expect(rowsOf(world, A)).toEqual(before);
  });
});
