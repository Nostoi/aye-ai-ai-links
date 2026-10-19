import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExportFolder } from "./export-folder.js";

const name = (owner: string) =>
  `${createHash("sha256").update(owner).digest("hex").slice(0, 32)}.zip`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aye-export-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const folder = async () => {
  const f = new ExportFolder(join(dir, "exports"));
  await f.reset();
  return f;
};
const commit = async (f: ExportFolder, owner: string, bytes: Buffer) => {
  const w = await f.create(owner);
  await w.write(bytes);
  return w.commit();
};
const opened = async (f: ExportFolder, owner: string) => {
  const d = await f.open(owner);
  if (!d) throw new Error("expected an export");
  return d;
};
const readAll = async (body: ReadableStream<Uint8Array>) =>
  Buffer.from(await new Response(body).arrayBuffer());

describe("ExportFolder", () => {
  it("commit renames a 0600 file into a 0700 folder named by the owner's hash, and answers its size", async () => {
    const f = await folder();
    const w = await f.create("A");
    await w.write(Buffer.from("PK"));
    await w.write(Buffer.alloc(70_000, 1));
    expect(readdirSync(join(dir, "exports"))).toEqual([
      expect.stringMatching(/^[0-9a-f]{32}\.zip\.tmp-[0-9a-f]{16}$/),
    ]);
    expect(await w.commit()).toBe(70_002);
    expect(readdirSync(join(dir, "exports"))).toEqual([name("A")]);
    expect(statSync(join(dir, "exports")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "exports", name("A"))).mode & 0o777).toBe(0o600);
  });

  it("open streams the whole file with its size; another owner gets null", async () => {
    const f = await folder();
    await commit(f, "A", Buffer.alloc(100_000, 7));
    const d = await f.open("A");
    expect(d?.size).toBe(100_000);
    expect(
      (await readAll(d?.body as ReadableStream<Uint8Array>)).equals(Buffer.alloc(100_000, 7)),
    ).toBe(true);
    expect(await f.open("B")).toBeNull();
  });

  it("an open download keeps the old bytes when a new export is renamed over it", async () => {
    const f = await folder();
    const size = 200 * 1024;
    await commit(f, "A", Buffer.alloc(size, 1));
    const reader = (await opened(f, "A")).body.getReader();
    const first = await reader.read();
    await commit(f, "A", Buffer.alloc(size, 2));
    const chunks = [first.value as Uint8Array];
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
    }
    const all = Buffer.concat(chunks);
    expect(all.length).toBe(size);
    expect(all.every((b) => b === 1)).toBe(true);
    const fresh = await readAll((await f.open("A"))?.body as ReadableStream<Uint8Array>);
    expect(fresh.every((b) => b === 2)).toBe(true);
  });

  it("discard leaves no temporary file, and a write to a closed handle fails without leaving one", async () => {
    const f = await folder();
    const w = await f.create("A");
    await w.write(Buffer.from("x"));
    await w.discard();
    expect(readdirSync(join(dir, "exports"))).toEqual([]);
    await w.discard();

    const w2 = await f.create("A");
    await w2.write(Buffer.from("x"));
    await w2.commit(); // closes the handle
    await expect(w2.write(Buffer.from("z"))).rejects.toThrow();
    await w2.discard();
    expect(readdirSync(join(dir, "exports"))).toEqual([name("A")]);
  });

  it("remove deletes the owner's export and tolerates none", async () => {
    const f = await folder();
    await commit(f, "A", Buffer.from("PK"));
    await f.remove("A");
    await f.remove("A");
    expect(existsSync(join(dir, "exports", name("A")))).toBe(false);
  });

  it("reset makes the folder 0700, deletes only the names a build makes, and refuses a symlinked folder", async () => {
    const exports = join(dir, "exports");
    mkdirSync(exports);
    chmodSync(exports, 0o755);
    writeFileSync(join(exports, name("A")), "x");
    writeFileSync(join(exports, `${name("B")}.tmp-0123456789abcdef`), "x");
    writeFileSync(join(exports, "notes.txt"), "x");
    await new ExportFolder(exports).reset();
    expect(readdirSync(exports)).toEqual(["notes.txt"]);
    expect(statSync(exports).mode & 0o777).toBe(0o700);

    const real = join(dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(dir, "link"));
    await expect(new ExportFolder(join(dir, "link")).reset()).rejects.toThrow();
  });

  it("with no folder, create rejects and open answers null", async () => {
    const f = new ExportFolder(null);
    await expect(f.create("A")).rejects.toThrow();
    expect(await f.open("A")).toBeNull();
  });
});
