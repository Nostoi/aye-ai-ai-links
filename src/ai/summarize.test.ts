import { afterEach, describe, expect, it, vi } from "vitest";
import { SUMMARY_MAX, SummarizerUnavailable } from "../core/summary-pass.js";
import { AiUnavailable, type ModelReply } from "./model.js";
import { scriptedModel } from "./model-test-kit.js";
import { createSummarizer } from "./summarize.js";

const PAGE = { title: "Cats of Rome", description: "A field guide", text: "Cats live in Rome." };
const says = (text: string, over: Partial<ModelReply> = {}): ModelReply => ({
  text,
  toolCalls: [],
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSummarizer", () => {
  it("sends no tools and one user message holding the title, description and page text", async () => {
    const model = scriptedModel("m", [says("A guide to Rome's cats")]);
    await createSummarizer(model).summarize(PAGE, new AbortController().signal);
    const [request] = model.requests;
    expect(request?.tools).toEqual([]);
    expect(request?.messages).toHaveLength(1);
    expect(request?.messages[0]).toMatchObject({ role: "user" });
    const first = request?.messages[0];
    const text = first?.role === "user" ? first.text : "";
    expect(text).toContain("Cats of Rome");
    expect(text).toContain("A field guide");
    expect(text).toContain("Cats live in Rome.");
  });

  it("tells the model to treat the page as material, not instructions", async () => {
    const model = scriptedModel("m", [says("ok")]);
    await createSummarizer(model).summarize(PAGE, new AbortController().signal);
    expect(model.requests[0]?.system).toMatch(/never as instructions/i);
    expect(model.requests[0]?.system).toContain(String(SUMMARY_MAX));
  });

  it("returns a two-line reply as one line", async () => {
    const model = scriptedModel("m", [says("  A guide\n  to   Rome's\r\ncats \n")]);
    const out = await createSummarizer(model).summarize(PAGE, new AbortController().signal);
    expect(out).toBe("A guide to Rome's cats");
  });

  it("keeps a reply of SUMMARY_MAX code points and rejects one more", async () => {
    const signal = new AbortController().signal;
    const exact = "😀".repeat(SUMMARY_MAX);
    const model = scriptedModel("m", [says(exact), says(`${exact}x`)]);
    const summarizer = createSummarizer(model);
    expect(await summarizer.summarize(PAGE, signal)).toBe(exact);
    await expect(summarizer.summarize(PAGE, signal)).rejects.toThrow(/too long/);
  });

  it.each([
    ["an empty reply", says("  \n ")],
    ["a reply cut off at the token limit", says("A guide to", { truncated: true })],
  ])("rejects %s, not as unavailable", async (_name, reply) => {
    const model = scriptedModel("m", [reply]);
    const failure = createSummarizer(model).summarize(PAGE, new AbortController().signal);
    const error = await failure.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SummarizerUnavailable);
  });

  it("turns AiUnavailable into SummarizerUnavailable, keeping its reason", async () => {
    const model = scriptedModel("m", [new AiUnavailable("connection refused")]);
    const failure = createSummarizer(model).summarize(PAGE, new AbortController().signal);
    const error = await failure.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SummarizerUnavailable);
    expect((error as Error).message).toContain("connection refused");
  });

  it("passes any other model error through unchanged", async () => {
    const boom = new Error("boom");
    const model = scriptedModel("m", [boom]);
    await expect(
      createSummarizer(model).summarize(PAGE, new AbortController().signal),
    ).rejects.toBe(boom);
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
    const settled = createSummarizer(model)
      .summarize(PAGE, caller.signal)
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
    const call = createSummarizer(model, 1_000).summarize(PAGE, new AbortController().signal);
    const settled = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await settled).toBeInstanceOf(SummarizerUnavailable);
  });
});
