/** A stored (uncompressed) zip writer, ZIP64 decided per field (APPNOTE 6.3). */
import { crc32 } from "node:zlib";

export type ZipSink = { write(bytes: Uint8Array): Promise<void> };

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

type Rec = { name: string; crc: number; size: number; offset: number };
type Stamp = { time: number; date: number };

const dosStamp = (d: Date): Stamp => ({
  time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
});

const NO_STAMP: Stamp = { time: 0, date: 0 };

/** Exported for the size test only. Per-field ZIP64 (R16): usize, csize, offset, in APPNOTE order. */
export function centralRecord(r: Rec & { versionNeeded?: number }, stamp = NO_STAMP): Buffer {
  const big = [
    r.size >= MAX32 && r.size,
    r.size >= MAX32 && r.size,
    r.offset >= MAX32 && r.offset,
  ].filter((v): v is number => v !== false);
  const extra = Buffer.alloc(big.length ? 4 + 8 * big.length : 0);
  if (big.length) {
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(8 * big.length, 2);
    big.forEach((v, i) => {
      extra.writeBigUInt64LE(BigInt(v), 4 + 8 * i);
    });
  }
  const v = big.length ? 45 : 20;
  const name = Buffer.from(r.name, "ascii");
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(v, 4); // made by
  h.writeUInt16LE(v, 6); // needed
  h.writeUInt16LE(0, 8); // flags
  h.writeUInt16LE(0, 10); // stored
  h.writeUInt16LE(stamp.time, 12);
  h.writeUInt16LE(stamp.date, 14);
  h.writeUInt32LE(r.crc, 16);
  h.writeUInt32LE(Math.min(r.size, MAX32), 20);
  h.writeUInt32LE(Math.min(r.size, MAX32), 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(extra.length, 30);
  // comment length, disk, internal and external attributes stay 0
  h.writeUInt32LE(Math.min(r.offset, MAX32), 42);
  return Buffer.concat([h, name, extra]);
}

function localHeader(name: Buffer, crc: number, size: number, stamp: Stamp): Buffer {
  const h = Buffer.alloc(30 + name.length);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0, 6); // flags: no data descriptor
  h.writeUInt16LE(0, 8); // stored
  h.writeUInt16LE(stamp.time, 10);
  h.writeUInt16LE(stamp.date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(size, 18);
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  name.copy(h, 30);
  return h;
}

function endRecords(count: number, cdSize: number, cdStart: number): Buffer {
  const parts: Buffer[] = [];
  if (count >= MAX16 || cdSize >= MAX32 || cdStart >= MAX32) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12); // made by
    rec.writeUInt16LE(45, 14); // needed
    // this disk and the central directory's disk stay 0
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdStart), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdStart + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(rec, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Math.min(count, MAX16), 8);
  eocd.writeUInt16LE(Math.min(count, MAX16), 10);
  eocd.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  eocd.writeUInt32LE(Math.min(cdStart, MAX32), 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}

/**
 * Writes stored entries to `sink`, each header then the caller's array unchanged, in order.
 * Each call must be awaited before the next; a call while one is pending, any call after
 * `finish`, and any call after a sink write rejected all throw without writing.
 */
export function createZipWriter(
  sink: ZipSink,
  modified: Date,
): { add(name: string, data: Uint8Array): Promise<void>; finish(): Promise<number> } {
  const stamp = dosStamp(modified);
  const records: Rec[] = [];
  let offset = 0;
  let state: "open" | "pending" | "finished" | "failed" = "open";

  /** Runs `step` alone; a rejected write leaves the archive unusable. */
  async function exclusive<T>(step: () => Promise<T>, next: "open" | "finished"): Promise<T> {
    if (state !== "open") throw new Error(`zip writer is ${state}`);
    state = "pending";
    try {
      const result = await step();
      state = next;
      return result;
    } catch (err) {
      state = "failed";
      throw err;
    }
  }

  return {
    async add(name, data) {
      if (state !== "open") throw new Error(`zip writer is ${state}`);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range is the rule
      if (!/^[\x00-\x7f]+$/.test(name)) throw new Error(`zip entry name must be ASCII: ${name}`);
      if (data.length >= MAX32) throw new Error(`zip entry ${name} is too large`);
      return exclusive(async () => {
        const crc = crc32(data);
        const nameBytes = Buffer.from(name, "ascii");
        await sink.write(localHeader(nameBytes, crc, data.length, stamp));
        await sink.write(data);
        records.push({ name, crc, size: data.length, offset });
        offset += 30 + nameBytes.length + data.length;
      }, "open");
    },
    finish() {
      return exclusive(async () => {
        const central = Buffer.concat(records.map((r) => centralRecord(r, stamp)));
        await sink.write(central);
        const end = endRecords(records.length, central.length, offset);
        await sink.write(end);
        return offset + central.length + end.length;
      }, "finished");
    },
  };
}
