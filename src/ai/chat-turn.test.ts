import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "../auth/caller.js";
import { createDeps } from "../deps.js";
import { createCallTracker } from "../mcp/call-tracker.js";
import type { Change } from "../mcp/changes.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import {
  IN_APP_INSTRUCTIONS,
  MAX_HISTORY,
  MAX_MODEL_CALLS,
  MAX_TEXT_CHARS,
  MAX_TURN_CHARS,
  runChatTurn,
  TOOL_CALL_MS,
  TOOL_RESERVE_MS,
  TURN_MS,
  takeTurn,
} from "./chat-turn.js";
import { AiUnavailable, type ModelReply, type ToolCall } from "./model.js";
import { scriptedModel } from "./model-test-kit.js";
import { openToolSession, type ToolResult, type ToolSession } from "./tool-session.js";

const TOOLS = ["save_link", "search_links"].map((name) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object" },
}));

/** What the fake does on one call, before it answers: move the clock, abort, throw or refuse. */
type Behave = (name: string, args: unknown, n: number) => Partial<ToolResult> | undefined;

/** A ToolSession that records its calls; each save records a change, as the real one does. */
function fakeSession(behave: Behave = () => undefined) {
  const calls: { name: string; args: unknown }[] = [];
  const changes: Change[] = [];
  const session: ToolSession = {
    instructions: "SESSION RULES",
    tools: TOOLS,
    async call(name, args) {
      calls.push({ name, args });
      const over = behave(name, args, calls.length);
      let result: ToolResult = { text: "{}", isError: false, structured: null };
      if (name === "save_link") {
        const linkId = String(changes.length + 1);
        changes.push({ kind: "link", tool: "save_link", linkId, created: true, fields: [] });
        result = { text: `saved ${linkId}`, isError: false, structured: { link: { id: linkId } } };
      } else if (name === "search_links") {
        result = {
          text: "found",
          isError: false,
          structured: { links: [{ id: "7" }, { link: { id: "8" } }, { id: "7" }] },
        };
      }
      return { ...result, ...over };
    },
    changes: () => [...changes],
    close: async () => {},
  };
  return { session, calls };
}

let callId = 0;
function call(name: string, args: unknown = {}): ToolCall {
  callId += 1;
  return { id: `c${callId}`, name, arguments: args };
}
const save = (url: string) => call("save_link", { url });
const text = (t: string): ModelReply => ({ text: t, toolCalls: [] });
const calls = (...toolCalls: ToolCall[]): ModelReply => ({ text: "", toolCalls });

/** A clock the tests move by hand. */
function clock() {
  let at = 1_000_000;
  return { now: () => at, start: at, set: (ms: number) => (at = 1_000_000 + ms) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runChatTurn", () => {
  it("answers a plain question in one model call", async () => {
    const model = scriptedModel("Fake", [text("hi")]);
    const { session } = fakeSession();
    const history = [
      { role: "user" as const, text: "earlier" },
      { role: "assistant" as const, text: "answered" },
    ];

    const result = await runChatTurn({ model, session, history, text: "hello" });

    expect(result).toEqual({ ok: true, reply: "hi", changes: [], seen: [] });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.messages).toEqual([...history, { role: "user", text: "hello" }]);
    expect(model.requests[0]?.system).toBe(`SESSION RULES\n\n${IN_APP_INSTRUCTIONS}`);
    expect(model.requests[0]?.tools).toEqual(TOOLS);
  });

  it("runs the tool calls, returns their results to the model, and reports the session's changes", async () => {
    const saving = save("https://example.com/a");
    const searching = call("search_links", { query: "batteries" });
    const model = scriptedModel("Fake", [calls(saving, searching), text("Saved it.")]);
    const { session, calls: made } = fakeSession();

    const result = await runChatTurn({ model, session, history: [], text: "save this" });

    expect(result).toEqual({
      ok: true,
      reply: "Saved it.",
      changes: [{ kind: "link", tool: "save_link", linkId: "1", created: true, fields: [] }],
      seen: ["1", "7", "8"],
    });
    expect(made.map((m) => m.name)).toEqual(["save_link", "search_links"]);
    expect(model.requests[1]?.messages.slice(1)).toEqual([
      { role: "assistant", text: "", toolCalls: [saving, searching] },
      { role: "tool", callId: saving.id, name: "save_link", text: "saved 1", isError: false },
      { role: "tool", callId: searching.id, name: "search_links", text: "found", isError: false },
    ]);
  });

  it("passes a tool's error back to the model, and lists whatever the session recorded", async () => {
    const saving = save("https://example.com/a");
    const model = scriptedModel("Fake", [calls(saving), text("That didn't work.")]);
    const { session } = fakeSession(() => ({ isError: true, text: "handy refused" }));

    const result = await runChatTurn({ model, session, history: [], text: "save" });

    expect(result.ok).toBe(true);
    expect(result.changes).toEqual([
      { kind: "link", tool: "save_link", linkId: "1", created: true, fields: [] },
    ]);
    expect(result.seen).toEqual([]);
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      callId: saving.id,
      name: "save_link",
      text: "handy refused",
      isError: true,
    });
  });

  it("starts no further tool call in a batch once the server is stopping", async () => {
    const stop = new AbortController();
    const model = scriptedModel("Fake", [
      calls(save("https://example.com/a"), save("https://example.com/b")),
      text("never"),
    ]);
    const { session, calls: made } = fakeSession(() => {
      stop.abort();
      return undefined;
    });

    const result = await runChatTurn({
      model,
      session,
      history: [],
      text: "save both",
      signal: stop.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(made).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
  });

  it("doesn't call a tool whose arguments weren't JSON, and tells the model", async () => {
    const broken: ToolCall = {
      id: "bad",
      name: "save_link",
      arguments: undefined,
      badArguments: '{"url": "https://exa',
    };
    const model = scriptedModel("Fake", [calls(broken), text("Sorry.")]);
    const { session, calls: made } = fakeSession();

    const result = await runChatTurn({ model, session, history: [], text: "save" });

    expect(result.ok).toBe(true);
    expect(made).toEqual([]);
    const messages = model.requests[1]?.messages ?? [];
    expect(messages.at(-2)).toEqual({ role: "assistant", text: "", toolCalls: [broken] });
    expect(messages.at(-1)).toMatchObject({ role: "tool", callId: "bad", isError: true });
    expect(messages.at(-1)).toHaveProperty("text", expect.stringMatching(/invalid JSON/));
  });

  it("tells the model about a tool that doesn't exist", async () => {
    const deleting = call("delete_link", { id: "1" });
    const model = scriptedModel("Fake", [calls(deleting), text("I can't delete.")]);
    const { session, calls: made } = fakeSession();

    const result = await runChatTurn({ model, session, history: [], text: "delete it" });

    expect(result).toMatchObject({ ok: true, changes: [] });
    expect(made).toEqual([]);
    const answer = model.requests[1]?.messages.at(-1);
    expect(answer).toMatchObject({ role: "tool", callId: deleting.id, isError: true });
    expect(answer).toHaveProperty("text", expect.stringMatching(/delete_link/));
    expect(answer).toHaveProperty("text", expect.stringMatching(/save_link, search_links/));
  });

  it("stops after MAX_MODEL_CALLS and keeps the changes made", async () => {
    const steps = Array.from({ length: MAX_MODEL_CALLS + 1 }, (_, i) =>
      calls(save(`https://example.com/${i}`)),
    );
    const model = scriptedModel("Fake", steps);
    const { session } = fakeSession();

    const result = await runChatTurn({ model, session, history: [], text: "loop" });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("reason", expect.stringContaining(`${MAX_MODEL_CALLS} steps`));
    expect(result.changes).toHaveLength(MAX_MODEL_CALLS);
    expect(model.requests).toHaveLength(MAX_MODEL_CALLS);
  });

  it("lets a running tool call finish past the deadline, then stops", async () => {
    const time = clock();
    const model = scriptedModel("Fake", [calls(save("https://example.com/a")), text("never")]);
    const { session } = fakeSession(() => {
      time.set(TURN_MS + 1);
      return undefined;
    });

    const result = await runChatTurn({ model, session, history: [], text: "s", now: time.now });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/took too long/) });
    expect(result.changes).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
  });

  it("starts no tool call with less than TOOL_CALL_MS left", async () => {
    const time = clock();
    const model = scriptedModel("Fake", [
      calls(save("https://example.com/a"), save("https://example.com/b")),
      text("never"),
    ]);
    const { session, calls: made } = fakeSession(() => {
      time.set(TURN_MS - TOOL_CALL_MS + 1);
      return undefined;
    });

    const result = await runChatTurn({ model, session, history: [], text: "s", now: time.now });

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/took too long/) });
    expect(result.changes).toHaveLength(1);
    expect(made).toHaveLength(1);
  });

  it("aborts a model call TOOL_RESERVE_MS before the deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const model = scriptedModel("Fake", [
      (request) =>
        new Promise<ModelReply>((_, reject) => {
          signal = request.signal;
          request.signal.addEventListener("abort", () => reject(new AiUnavailable("it timed out")));
        }),
    ]);
    const { session } = fakeSession();

    const turn = runChatTurn({ model, session, history: [], text: "s", now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(TURN_MS - TOOL_RESERVE_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);

    expect(await turn).toMatchObject({ ok: false, reason: "it timed out" });
  });

  it("aborts a model call when the server stops, and says so", async () => {
    const stop = new AbortController();
    const model = scriptedModel("Fake", [
      (request) =>
        new Promise<ModelReply>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new AiUnavailable("it timed out")));
          stop.abort();
        }),
    ]);
    const { session } = fakeSession();

    const result = await runChatTurn({
      model,
      session,
      history: [],
      text: "s",
      signal: stop.signal,
    });

    expect(result).toMatchObject({ ok: false, reason: "the server is stopping" });
  });

  it("leaves nothing listening on the server's signal or timer once the turn ends", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const model = scriptedModel("Fake", [text("hi")]);
    const { session } = fakeSession();

    await runChatTurn({ model, session, history: [], text: "s", signal: stop.signal });
    const used = model.requests[0]?.signal;
    stop.abort();
    await vi.advanceTimersByTimeAsync(TURN_MS);

    expect(used?.aborted).toBe(false);
  });

  it("runs none of a cut-off reply's tool calls, and keeps the changes made", async () => {
    const model = scriptedModel("Fake", [
      calls(save("https://example.com/a")),
      { ...calls(save("https://example.com/b")), truncated: true },
      text("never"),
    ]);
    const { session, calls: made } = fakeSession();

    const result = await runChatTurn({ model, session, history: [], text: "s" });

    expect(result).toMatchObject({ ok: false, reason: "its reply was cut off" });
    expect(result.changes).toHaveLength(1);
    expect(made).toHaveLength(1);
    expect(model.requests).toHaveLength(2);
  });

  it("keeps the changes when the model fails partway", async () => {
    const model = scriptedModel("Fake", [
      calls(save("https://example.com/a")),
      new AiUnavailable("the connection timed out"),
    ]);
    const { session } = fakeSession();

    const result = await runChatTurn({ model, session, history: [], text: "s" });

    expect(result).toMatchObject({ ok: false, reason: "the connection timed out" });
    expect(result.changes).toHaveLength(1);
  });

  it("ends with the changes so far when the session throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = scriptedModel("Fake", [
      calls(save("https://example.com/a"), save("https://example.com/b")),
    ]);
    const { session } = fakeSession((_name, _args, n) => {
      if (n === 2) throw new TypeError("boom");
      return undefined;
    });

    const result = await runChatTurn({ model, session, history: [], text: "s" });

    expect(result).toMatchObject({ ok: false, reason: "something went wrong on the server" });
    expect(result.changes).toHaveLength(1);
    expect(logged).toHaveBeenCalledOnce();
  });

  it("says so when the model answers with nothing", async () => {
    const model = scriptedModel("Fake", [text("  ")]);
    const { session } = fakeSession();

    const result = await runChatTurn({ model, session, history: [], text: "s" });

    expect(result).toMatchObject({ ok: true, changes: [] });
    expect(result).toHaveProperty("reply", expect.stringMatching(/Fake gave no answer/));
  });

  it("works the real tools as the owner", async () => {
    const db = openDatabase(":memory:");
    const deps = createDeps(db, new FakeEmbedder(DIMS));
    const caller: Caller = { owner: "owner-a", savedBy: "In-app AI (Fake)" };
    deps.store.ensureUser(caller.owner, caller.owner);
    const session = await openToolSession(deps, caller, createCallTracker().track);
    try {
      const model = scriptedModel("Fake", [calls(save("https://example.com/a")), text("Saved.")]);

      const result = await runChatTurn({ model, session, history: [], text: "save it" });

      expect(result).toEqual({
        ok: true,
        reply: "Saved.",
        changes: [{ kind: "link", tool: "save_link", linkId: "1", created: true, fields: [] }],
        seen: ["1"],
      });
      expect(db.prepare("SELECT owner_id, saved_by FROM links").all()).toEqual([
        { owner_id: "owner-a", saved_by: "In-app AI (Fake)" },
      ]);
    } finally {
      await session.close();
      db.close();
    }
  });
});

describe("takeTurn", () => {
  const user = (t = "q") => ({ role: "user", text: t });
  const assistant = (t = "a") => ({ role: "assistant", text: t });

  it("accepts an empty history or alternating turns starting with user and ending with assistant", () => {
    expect(takeTurn({ history: [], text: "hello" })).toEqual({ history: [], text: "hello" });
    const long = Array.from({ length: MAX_HISTORY }, (_, i) => (i % 2 ? assistant() : user()));
    expect(takeTurn({ history: long, text: "hello" })?.history).toHaveLength(MAX_HISTORY);
    expect(takeTurn({ history: [{ ...user(), owner: "x" }, assistant()], text: "hello" })).toEqual({
      history: [user(), assistant()],
      text: "hello",
    });
  });

  it("refuses a tool or system role, a bad order, more than MAX_HISTORY turns, a user turn over MAX_TURN_CHARS, or text that is empty or over MAX_TEXT_CHARS", () => {
    const refused = [
      { history: [user(), { role: "tool", text: "x" }], text: "q" },
      { history: [{ role: "system", text: "x" }, assistant()], text: "q" },
      { history: [assistant(), user()], text: "q" },
      { history: [user()], text: "q" },
      { history: [user(), assistant(), assistant(), user()], text: "q" },
      {
        history: Array.from({ length: MAX_HISTORY + 2 }, (_, i) => (i % 2 ? assistant() : user())),
        text: "q",
      },
      { history: [user("x".repeat(MAX_TURN_CHARS + 1)), assistant()], text: "q" },
      { history: [], text: "  " },
      { history: [], text: "x".repeat(MAX_TEXT_CHARS + 1) },
      { history: [], text: 5 },
      { history: "nope", text: "q" },
      { history: [user(), { role: "assistant", text: 5 }], text: "q" },
    ];
    for (const body of refused) expect(takeTurn(body), JSON.stringify(body)).toBeNull();
  });

  it("refuses an assistant or user turn that is empty", () => {
    expect(takeTurn({ history: [user(), assistant(" \n")], text: "q" })).toBeNull();
    expect(takeTurn({ history: [user(""), assistant()], text: "q" })).toBeNull();
  });

  it("shortens an assistant turn over MAX_TURN_CHARS instead of refusing it", () => {
    const long = `${"a".repeat(MAX_TURN_CHARS)}tail`;
    const taken = takeTurn({ history: [user(), assistant(long)], text: "q" });
    expect(taken?.history[1]).toEqual({
      role: "assistant",
      text: `${"a".repeat(MAX_TURN_CHARS)}…`,
    });
  });
});
