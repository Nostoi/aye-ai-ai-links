import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { centralRecord, createZipWriter } from "./zip.js";
import {
  fileSink,
  fillTo,
  pythonLastEntry,
  readCentral,
  readEnd,
  readZip,
  sparseSink,
  unzipList,
  validateZip,
  ZERO,
} from "./zip-test-kit.js";

const dir = mkdtempSync(join(tmpdir(), "aye-zip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const T = new Date("2026-10-19T08:00:00Z");
const MAX32 = 0xffffffff;

async function build(path: string, entries: [string, Uint8Array][], sink = fileSink(path)) {
  const zip = createZipWriter(sink, T);
  for (const [n, d] of entries) await zip.add(n, d);
  const total = await zip.finish();
  await sink.close();
  return total;
}

it("a small zip passes both validators and reads back byte for byte", async () => {
  const entries: [string, Uint8Array][] = [
    ["pictures/1-page.jpg", randomBytes(5000)],
    ["links.json", Buffer.from("{}")],
  ];
  const p = join(dir, "small.zip");
  const total = await build(p, entries);
  expect(statSync(p).size).toBe(total);
  validateZip(p);
  expect([...readZip(readFileSync(p))]).toEqual(entries.map(([n, d]) => [n, new Uint8Array(d)]));
  expect(readEnd(p).zip64).toBeNull();
});

it("the validators each examine the file: a flipped local CRC and a flipped central CRC are both refused", async () => {
  const p = join(dir, "flip.zip");
  await build(p, [["a.txt", Buffer.from("hello")]]);
  const good = readFileSync(p);
  const local = Buffer.from(good);
  local.writeUInt8(local.readUInt8(14) ^ 0xff, 14);
  writeFileSync(join(dir, "l.zip"), local);
  const central = Buffer.from(good);
  const crcAt = central.indexOf(Buffer.from("PK\x01\x02")) + 16;
  central.writeUInt8(central.readUInt8(crcAt) ^ 0xff, crcAt);
  writeFileSync(join(dir, "c.zip"), central);
  expect(() => validateZip(join(dir, "l.zip"))).toThrow(/unzip/);
  expect(() => validateZip(join(dir, "c.zip"))).toThrow(/python/);
});

it("stamps the modified time in DOS form, in UTC", async () => {
  const p = join(dir, "time.zip");
  await build(p, [["a.txt", Buffer.from("x")]]);
  const b = readFileSync(p);
  const time = (8 << 11) | (0 << 5) | 0;
  const date = ((2026 - 1980) << 9) | (10 << 5) | 19;
  expect([b.readUInt16LE(10), b.readUInt16LE(12)]).toEqual([time, date]);
  const at = b.indexOf(Buffer.from("PK\x01\x02"));
  expect([b.readUInt16LE(at + 12), b.readUInt16LE(at + 14)]).toEqual([time, date]);
});

it.each(["", "café.txt"])("refuses the name %j", async (name) => {
  const sink = fileSink(join(dir, "refused.zip"));
  const zip = createZipWriter(sink, T);
  await expect(zip.add(name, Buffer.from("x"))).rejects.toThrow(/name/);
  await sink.close();
});

it.each([
  [65_534, false],
  [65_535, true],
])(
  "%i entries: ZIP64 end records %s, count field at its max only when reached",
  async (count, zip64) => {
    const p = join(dir, `n${count}.zip`);
    await build(
      p,
      Array.from({ length: count }, (_, i) => [
        `f/${String(i).padStart(5, "0")}`,
        Buffer.from([i & 0xff]),
      ]),
    );
    validateZip(p);
    const end = readEnd(p);
    expect(end.count16).toBe(zip64 ? 0xffff : count);
    expect(end.zip64?.count ?? null).toBe(zip64 ? BigInt(count) : null);
    expect(end.cdSize32).not.toBe(MAX32);
    expect(end.cdStart32).not.toBe(MAX32);
    if (zip64) expect(end.zip64?.recordSize).toBe(44n);
  },
  120_000,
);

it("central-directory start alone crosses: only that end field is 0xFFFFFFFF, no entry has an extra field", async () => {
  const p = join(dir, "cdstart.zip");
  const sink = sparseSink(p, ZERO);
  const zip = createZipWriter(sink, T);
  const L = MAX32 - 1024;
  await fillTo(zip, L);
  const tail = Buffer.alloc(1 << 20, 0x41);
  await zip.add("bookmarks.html", tail); // header at L < max
  await zip.finish();
  await sink.close();
  const end = readEnd(p);
  expect(end.cdStart32).toBe(MAX32);
  expect(end.count16).not.toBe(0xffff);
  expect(end.cdSize32).not.toBe(MAX32);
  expect(end.zip64?.cdStart).toBe(BigInt(L + 30 + 14 + tail.length));
  const central = readCentral(p);
  expect(central.at(-1)?.offset32).toBe(L);
  expect(central.every((c) => c.extra.length === 0 && c.versionNeeded === 20)).toBe(true);
  pythonLastEntry(p, "bookmarks.html", tail);
  unzipList(p, "bookmarks.html");
}, 300_000);

it("an entry at exactly offset 0xFFFFFFFF gets the ZIP64 extra field, and only that entry", async () => {
  const p = join(dir, "offset.zip");
  const sink = sparseSink(p, ZERO);
  const zip = createZipWriter(sink, T);
  await fillTo(zip, MAX32);
  await zip.add("y", Buffer.from("past the limit"));
  await zip.finish();
  await sink.close();
  const central = readCentral(p);
  const y = central.at(-1);
  if (!y) throw new Error("no central records");
  expect(central.filter((c) => c.extra.length > 0).map((c) => c.name)).toEqual(["y"]);
  expect(y.offset32).toBe(MAX32);
  expect(y.versionNeeded).toBe(45);
  expect(y.extra.readUInt16LE(0)).toBe(1);
  expect(y.extra.readUInt16LE(2)).toBe(8);
  expect(y.extra.readBigUInt64LE(4)).toBe(BigInt(MAX32));
  expect(readEnd(p).zip64).not.toBeNull(); // cd start is past the limit too
  pythonLastEntry(p, "y", Buffer.from("past the limit"));
  unzipList(p, "y");
}, 300_000);

it("sizes at 0xFFFFFFFF go in the extra field before the offset (decided per field)", () => {
  const rec = centralRecord({ name: "big", crc: 0, size: MAX32, offset: 5, versionNeeded: 0 });
  // usize then csize; the offset (5) stays in its own field
  const extra = rec.subarray(46 + 3);
  expect(extra.readUInt16LE(2)).toBe(16);
  expect(extra.readBigUInt64LE(4)).toBe(BigInt(MAX32));
  expect(extra.readBigUInt64LE(12)).toBe(BigInt(MAX32));
  expect(rec.readUInt32LE(42)).toBe(5);
  expect(rec.readUInt16LE(6)).toBe(45);
});
