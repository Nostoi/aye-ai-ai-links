import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Canary } from "./model.js";
import { QUERY_PREFIX } from "./model.js";
import { checkCanary, createQueuedEmbedder, type RunFn } from "./transformers-embedder.js";

const unit = (n: number) => Float32Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));

function trackingRun(opts: { failOn?: string } = {}) {
  const seen: string[][] = [];
  let active = 0;
  let max = 0;
  const run: RunFn = async (texts) => {
    seen.push(texts);
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (opts.failOn !== undefined && texts.includes(opts.failOn))
      throw new Error("inference failed");
    return texts.map(() => unit(4));
  };
  return { run, seen, maxActive: () => max };
}

describe("createQueuedEmbedder", () => {
  it("runs at most one inference at a time across query and document calls", async () => {
    const t = trackingRun();
    const e = createQueuedEmbedder(t.run);
    await Promise.all([
      e.embedQuery("q1"),
      e.embedDocuments(["d1", "d2"]),
      e.embedQuery("q2"),
      e.embedDocuments(["d3"]),
    ]);
    expect(t.seen).toHaveLength(4);
    expect(t.maxActive()).toBe(1);
  });

  it("runs the next call after one is rejected", async () => {
    const t = trackingRun({ failOn: "bad" });
    const e = createQueuedEmbedder(t.run);
    const first = e.embedDocuments(["bad"]);
    const second = e.embedDocuments(["good"]);
    await expect(first).rejects.toThrow("inference failed");
    await expect(second).resolves.toHaveLength(1);
  });

  it("prefixes queries and not documents", async () => {
    const t = trackingRun();
    const e = createQueuedEmbedder(t.run);
    await e.embedQuery("solar");
    await e.embedDocuments(["solar"]);
    expect(t.seen).toEqual([[`${QUERY_PREFIX}solar`], ["solar"]]);
  });

  it("returns one vector per document, in order", async () => {
    const e = createQueuedEmbedder(async (texts) => texts.map((t) => Float32Array.of(t.length)));
    const out = await e.embedDocuments(["a", "bbb", "cc"]);
    expect(out.map((v) => v[0])).toEqual([1, 3, 2]);
  });
});

describe("checkCanary", () => {
  const first8 = [0.5, -0.25, 0.125, 0, 0.0625, -0.5, 0.25, 0.1];
  const canary: Canary = { sentence: "s", first8, tolerance: 1e-4, normTolerance: 1e-3 };
  const dims = 16;
  function vector(overrides: (v: Float32Array) => void = () => {}) {
    const v = new Float32Array(dims);
    v.set(first8);
    const rest = 1 - first8.reduce((s, x) => s + x * x, 0);
    for (let i = 8; i < dims; i++) v[i] = Math.sqrt(rest / (dims - 8));
    overrides(v);
    return v;
  }

  it("accepts a vector matching the expected values", () => {
    expect(() => checkCanary(vector(), canary, dims)).not.toThrow();
  });

  it("accepts a difference within the tolerance", () => {
    const v = vector();
    v[0] = (v[0] as number) + 5e-5;
    expect(() => checkCanary(v, canary, dims)).not.toThrow();
  });

  it("rejects the wrong number of dimensions", () => {
    expect(() => checkCanary(vector().slice(0, 15), canary, dims)).toThrow(/dimension/i);
  });

  it("rejects NaN", () => {
    expect(() =>
      checkCanary(
        vector((v) => (v[12] = Number.NaN)),
        canary,
        dims,
      ),
    ).toThrow(/finite/i);
  });

  it("rejects a leading value outside the tolerance", () => {
    expect(() =>
      checkCanary(
        vector((v) => (v[3] = 0.001)),
        canary,
        dims,
      ),
    ).toThrow(/value 3/i);
  });

  it("rejects a vector that is not unit length", () => {
    const v = vector().map((x) => x * 1.01);
    expect(() => checkCanary(v, { ...canary, tolerance: 1 }, dims)).toThrow(/length/i);
  });
});

describe("lazy import", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });
  }
  // `import x from "pkg"`, `import "pkg"`, `export ... from "pkg"`; not `import("pkg")`.
  const staticImport =
    /(?:^|\n)\s*(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']@huggingface\/transformers["']/;

  it("detects a static import and ignores a dynamic one", () => {
    expect(staticImport.test('import { env } from "@huggingface/transformers";')).toBe(true);
    expect(staticImport.test('import "@huggingface/transformers";')).toBe(true);
    expect(staticImport.test('import type { X } from "@huggingface/transformers";')).toBe(true);
    expect(staticImport.test('const m = await import("@huggingface/transformers");')).toBe(false);
  });

  it("no source file imports @huggingface/transformers statically", () => {
    const offenders = sources(join(import.meta.dirname, "..")).filter((p) =>
      staticImport.test(readFileSync(p, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
