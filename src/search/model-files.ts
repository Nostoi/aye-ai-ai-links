import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Manifest, ManifestFile } from "./model.js";
import { MODEL_ID, REVISION } from "./model.js";

export type FetchFn = (url: string) => Promise<Response>;

async function problem(dir: string, file: ManifestFile): Promise<string | null> {
  const path = join(dir, file.path);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return "missing";
  }
  if (size !== file.bytes) return `has ${size} bytes, expected ${file.bytes}`;
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex") === file.sha256 ? null : "has the wrong sha256";
}

/** Throws an error naming every file that is missing or differs from the manifest. */
export async function verifyModelFiles(dir: string, manifest: Manifest): Promise<void> {
  const bad: string[] = [];
  for (const file of manifest) {
    const why = await problem(dir, file);
    if (why) bad.push(`${file.path} ${why}`);
  }
  if (bad.length > 0)
    throw new Error(`Model files are not as pinned in ${dir}: ${bad.join("; ")}.`);
}

async function download(dir: string, file: ManifestFile, fetchFn: FetchFn): Promise<void> {
  const final = join(dir, file.path);
  const temp = `${final}.${randomUUID()}.part`;
  try {
    await mkdir(dirname(final), { recursive: true });
    const res = await fetchFn(
      `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/${file.path}`,
    );
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        if (bytes > file.bytes)
          return cb(new Error(`the download is larger than ${file.bytes} bytes`));
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      counter,
      createWriteStream(temp),
    );
    if (bytes !== file.bytes || hash.digest("hex") !== file.sha256) {
      throw new Error("the download does not match the pinned size and sha256");
    }
    await rename(temp, final);
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Makes every manifest file present and correct, fetching only those that are not.
 * Each download goes to a temp file beside its destination and is renamed into place only
 * after its size and sha256 match. Every file is tried; failures are reported together.
 */
export async function installModelFiles(
  dir: string,
  manifest: Manifest,
  fetchFn: FetchFn,
): Promise<void> {
  const failed: string[] = [];
  for (const file of manifest) {
    const final = join(dir, file.path);
    const prefix = `${basename(final)}.`;
    const siblings = await readdir(dirname(final)).catch(() => []);
    for (const name of siblings) {
      if (name.startsWith(prefix) && name.endsWith(".part")) {
        await rm(join(dirname(final), name), { force: true });
      }
    }
    if ((await problem(dir, file)) === null) continue;
    try {
      await download(dir, file, fetchFn);
    } catch (err) {
      failed.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed.length > 0)
    throw new Error(`Could not install the model files: ${failed.join("; ")}.`);
}
