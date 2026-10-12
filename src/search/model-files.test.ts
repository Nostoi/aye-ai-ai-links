import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "./model.js";
import { MODEL_ID, REVISION } from "./model.js";
import { installModelFiles, verifyModelFiles } from "./model-files.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const bodies: Record<string, Buffer> = {
  "a.json": Buffer.from('{"a":1}'),
  "sub/b.bin": Buffer.from("bbbbbbbbbbbb"),
};
const manifest: Manifest = Object.entries(bodies).map(([path, b]) => ({
  path,
  sha256: sha(b),
  bytes: b.length,
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aye-model-files-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function allFiles(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(root, join(prefix, e.name)) : [join(prefix, e.name)],
  );
}

function servingFetch(overrides: Record<string, () => Response> = {}) {
  const urls: string[] = [];
  const fn = (url: string) => {
    urls.push(url);
    const path = url
      .slice(url.indexOf("/resolve/") + "/resolve/".length)
      .replace(`${REVISION}/`, "");
    const make = overrides[path];
    return Promise.resolve(make ? make() : new Response(new Uint8Array(bodies[path] ?? [])));
  };
  return { fn, urls };
}

describe("installModelFiles", () => {
  it("downloads every file from the pinned revision and places it", async () => {
    const f = servingFetch();
    await installModelFiles(dir, manifest, f.fn);
    for (const [path, b] of Object.entries(bodies)) {
      expect(readFileSync(join(dir, path)).equals(b)).toBe(true);
    }
    expect(f.urls).toContain(`https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/sub/b.bin`);
    expect(allFiles(dir).sort()).toEqual(["a.json", "sub/b.bin"]);
  });

  it("does not fetch when every file is valid", async () => {
    await installModelFiles(dir, manifest, servingFetch().fn);
    const second = servingFetch();
    await installModelFiles(dir, manifest, second.fn);
    expect(second.urls).toEqual([]);
  });

  it("fetches again a file whose bytes have the wrong hash", async () => {
    writeFileSync(join(dir, "a.json"), "partial");
    const f = servingFetch();
    await installModelFiles(dir, manifest, f.fn);
    expect(readFileSync(join(dir, "a.json")).equals(bodies["a.json"] as Buffer)).toBe(true);
    expect(f.urls.filter((u) => u.endsWith("a.json"))).toHaveLength(1);
  });

  it("throws on wrong bytes, leaves nothing at that path or as a temp file, and still places the others", async () => {
    const f = servingFetch({ "a.json": () => new Response("wrong bytes") });
    await expect(installModelFiles(dir, manifest, f.fn)).rejects.toThrow(/a\.json/);
    expect(allFiles(dir)).toEqual(["sub/b.bin"]);
  });

  it("removes the temp file when the fetch throws", async () => {
    const f = servingFetch({
      "a.json": () => {
        throw new Error("network down");
      },
    });
    await expect(installModelFiles(dir, manifest, f.fn)).rejects.toThrow(/a\.json/);
    expect(allFiles(dir)).toEqual(["sub/b.bin"]);
  });

  it("removes the temp file when the body errors partway", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
        c.error(new Error("connection reset"));
      },
    });
    const f = servingFetch({ "a.json": () => new Response(body) });
    await expect(installModelFiles(dir, manifest, f.fn)).rejects.toThrow(/a\.json/);
    expect(allFiles(dir)).toEqual(["sub/b.bin"]);
  });

  it("stops reading an oversized body soon after it passes the pinned size", async () => {
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 800) return c.close();
        sent++;
        c.enqueue(chunk);
      },
    });
    const f = servingFetch({ "a.json": () => new Response(body) });
    await expect(installModelFiles(dir, manifest, f.fn)).rejects.toThrow(/a\.json/);
    expect(sent).toBeLessThan(50);
    expect(allFiles(dir)).toEqual(["sub/b.bin"]);
  });

  it("removes temp files an interrupted install left beside the manifest files", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.json.1234.part"), "x");
    writeFileSync(join(dir, "sub/b.bin.5678.part"), "x");
    writeFileSync(join(dir, "keep.part"), "x");
    await installModelFiles(dir, manifest, servingFetch().fn);
    expect(allFiles(dir).sort()).toEqual(["a.json", "keep.part", "sub/b.bin"]);
  });

  it("rejects an HTTP error status without writing the error page", async () => {
    const f = servingFetch({ "a.json": () => new Response("nope", { status: 404 }) });
    await expect(installModelFiles(dir, manifest, f.fn)).rejects.toThrow(/a\.json/);
    expect(allFiles(dir)).toEqual(["sub/b.bin"]);
  });
});

describe("verifyModelFiles", () => {
  it("accepts a complete, correct directory", async () => {
    await installModelFiles(dir, manifest, servingFetch().fn);
    await expect(verifyModelFiles(dir, manifest)).resolves.toBeUndefined();
  });

  it("names a missing file", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub/b.bin"), bodies["sub/b.bin"] as Buffer);
    await expect(verifyModelFiles(dir, manifest)).rejects.toThrow(/a\.json/);
  });

  it("names a file with the right size but the wrong hash", async () => {
    await installModelFiles(dir, manifest, servingFetch().fn);
    writeFileSync(join(dir, "sub/b.bin"), "c".repeat(bodies["sub/b.bin"]?.length ?? 0));
    const err = await verifyModelFiles(dir, manifest).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/sub\/b\.bin/);
    expect((err as Error).message).not.toMatch(/a\.json/);
  });

  it("names a file with the wrong size", async () => {
    await installModelFiles(dir, manifest, servingFetch().fn);
    writeFileSync(join(dir, "a.json"), "x");
    await expect(verifyModelFiles(dir, manifest)).rejects.toThrow(/a\.json/);
  });
});
