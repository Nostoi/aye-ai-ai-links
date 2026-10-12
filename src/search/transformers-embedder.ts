import { resolve } from "node:path";
import type { Embedder } from "./embedder.js";
import {
  CANARY,
  type Canary,
  DIMS,
  DTYPE,
  MANIFEST,
  type Manifest,
  POOLING,
  QUERY_PREFIX,
} from "./model.js";
import { verifyModelFiles } from "./model-files.js";

export type RunFn = (texts: string[]) => Promise<Float32Array[]>;

/**
 * Adds the query prefix and lets one inference run at a time across every caller. A call
 * that rejects does not stop the ones behind it.
 */
export function createQueuedEmbedder(run: RunFn): Embedder {
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue(texts: string[]): Promise<Float32Array[]> {
    const mine = tail.then(() => run(texts));
    tail = mine.catch(() => undefined);
    return mine;
  }
  return {
    embedQuery: async (text) => (await enqueue([QUERY_PREFIX + text]))[0] as Float32Array,
    embedDocuments: async (texts) => (texts.length === 0 ? [] : enqueue(texts)),
  };
}

/** Throws unless `vector` is the canary's normalized embedding, within its tolerances. */
export function checkCanary(vector: ArrayLike<number>, canary: Canary, dims: number): void {
  if (vector.length !== dims) {
    throw new Error(`Canary has ${vector.length} dimensions, expected ${dims}.`);
  }
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i] as number;
    if (!Number.isFinite(x)) throw new Error(`Canary value ${i} is not finite.`);
    sumSquares += x * x;
  }
  const length = Math.sqrt(sumSquares);
  if (Math.abs(length - 1) > canary.normTolerance) {
    throw new Error(`Canary vector length is ${length}, expected 1.`);
  }
  canary.first8.forEach((expected, i) => {
    const got = vector[i] as number;
    if (Math.abs(got - expected) > canary.tolerance) {
      throw new Error(`Canary value ${i} is ${got}, expected ${expected}.`);
    }
  });
}

export type LoadOptions = { manifest?: Manifest; canary?: Canary };

/**
 * Loads the pinned model from `revisionDir` with no network access. The files must match the
 * manifest, and the canary sentence must embed to its recorded values, or this throws.
 */
export async function loadTransformersEmbedder(
  revisionDir: string,
  { manifest = MANIFEST, canary = CANARY }: LoadOptions = {},
): Promise<Embedder> {
  await verifyModelFiles(revisionDir, manifest);
  // Imported here so that nothing which merely imports this module loads onnxruntime.
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  const extractor = await pipeline("feature-extraction", resolve(revisionDir), { dtype: DTYPE });
  const run: RunFn = async (texts) => {
    const out = await extractor(texts, { pooling: POOLING, normalize: true });
    const [rows, dims] = out.dims as [number, number];
    if (rows !== texts.length || dims !== DIMS) {
      throw new Error(`The model returned ${rows}x${dims}, expected ${texts.length}x${DIMS}.`);
    }
    const data = out.data as Float32Array;
    return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
  };
  const embedder = createQueuedEmbedder(run);
  const [vector] = await embedder.embedDocuments([canary.sentence]);
  checkCanary(vector as Float32Array, canary, DIMS);
  return embedder;
}
