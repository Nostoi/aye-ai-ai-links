import type { Readable } from "node:stream";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

export class BodyTooLargeError extends Error {}

const DECODERS: Record<string, () => zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress> = {
  gzip: zlib.createGunzip,
  "x-gzip": zlib.createGunzip,
  deflate: zlib.createInflate,
  br: zlib.createBrotliDecompress,
};

/** The `Content-Encoding` header as decoder names in the order to apply them, or undefined if any is unknown. */
export function decodersFor(header: string | undefined): string[] | undefined {
  const applied = (header ?? "")
    .toLowerCase()
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && name !== "identity");
  if (!applied.every((name) => name in DECODERS)) return undefined;
  return applied.reverse();
}

/**
 * Reads a response body through the given decoders. `maxBytes` counts the decoded bytes, so a small
 * compressed bomb is stopped as soon as it grows past the cap, and every stream is destroyed.
 */
export async function readBody(
  body: Readable,
  decoders: string[],
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const collect = new Writable({
    write(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      if (total > maxBytes) return done(new BodyTooLargeError(`body over ${maxBytes} bytes`));
      chunks.push(chunk);
      done();
    },
  });
  const decode = decoders.map((name) => (DECODERS[name] as () => zlib.Gunzip)());
  await pipeline([body, ...decode, collect], { signal });
  return Buffer.concat(chunks);
}
