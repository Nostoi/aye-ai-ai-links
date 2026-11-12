import { describe, expect, it } from "vitest";
import { MAX_ICO_ENTRIES, pngFromIco } from "./ico.js";
import { dib, ico, png } from "./image-test-kit.js";
import { checkImage, faviconBigEnough } from "./image-type.js";

const P32 = png(32, 32);

describe("pngFromIco (#272)", () => {
  it("★ keeps only the PNG entry's own bytes, a copy, which checkImage reads as a PNG", () => {
    // [Returning the whole file, or a view that keeps the file's buffer alive.]
    const file = ico([{ data: dib(16, 16) }, { data: P32 }]);
    const out = pngFromIco(file);
    expect(out).toEqual(new Uint8Array(P32));
    expect(out?.buffer.byteLength).toBe(P32.length);
    expect(out && checkImage(out)).toEqual({ ok: true, type: "image/png" });
  });

  it("★ needs the whole 6-byte header", () => {
    for (const n of [0, 1, 5])
      expect(pngFromIco(ico([{ data: P32 }]).subarray(0, n)), `${n}`).toBe(null);
  });

  it("★ needs the whole directory before reading any entry", () => {
    // [Reading entry 1, intact, before checking that 6 + 16 × count bytes are there.]
    const file = ico([{ data: P32 }], { count: 5 });
    expect(file.length).toBeLessThan(6 + 16 * 5);
    expect(pngFromIco(file)).toBe(null);
  });

  it("★ needs reserved 0 and type 1: an icon, never a cursor", () => {
    expect(pngFromIco(ico([{ data: P32 }], { type: 2 }))).toBe(null);
    expect(pngFromIco(ico([{ data: P32 }], { type: 0 }))).toBe(null);
    const reserved = ico([{ data: P32 }]);
    reserved[0] = 1;
    expect(pngFromIco(reserved)).toBe(null);
  });

  it("★ bounds the count: none, more than MAX_ICO_ENTRIES, or an extreme count is refused", () => {
    const many = (n: number) => ico(Array.from({ length: n }, () => ({ data: P32 })));
    expect(pngFromIco(many(MAX_ICO_ENTRIES))).not.toBe(null);
    expect(pngFromIco(many(MAX_ICO_ENTRIES + 1))).toBe(null);
    expect(pngFromIco(ico([], { count: 0 }))).toBe(null);
    expect(pngFromIco(ico([{ data: P32 }], { count: 0xffff }))).toBe(null);
  });

  it("★ refuses an entry whose offset or length runs past the file, never clipping it", () => {
    // [Relying on subarray, which clips: a PNG one byte short still has its header and passes checkImage.]
    expect(pngFromIco(ico([{ data: P32, length: P32.length + 1 }]))).toBe(null);
    expect(pngFromIco(ico([{ data: P32, offset: 22 + 1 }]))).toBe(null);
    expect(pngFromIco(ico([{ data: P32, offset: 0xffffffff }]))).toBe(null);
    expect(pngFromIco(ico([{ data: P32, length: 0xffffffff }]))).toBe(null);
    expect(pngFromIco(ico([{ data: P32, length: 0 }]))).toBe(null);
  });

  it("★ refuses an entry that points back into the header or directory", () => {
    // [Accepting any offset: here a PNG overlaps directory entries 2 and 3, which name nothing valid.]
    const file = Buffer.alloc(6 + 16 + P32.length);
    file.writeUInt16LE(1, 2);
    file.writeUInt16LE(3, 4);
    file.writeUInt32LE(P32.length, 6 + 8);
    file.writeUInt32LE(22, 6 + 12);
    P32.copy(file, 22);
    expect(file.length).toBeGreaterThanOrEqual(6 + 16 * 3);
    expect(pngFromIco(file)).toBe(null);
  });

  it("★ refuses an entry too short for a PNG signature and IHDR (33 bytes)", () => {
    // [Accepting 32 bytes: the header-only check reads width and height from the first 24.]
    expect(pngFromIco(ico([{ data: P32.subarray(0, 32), length: 32 }]))).toBe(null);
    expect(pngFromIco(ico([{ data: P32.subarray(0, 33), length: 33 }]))).toEqual(
      new Uint8Array(P32.subarray(0, 33)),
    );
  });

  it("★ checks the PNG signature at the entry's own offset, never by scanning", () => {
    // [Searching the file for a PNG: here one sits after a BMP entry's data, named by no entry.]
    const file = Buffer.concat([ico([{ data: dib(32, 32) }]), P32]);
    expect(pngFromIco(file)).toBe(null);
  });

  it("★ chooses the largest PNG by its own header, not the directory's claim", () => {
    const file = ico([
      { data: png(16, 16), width: 0, height: 0 },
      { data: png(64, 64), width: 1, height: 1 },
      { data: png(32, 32) },
    ]);
    expect(pngFromIco(file)).toEqual(new Uint8Array(png(64, 64)));
  });

  it("★ falls back to the next PNG when checkImage refuses the largest", () => {
    // [Stopping at the largest, whose header declares too many pixels.]
    const file = ico([{ data: png(100_000, 100_000) }, { data: png(48, 48) }]);
    expect(pngFromIco(file)).toEqual(new Uint8Array(png(48, 48)));
  });

  it("★ finds nothing in a BMP-only icon", () => {
    expect(pngFromIco(ico([{ data: dib(32, 32) }, { data: dib(64, 64) }]))).toBe(null);
  });

  it("★ never trusts the directory's size: the floor and pixel cap read the PNG's header", () => {
    // [Judging the entry by the directory's 256 × 256 claim.]
    const small = pngFromIco(ico([{ data: png(8, 8), width: 0, height: 0 }]));
    expect(small).toEqual(new Uint8Array(png(8, 8)));
    expect(small && faviconBigEnough(small)).toBe(false);
    expect(pngFromIco(ico([{ data: png(10_000, 10_000), width: 16, height: 16 }]))).toBe(null);
  });

  it("finds nothing in a file that is not an icon", () => {
    expect(pngFromIco(P32)).toBe(null);
    expect(pngFromIco(new Uint8Array())).toBe(null);
  });
});
