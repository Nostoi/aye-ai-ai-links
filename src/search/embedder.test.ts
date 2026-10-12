import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "./embedder.js";

describe("FakeEmbedder", () => {
  it("gives vectors of the requested size with unit length", async () => {
    for (const dims of [3, 8, 384]) {
      const [v] = await new FakeEmbedder(dims).embedDocuments(["x"]);
      expect(v?.length).toBe(dims);
      expect(Math.hypot(...(v as Float32Array))).toBeCloseTo(1, 5);
    }
  });

  it("is deterministic and tells texts apart", async () => {
    const a = new FakeEmbedder(16);
    const b = new FakeEmbedder(16);
    expect(await a.embedQuery("solar")).toEqual(await b.embedQuery("solar"));
    expect(await a.embedQuery("solar")).not.toEqual(await a.embedQuery("soup"));
  });

  it("rejects a query whose signal has already aborted, with the signal's reason", async () => {
    const reason = new Error("expired");
    await expect(new FakeEmbedder(8).embedQuery("a", AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
    const live = new AbortController().signal;
    await expect(new FakeEmbedder(8).embedQuery("a", live)).resolves.toHaveLength(8);
  });

  it("keeps document order and embeds a query like a document", async () => {
    const e = new FakeEmbedder(8);
    const docs = await e.embedDocuments(["a", "b"]);
    expect(docs[0]).toEqual(await e.embedQuery("a"));
    expect(docs[1]).toEqual(await e.embedQuery("b"));
  });
});
