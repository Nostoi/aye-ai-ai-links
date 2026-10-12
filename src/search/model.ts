import { join } from "node:path";

/** Everything that identifies the meaning-search model lives here. */
export const MODEL_ID = "Xenova/bge-small-en-v1.5";
export const REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
export const DTYPE = "q8";
export const POOLING = "cls";
export const DIMS = 384;
/** Put on queries only; documents get none. */
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
export const MODEL_KEY = `bge-small-en-v1.5@${REVISION.slice(0, 8)}/${DTYPE}/${POOLING}`;

export type ManifestFile = { path: string; sha256: string; bytes: number };
export type Manifest = readonly ManifestFile[];

export const MANIFEST: Manifest = [
  {
    path: "config.json",
    sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350",
    bytes: 683,
  },
  {
    path: "tokenizer.json",
    sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    bytes: 711_396,
  },
  {
    path: "tokenizer_config.json",
    sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
    bytes: 366,
  },
  {
    path: "onnx/model_quantized.onnx",
    sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
    bytes: 34_014_426,
  },
];

/** The folder under the model root that holds this model's files. */
export function revisionDir(root: string): string {
  return join(root, MODEL_KEY.replace(/[^A-Za-z0-9._-]+/g, "_"));
}

export type Canary = {
  sentence: string;
  /** The first values of the sentence's normalized embedding. */
  first8: readonly number[];
  /** Largest allowed difference per leading value. */
  tolerance: number;
  /** Largest allowed distance of the vector's length from 1. */
  normTolerance: number;
};

/** A load is accepted only if the sentence embeds to these values. */
export const CANARY: Canary = {
  sentence: "A guide to storing solar power in a home battery",
  first8: [-0.046844, 0.055442, 0.025861, 0.011961, 0.002577, 0.047962, 0.008102, -0.030057],
  tolerance: 1e-4,
  normTolerance: 1e-3,
};
