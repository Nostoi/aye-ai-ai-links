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

  it.each([
    ["double quotes", '"A guide to Rome’s cats"'],
    ["single quotes", "'A guide to Rome’s cats'"],
    ["curly double quotes", "“A guide to Rome’s cats”"],
    ["curly single quotes", "‘A guide to Rome’s cats’"],
    ["a heading marker", "# A guide to Rome’s cats"],
    ["a bullet", "- A guide to Rome’s cats"],
    ["a star bullet", "* A guide to Rome’s cats"],
    ["a quote marker", "> A guide to Rome’s cats"],
    ["bold stars", "**A guide to Rome’s cats**"],
    ["bold underscores", "__A guide to Rome’s cats__"],
    ["a bullet and quotes", '- "A guide to Rome’s cats"'],
    ["quotes and surrounding space", '  "A guide to Rome’s cats"  '],
  ])("strips %s from the reply", async (_name, text) => {
    const model = scriptedModel("m", [says(text)]);
    const out = await createSummarizer(model).summarize(PAGE, new AbortController().signal);
    expect(out).toBe("A guide to Rome’s cats");
  });

  it.each([
    "The “cats” of Rome",
    "Rome’s cats, a guide to the city’s strays’",
    "-5 degrees in Rome",
    "A *very* short guide",
  ])("leaves %s as it is", async (text) => {
    const model = scriptedModel("m", [says(text)]);
    const out = await createSummarizer(model).summarize(PAGE, new AbortController().signal);
    expect(out).toBe(text);
  });

  it("checks the length after stripping a wrapping quote", async () => {
    const exact = "x".repeat(SUMMARY_MAX);
    const model = scriptedModel("m", [says(`"${exact}"`)]);
    expect(await createSummarizer(model).summarize(PAGE, new AbortController().signal)).toBe(exact);
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
