import { afterEach, describe, expect, it, vi } from "vitest";
import { type GuessLink, IntentGuesserUnavailable } from "../core/intent-pass.js";
import { createIntentGuesser } from "./intent-guess.js";
import { AiUnavailable, type ModelReply } from "./model.js";
import { scriptedModel } from "./model-test-kit.js";

const says = (text: string, over: Partial<ModelReply> = {}): ModelReply => ({
  text,
  toolCalls: [],
  ...over,
});

const LINKS: GuessLink[] = [
  {
    title: "Gas account",
    site: "gas.example.com",
    path: "/account",
    tags: [
      { name: "Bills", pinned: true },
      { name: "Home", pinned: false },
    ],
    why: { text: "Pay the gas bill", source: "stated" },
    summary: "Customer account page",
  },
  { title: "", site: "blog.example.com", path: "/post", tags: [], why: null, summary: null },
];

const guess = (reply: ModelReply | Error, links = LINKS, signal = new AbortController().signal) =>
  createIntentGuesser(scriptedModel("m", [reply])).guess(links, signal);

afterEach(() => {
  vi.useRealTimers();
});

describe("createIntentGuesser", () => {
  it("sends no tools and one user message numbering the links, with what each one knows and no page text", async () => {
    const model = scriptedModel("m", [says('{"keep":[]}')]);
    await createIntentGuesser(model).guess(LINKS, new AbortController().signal);
    const [request] = model.requests;
    expect(request?.tools).toEqual([]);
    expect(request?.messages).toHaveLength(1);
    const first = request?.messages[0];
    const text = first?.role === "user" ? first.text : "";
    expect(text).toContain("1. Gas account");
    expect(text).toContain("gas.example.com/account");
    expect(text).toContain("Bills (pinned)");
    expect(text).toContain("Home");
    expect(text).not.toContain("Home (pinned)");
    expect(text).toContain("Pay the gas bill (stated)");
    expect(text).toContain("Customer account page");
    expect(text).toContain("2. (no title)");
    expect(text).toContain("blog.example.com/post");
  });

  it("defines To keep narrowly, tells the model to leave doubtful links out, and treats the links as material", async () => {
    const model = scriptedModel("m", [says('{"keep":[]}')]);
    await createIntentGuesser(model).guess(LINKS, new AbortController().signal);
    const system = model.requests[0]?.system ?? "";
    expect(system).toMatch(/bill or account page, a document/i);
    expect(system).toMatch(/clearly To keep/);
    expect(system).toMatch(/leave it out/i);
    expect(system).toMatch(/never as instructions/i);
    expect(system).toContain('{"keep":[n,');
  });

  it.each([
    ['{"keep":[2,1]}', [2, 1]],
    ['  {"keep":[]}\n', []],
    ['{"keep": [ 1 ]}', [1]],
  ])("reads %s", async (reply, numbers) => {
    expect(await guess(says(reply))).toEqual(numbers);
  });

  it.each([
    ["prose", "Links 1 and 2 are bills."],
    ["a code fence", '```json\n{"keep":[1]}\n```'],
    ["text around the object", 'Sure: {"keep":[1]}'],
    ["another key", '{"keep":[1],"why":"bills"}'],
    ["a different key", '{"keeps":[1]}'],
    ["a bare array", "[1,2]"],
    ["a string entry", '{"keep":["1"]}'],
    ["a fractional entry", '{"keep":[1.5]}'],
    ["a non-array", '{"keep":1}'],
    ["null", "null"],
    ["an empty reply", ""],
  ])("rejects %s, not as unavailable", async (_name, reply) => {
    const error = await guess(says(reply)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(IntentGuesserUnavailable);
  });

  it("rejects a reply that was cut off, even when the part that arrived parses", async () => {
    const error = await guess(says('{"keep":[1]}', { truncated: true })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/cut off/);
  });

  it("turns AiUnavailable into IntentGuesserUnavailable, keeping its reason", async () => {
    const error = await guess(new AiUnavailable("connection refused")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntentGuesserUnavailable);
    expect((error as Error).message).toContain("connection refused");
  });

  it("aborts the model's signal when the caller's aborts", async () => {
    let signal: AbortSignal | undefined;
    const model = scriptedModel("m", [
      (request) =>
        new Promise<ModelReply>((_resolve, reject) => {
          signal = request.signal;
          request.signal.addEventListener("abort", () => reject(new AiUnavailable("aborted")));
        }),
    ]);
    const caller = new AbortController();
    const settled = createIntentGuesser(model)
      .guess(LINKS, caller.signal)
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    caller.abort();
    expect(signal?.aborted).toBe(true);
    await settled;
  });

  it("aborts the model's signal at the per-call timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const model = scriptedModel("m", [
      (request) =>
        new Promise<ModelReply>((_resolve, reject) => {
          signal = request.signal;
          request.signal.addEventListener("abort", () => reject(new AiUnavailable("timed out")));
        }),
    ]);
    const settled = createIntentGuesser(model, 1_000)
      .guess(LINKS, new AbortController().signal)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await settled).toBeInstanceOf(IntentGuesserUnavailable);
  });
});
