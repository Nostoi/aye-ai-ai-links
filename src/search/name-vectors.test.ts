import { describe, expect, it } from "vitest";
import type { Embedder } from "./embedder.js";
import { createNameVectors } from "./name-vectors.js";

/** An embedder that records each batch and answers when told to. */
function countingEmbedder() {
  const calls: string[][] = [];
  const waiting: { resolve(): void; reject(e: Error): void }[] = [];
  let hold = false;
  const embedder: Embedder = {
    embedQuery: () => Promise.reject(new Error("names are documents, not queries")),
    embedDocuments(texts) {
      calls.push(texts);
      const done = Promise.resolve(texts.map((t) => Float32Array.of(t.length)));
      if (!hold) return done;
      return new Promise((resolve, reject) =>
        waiting.push({ resolve: () => resolve(done), reject }),
      ).then((v) => v as Float32Array[]);
    },
  };
  return {
    embedder,
    calls,
    holdAnswers: () => {
      hold = true;
    },
    answer: () => waiting.shift()?.resolve(),
    fail: (e: Error) => waiting.shift()?.reject(e),
  };
}

describe("createNameVectors", () => {
  it("embeds one name per call, as a document", async () => {
    const c = countingEmbedder();
    const names = createNameVectors(c.embedder);
    expect(await names.vectorOf("game art")).toEqual(Float32Array.of(8));
    await names.vectorOf("pixel");
    expect(c.calls).toEqual([["game art"], ["pixel"]]);
  });

  it("embeds a name once: later asks come from the cache", async () => {
    const c = countingEmbedder();
    const names = createNameVectors(c.embedder);
    await names.vectorOf("game art");
    await names.vectorOf("game art");
    expect(c.calls).toEqual([["game art"]]);
  });

  it("shares one embedding between asks made while it is pending", async () => {
    const c = countingEmbedder();
    c.holdAnswers();
    const names = createNameVectors(c.embedder);
    const first = names.vectorOf("game art");
    const second = names.vectorOf("game art");
    c.answer();
    expect(await first).toEqual(await second);
    expect(c.calls).toEqual([["game art"]]);
  });

  it("drops a failed embedding, so a later ask tries again", async () => {
    const c = countingEmbedder();
    c.holdAnswers();
    const names = createNameVectors(c.embedder);
    const failed = names.vectorOf("game art");
    c.fail(new Error("model busy"));
    await expect(failed).rejects.toThrow("model busy");
    const retried = names.vectorOf("game art");
    c.answer();
    expect(await retried).toEqual(Float32Array.of(8));
    expect(c.calls).toEqual([["game art"], ["game art"]]);
  });
});
