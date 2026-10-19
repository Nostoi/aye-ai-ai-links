/** Test-only: zip validators, a reader for the end records and central directory, and sinks. */
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import type { ZipSink } from "./zip.js";

/** Runs a validator; a missing tool fails, never skips (R15). */
const run = (cmd: string, args: string[], input?: Uint8Array) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`${cmd} could not run: ${r.error.message}`);
  return r;
};

export function validateZip(path: string): void {
  const u = run("unzip", ["-t", path]);
  if (u.status !== 0 || !u.stdout.includes("No errors detected"))
    throw new Error(`unzip -t refused ${path}: ${u.stdout}${u.stderr}`);
  const p = run("python3", ["-I", "-m", "zipfile", "-t", path]);
  if (p.status !== 0 || p.stdout !== "Done testing\n")
    throw new Error(`python zipfile refused ${path}: ${p.stdout}${p.stderr}`);
}

/** Reads bytes at an absolute position (sparse files included). */
export const readAt = (path: string, pos: number, len: number): Buffer => {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, pos);
    if (n !== len) throw new Error(`short read at ${pos}: ${n} of ${len}`);
    return buf;
  } finally {
    closeSync(fd);
  }
};

const fileSize = (path: string): number => {
  const fd = openSync(path, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
};

export type End = {
  count16: number;
  cdSize32: number;
  cdStart32: number;
  zip64: null | { count: bigint; cdSize: bigint; cdStart: bigint; recordSize: bigint };
};

/** EOCD (no comment) at size-22; locator at size-42 when its signature 0x07064b50 is there. */
export function readEnd(path: string): End {
  const size = fileSize(path);
  const eocd = readAt(path, size - 22, 22);
  if (eocd.readUInt32LE(0) !== 0x06054b50) throw new Error("no end of central directory record");
  const end: End = {
    count16: eocd.readUInt16LE(10),
    cdSize32: eocd.readUInt32LE(12),
    cdStart32: eocd.readUInt32LE(16),
    zip64: null,
  };
  if (size < 42) return end;
  const locator = readAt(path, size - 42, 20);
  if (locator.readUInt32LE(0) !== 0x07064b50) return end;
  const rec = readAt(path, Number(locator.readBigUInt64LE(8)), 56);
  if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error("locator points at no ZIP64 end record");
  end.zip64 = {
    recordSize: rec.readBigUInt64LE(4),
    count: rec.readBigUInt64LE(32),
    cdSize: rec.readBigUInt64LE(40),
    cdStart: rec.readBigUInt64LE(48),
  };
  return end;
}

export type Central = { name: string; versionNeeded: number; offset32: number; extra: Buffer };

/** Walks the central-directory records in `cd`. */
const walkCentral = (cd: Buffer): (Central & { crc: number; size32: number })[] => {
  const out: (Central & { crc: number; size32: number })[] = [];
  let at = 0;
  while (at < cd.length) {
    if (cd.readUInt32LE(at) !== 0x02014b50) throw new Error(`no central record at ${at}`);
    const nameLen = cd.readUInt16LE(at + 28);
    const extraLen = cd.readUInt16LE(at + 30);
    const commentLen = cd.readUInt16LE(at + 32);
    out.push({
      name: cd.toString("latin1", at + 46, at + 46 + nameLen),
      versionNeeded: cd.readUInt16LE(at + 6),
      crc: cd.readUInt32LE(at + 16),
      size32: cd.readUInt32LE(at + 20),
      offset32: cd.readUInt32LE(at + 42),
      extra: Buffer.from(cd.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen)),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
};

/** Every central-directory record, from the start the end records give. */
export function readCentral(path: string): Central[] {
  const end = readEnd(path);
  const start = end.zip64 ? Number(end.zip64.cdStart) : end.cdStart32;
  const size = end.zip64 ? Number(end.zip64.cdSize) : end.cdSize32;
  return walkCentral(readAt(path, start, size)).map(({ name, versionNeeded, offset32, extra }) => ({
    name,
    versionNeeded,
    offset32,
    extra,
  }));
}

/** name → data for a small archive, by its central directory and local headers. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = b.length - 22;
  if (b.readUInt32LE(eocd) !== 0x06054b50) throw new Error("no end of central directory record");
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdStart = b.readUInt32LE(eocd + 16);
  const out = new Map<string, Uint8Array>();
  for (const c of walkCentral(b.subarray(cdStart, cdStart + cdSize))) {
    const at = c.offset32;
    if (b.readUInt32LE(at) !== 0x04034b50) throw new Error(`no local header for ${c.name}`);
    if (b.readUInt16LE(at + 8) !== 0) throw new Error(`${c.name} is not stored`);
    const data = at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28);
    out.set(c.name, new Uint8Array(b.subarray(data, data + c.size32)));
  }
  return out;
}

/** The shared 2 MiB of zeros the sparse sink leaves as a hole. */
export const ZERO = new Uint8Array(2 << 20);

/** Adds `z/00001…` zero entries so the next local header starts at exactly `target`. */
export async function fillTo(
  zip: { add(name: string, data: Uint8Array): Promise<void> },
  target: number,
  start = 0,
): Promise<void> {
  let offset = start;
  let n = 0;
  const name = () => `z/${String(++n).padStart(5, "0")}`;
  const header = 30 + 7;
  // Keep at least one header's worth for the last filler, which holds ZERO.length or fewer bytes.
  while (target - offset > header + ZERO.length) {
    const len = Math.min(ZERO.length, target - offset - 2 * header);
    await zip.add(name(), len === ZERO.length ? ZERO : ZERO.subarray(0, len));
    offset += header + len;
  }
  const last = target - offset - header;
  if (last < 0) throw new Error(`fillTo cannot reach ${target} from ${offset}`);
  await zip.add(name(), ZERO.subarray(0, last));
}

/** Python reads `name` back as `expected`, and lists as many entries as the central directory. */
export function pythonLastEntry(path: string, name: string, expected: Uint8Array): void {
  const script = [
    "import sys, zipfile",
    "z = zipfile.ZipFile(sys.argv[1])",
    "ok = z.read(sys.argv[2]) == sys.stdin.buffer.read()",
    "print(ok, len(z.infolist()))",
  ].join("\n");
  const r = run("python3", ["-I", "-c", script, path, name], expected);
  const want = `True ${readCentral(path).length}\n`;
  if (r.status !== 0 || r.stdout !== want)
    throw new Error(`python read of ${name} failed: ${r.stdout}${r.stderr}`);
}

/** `unzip -l` exits 0 and lists `name`. */
export function unzipList(path: string, name: string): void {
  const r = run("unzip", ["-l", path]);
  const listed = r.stdout.split("\n").some((line) => line.trimEnd().endsWith(` ${name}`));
  if (r.status !== 0 || !listed)
    throw new Error(`unzip -l failed for ${name}: ${r.stdout}${r.stderr}`);
}

export type ClosableSink = ZipSink & { close(): Promise<void> };

/** Writes each array, in order, to a fresh file at `path`. */
export const fileSink = (path: string): ClosableSink => sparseSink(path, null);

/** As fileSink, but an array over `zero`'s buffer only advances the position, leaving a hole. */
export function sparseSink(path: string, zero: Uint8Array | null): ClosableSink {
  const handle = open(path, "w");
  let pos = 0;
  return {
    async write(bytes) {
      const fh = await handle;
      if (zero === null || bytes.buffer !== zero.buffer) {
        let done = 0;
        while (done < bytes.length) {
          const { bytesWritten } = await fh.write(bytes, done, bytes.length - done, pos + done);
          done += bytesWritten;
        }
      }
      pos += bytes.length;
    },
    async close() {
      const fh = await handle;
      await fh.truncate(pos);
      await fh.close();
    },
  };
}
