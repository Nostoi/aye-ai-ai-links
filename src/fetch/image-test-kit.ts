/** Minimal image headers for tests: enough bytes for the type and size to be read, nothing more. */

const u16le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
const u16be = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u24le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** A PNG signature and IHDR declaring `width` × `height`, then `tail`. */
export const png = (width: number, height: number, tail: Buffer = Buffer.alloc(16)) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32be(13),
    Buffer.from("IHDR"),
    u32be(width),
    u32be(height),
    Buffer.from([8, 6, 0, 0, 0]),
    Buffer.alloc(4),
    tail,
  ]);

export const gif = (width: number, height: number) =>
  Buffer.concat([Buffer.from("GIF89a"), u16le(width), u16le(height), Buffer.alloc(8)]);

/** A JPEG with an APP0 segment before its baseline SOF0 frame header. */
export const jpeg = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]),
    u16be(16),
    Buffer.from("JFIF\0"),
    Buffer.alloc(9),
    Buffer.from([0xff, 0xc0]),
    u16be(17),
    Buffer.from([8]),
    u16be(height),
    u16be(width),
    Buffer.alloc(10),
  ]);

const riff = (chunk: string, body: Buffer) =>
  Buffer.concat([
    Buffer.from("RIFF"),
    u32le(4 + 8 + body.length),
    Buffer.from("WEBP"),
    Buffer.from(chunk),
    u32le(body.length),
    body,
  ]);

/** Lossy WebP: a VP8 key frame header. */
export const webpLossy = (width: number, height: number) =>
  riff(
    "VP8 ",
    Buffer.concat([Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a]), u16le(width), u16le(height)]),
  );

/** Lossless WebP: a VP8L header packing width-1 and height-1 in 14 bits each. */
export const webpLossless = (width: number, height: number) => {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return riff("VP8L", Buffer.concat([Buffer.from([0x2f]), u32le(bits >>> 0), Buffer.alloc(4)]));
};

/** Extended WebP: a VP8X header with a 24-bit canvas size. */
export const webpExtended = (width: number, height: number) =>
  riff("VP8X", Buffer.concat([Buffer.alloc(4), u24le(width - 1), u24le(height - 1)]));

export const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
);

/** The start of an AVIF file: an ISO-BMFF `ftyp` box naming the avif brand. */
export const avif = Buffer.concat([u32be(24), Buffer.from("ftypavif"), Buffer.alloc(12)]);
