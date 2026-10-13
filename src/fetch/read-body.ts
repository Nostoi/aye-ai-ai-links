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

/** Every decoder is built before the first byte is read, so a header stacking thousands would cost memory per request. */
const MAX_CODINGS = 1;

/**
 * The `Content-Encoding` header, every line of it, as decoder names in the order to apply them, or
 * undefined if any is unknown or there is more than one.
 */
export function decodersFor(header: string | string[] | undefined): string[] | undefined {
  const applied = [header ?? ""]
    .flat()
    .join(",")
    .toLowerCase()
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && name !== "identity");
  if (applied.length > MAX_CODINGS || !applied.every((name) => name in DECODERS)) return undefined;
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
