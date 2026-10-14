import type { ImageType } from "../core/fetch.js";

export type ImageHeader = { type: ImageType; width: number; height: number };

/** How far into a JPEG the frame header is looked for; metadata segments before it can be large. */
const JPEG_SCAN_BYTES = 256 * 1024;

const startsWith = (b: Uint8Array, magic: number[], at = 0) =>
  b.length >= at + magic.length && magic.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function png(b: Buffer): ImageHeader | null {
  if (b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { type: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b: Buffer): ImageHeader | null {
  if (b.length < 13) return null;
  const packed = b[10] as number;
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  while (at < b.length) {
    const block = b[at];
    if (block === 0x2c) {
      if (at + 9 > b.length) return null;
      return {
        type: "image/gif",
        width: Math.max(b.readUInt16LE(6), b.readUInt16LE(at + 1) + b.readUInt16LE(at + 5)),
        height: Math.max(b.readUInt16LE(8), b.readUInt16LE(at + 3) + b.readUInt16LE(at + 7)),
      };
    }
    if (block !== 0x21) return null;
    at += 2;
    for (;;) {
      if (at >= b.length) return null;
      const size = b[at] as number;
      at += 1 + size;
      if (size === 0) break;
    }
  }
  return null;
}

/** Walks the marker segments to the first frame header (SOF0-SOF15, except DHT, JPG and DAC). */
function jpeg(b: Buffer): ImageHeader | null {
  const end = Math.min(b.length, JPEG_SCAN_BYTES);
  let at = 2;
  while (at + 4 <= end) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] as number;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return null;
    const length = b.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (at + 9 > end) return null;
      return { type: "image/jpeg", width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
    }
    at += 2 + length;
  }
  return null;
}

function webp(b: Buffer): ImageHeader | null {
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 " && b.length >= 30 && startsWith(b, [0x9d, 0x01, 0x2a], 23)) {
    return {
      type: "image/webp",
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) {
    return { type: "image/webp", width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * The image's type, from its magic bytes, and its size, from its own header: PNG, JPEG, GIF or
 * WebP. Null for any other type (SVG and AVIF included), a header cut short, or a zero size.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: ImageHeader | null = null;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) header = png(b);
  else if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) header = gif(b);
  else if (startsWith(b, [0xff, 0xd8, 0xff])) header = jpeg(b);
  else if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) header = webp(b);
  if (!header || header.width === 0 || header.height === 0) return null;
  return header;
}
