import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANARY, DIMS } from "./model.js";
import { loadTransformersEmbedder } from "./transformers-embedder.js";

// Runs only with AYE_MODEL_SMOKE set to a directory holding the four pinned model files.
const modelDir = process.env.AYE_MODEL_SMOKE;
const temps: string[] = [];

/** A copy of the model folder whose big file is linked rather than copied. */
function copyOfModel(): string {
  const dest = mkdtempSync(join(tmpdir(), "aye-model-smoke-"));
  temps.push(dest);
  for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json"]) {
    cpSync(join(modelDir as string, f), join(dest, f));
  }
  mkdirSync(join(dest, "onnx"));
  symlinkSync(
    join(modelDir as string, "onnx/model_quantized.onnx"),
    join(dest, "onnx/model_quantized.onnx"),
  );
  return dest;
}

afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe.skipIf(!modelDir)("transformers embedder with the real model", () => {
  it("loads and gives normalized vectors of the right size, with a prefix only on queries", async () => {
    const e = await loadTransformersEmbedder(modelDir as string);
    const q = await e.embedQuery(CANARY.sentence);
    const [d] = await e.embedDocuments([CANARY.sentence]);
    for (const v of [q, d as Float32Array]) {
      expect(v.length).toBe(DIMS);
      expect(Math.hypot(...v)).toBeCloseTo(1, 4);
    }
    expect(Array.from(q.slice(0, 8))).not.toEqual(Array.from((d as Float32Array).slice(0, 8)));
  });

  it("rejects a tokenizer_config.json whose model_max_length changed, though the canary would pass", async () => {
    const dir = copyOfModel();
    const path = join(dir, "tokenizer_config.json");
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/"model_max_length":\s*512/);
    writeFileSync(path, text.replace(/("model_max_length":\s*)512/, "$1128"));
    await expect(loadTransformersEmbedder(dir)).rejects.toThrow(/tokenizer_config\.json/);
  });

  it("rejects a missing tokenizer_config.json", async () => {
    const dir = copyOfModel();
    rmSync(join(dir, "tokenizer_config.json"));
    await expect(loadTransformersEmbedder(dir)).rejects.toThrow(/tokenizer_config\.json/);
  });

  it("compares the canary: an expectation that cannot match rejects intact files", async () => {
    const wrong = { ...CANARY, first8: CANARY.first8.map((x) => x + 0.01) };
    await expect(loadTransformersEmbedder(modelDir as string, { canary: wrong })).rejects.toThrow(
      /Canary value 0/,
    );
  });
});
