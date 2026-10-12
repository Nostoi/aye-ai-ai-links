import { createHash } from "node:crypto";

export interface Embedder {
  embedQuery(text: string): Promise<Float32Array>;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
}

/** Deterministic stand-in for tests: the same text gives the same unit vector. */
export class FakeEmbedder implements Embedder {
  constructor(readonly dims: number) {}

  embedQuery(text: string): Promise<Float32Array> {
    return Promise.resolve(this.vector(text));
  }

  embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return Promise.resolve(texts.map((t) => this.vector(t)));
  }

  private vector(text: string): Float32Array {
    const out = new Float32Array(this.dims);
    const chunks: Buffer[] = [];
    for (let round = 0; chunks.length * 32 < this.dims * 4; round++) {
      chunks.push(createHash("sha256").update(`${round}:${text}`).digest());
    }
    const bytes = Buffer.concat(chunks);
    for (let i = 0; i < this.dims; i++) out[i] = bytes.readUInt32LE(i * 4) / 0xffffffff - 0.5;
    const norm = Math.hypot(...out);
    return out.map((x) => x / norm);
  }
}
