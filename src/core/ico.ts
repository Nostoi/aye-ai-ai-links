import { checkImage, readImageHeader } from "./image-type.js";

/** The most directory entries an ICO may name (#272). A real favicon has a handful. */
export const MAX_ICO_ENTRIES = 32;

const HEADER = 6;
const ENTRY = 16;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The shortest PNG entry: its signature and its whole IHDR chunk (length, type, 13 bytes, CRC). */
const MIN_PNG_ENTRY = 8 + 4 + 4 + 13 + 4;

/** Every entry's bytes that start with the PNG signature at its own offset, copied out; null when `b` is not a well-formed icon file. */
function pngEntries(b: Buffer): Uint8Array[] | null {
  if (b.length < HEADER) return null;
  const count = b.readUInt16LE(4);
  if (b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null;
  const directoryEnd = HEADER + ENTRY * count;
  if (count === 0 || count > MAX_ICO_ENTRIES || b.length < directoryEnd) return null;
  const found: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const at = HEADER + ENTRY * i;
    const length = b.readUInt32LE(at + 8);
    const offset = b.readUInt32LE(at + 12);
    // Plain integers: two u32s sum exactly, so nothing past the file is ever read or clipped.
    if (length < MIN_PNG_ENTRY || offset < directoryEnd || offset + length > b.length) continue;
    if (!PNG_SIGNATURE.every((v, k) => b[offset + k] === v)) continue;
    found.push(new Uint8Array(b.subarray(offset, offset + length)));
  }
  return found;
}

/**
 * The favicon an ICO file holds (#272, favicons only): its largest PNG entry, by the PNG's own
 * header, that `checkImage` keeps; null for a file that is not an icon (a cursor included), or
 * holds no such PNG. Only the entry's bytes come back, as a copy. BMP entries are never decoded.
 */
export function pngFromIco(bytes: Uint8Array): Uint8Array | null {
  const entries = pngEntries(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  let best: { bytes: Uint8Array; side: number; area: number } | null = null;
  for (const entry of entries ?? []) {
    const header = readImageHeader(entry);
    if (!header || !checkImage(entry).ok) continue;
    const side = Math.min(header.width, header.height);
    const area = header.width * header.height;
    if (!best || side > best.side || (side === best.side && area > best.area)) {
      best = { bytes: entry, side, area };
    }
  }
  return best?.bytes ?? null;
}
