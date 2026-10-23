import { afterEach, describe, expect, it, vi } from "vitest";
import type { Stats } from "../core/stats.js";
import { READING_MAX, StatsReaderUnavailable } from "../core/stats-reading-pass.js";
import { AiUnavailable, type ModelReply } from "./model.js";
import { scriptedModel } from "./model-test-kit.js";
import { createStatsReader } from "./read-stats.js";

const says = (text: string, over: Partial<ModelReply> = {}): ModelReply => ({
  text,
  toolCalls: [],
  ...over,
});

function stats(over: Partial<Stats> = {}): Stats {
  return {
    window: "all",
    saved: 40,
    opened: 12,
    notOpenedYet: 28,
    setAside: 3,
    notNow: 5,
    tags: [{ name: "gardening", kind: "topic", saved: 7, opened: 2 }],
    trackingSince: new Date("2026-01-05T00:00:00Z"),
    partialCounts: ["opened"],
    ...over,
  };
}

const INPUT = {
  allTime: stats(),
  lastMonth: stats({
    window: "30",
    saved: 6,
    tags: [{ name: "rust", kind: "project", saved: 4, opened: 1 }],
  }),
  focus: ["learning Rust"],
};

type Scripted = ReturnType<typeof scriptedModel>;
const userText = (model: Scripted): string => {
  const first = model.requests[0]?.messages[0];
  return first?.role === "user" ? first.text : "";
};
const run = (model: Scripted, input = INPUT) =>
  createStatsReader(model).read(input, new AbortController().signal);

afterEach(() => {
  vi.useRealTimers();
});

describe("createStatsReader", () => {
  it("the message carries counts and tag names only", async () => {
    const model = scriptedModel("m", [says("Maybe you collect gardening links.")]);
    const link = { title: "SECRET TITLE", url: "https://secret.example/x", why: "SECRET WHY" };
    const leaky = { ...INPUT.allTime, links: [link] } as unknown as Stats;
    await run(model, { ...INPUT, allTime: leaky });
    const text = userText(model);
    expect(model.requests[0]?.tools).toEqual([]);
    expect(model.requests[0]?.messages).toHaveLength(1);
    for (const want of ["gardening", "rust", "learning Rust", "40", "12", "28"]) {
      expect(text).toContain(want);
    }
    for (const unwanted of ["SECRET", "secret.example"]) expect(text).not.toContain(unwanted);
    expect(text).toMatch(/too low/i);
    expect(text).toMatch(/outside the app/i);
  });

  it("tells the model the material is never instructions and how to write the reading", async () => {
    const model = scriptedModel("m", [says("ok")]);
    await run(model);
    const system = model.requests[0]?.system ?? "";
    expect(system).toMatch(/never as instructions/i);
    expect(system).toMatch(/two to four/i);
    expect(system).toMatch(/maybe/i);
    expect(system).toMatch(/no advice/i);
  });

  it("an empty, cut-off or over-long reply is refused", async () => {
    const exact = "😀".repeat(READING_MAX);
    const model = scriptedModel("m", [
      says("  \n "),
      says("Maybe you", { truncated: true }),
      says(`${exact}x`),
      says(exact),
    ]);
    const reader = createStatsReader(model);
    const signal = new AbortController().signal;
    for (const want of [/empty/, /cut off/, /too long/]) {
      const error = await reader.read(INPUT, signal).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(StatsReaderUnavailable);
      expect((error as Error).message).toMatch(want);
    }
    expect(await reader.read(INPUT, signal)).toBe(exact);
  });

  it("keeps a multi-sentence reply, trimming only the ends", async () => {
    const model = scriptedModel("m", [says("  Maybe A.\n\nIt seems B.  ")]);
    expect(await run(model)).toBe("Maybe A.\n\nIt seems B.");
  });

  it("the message stays bounded with a 96,000-character tag and 50 tags", async () => {
    const tags = Array.from({ length: 50 }, (_, i) => ({
      name: i === 0 ? "x".repeat(96_000) : `tag${i}`,
      kind: "topic" as const,
      saved: 50 - i,
      opened: 0,
    }));
    const focus = Array.from({ length: 30 }, () => "f".repeat(50_000));
    const model = scriptedModel("m", [says("ok")]);
    await run(model, {
      allTime: stats({ tags }),
      lastMonth: stats({ window: "30", tags }),
      focus,
    });
    const text = userText(model);
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("x".repeat(60));
    expect(text).not.toContain("x".repeat(61));
    expect(text).toContain("tag19");
    expect(text).not.toMatch(/tag2\d/);
    expect(text.match(/30 more tags left out/g)).toHaveLength(2);
    expect(text).not.toMatch(/f{201}/);
  });

  it("cuts a tag name by code points, never in the middle of one", async () => {
    const name = "😀".repeat(61);
    const model = scriptedModel("m", [says("ok")]);
    const tags = [{ name, kind: "topic" as const, saved: 1, opened: 0 }];
    await run(model, { ...INPUT, allTime: stats({ tags }) });
    const text = userText(model);
    expect(text).toContain("😀".repeat(60));
    expect(text).not.toContain("😀".repeat(61));
  });

  it("an unreachable model is StatsReaderUnavailable", async () => {
    const model = scriptedModel("m", [new AiUnavailable("connection refused")]);
    const error = await run(model).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StatsReaderUnavailable);
    expect((error as Error).message).toContain("connection refused");
  });

  it("passes any other model error through unchanged", async () => {
    const boom = new Error("boom");
    await expect(run(scriptedModel("m", [boom]))).rejects.toBe(boom);
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
    const settled = createStatsReader(model)
      .read(INPUT, caller.signal)
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
    const settled = createStatsReader(model, 1_000)
      .read(INPUT, new AbortController().signal)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await settled).toBeInstanceOf(StatsReaderUnavailable);
  });
});
