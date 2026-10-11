const HEADER_CHARSET = /charset\s*=\s*["']?\s*([^\s"';]+)/i;
const META_CHARSET = /<meta\s[^>]*?charset\s*=\s*["']?\s*([^\s"'>;/]+)/i;
const META_SCAN_BYTES = 1024;

function bomLabel(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return undefined;
}

function decoderFor(label: string | undefined): TextDecoder | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label);
  } catch {
    return undefined;
  }
}

/**
 * Decodes a page to text. The charset comes from, in order: a byte-order mark, the Content-Type
 * header, then `<meta>` in the first kilobyte. A label the runtime does not know is skipped, and
 * UTF-8 is the fallback. Never throws; bad bytes become U+FFFD.
 */
export function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const head = Buffer.from(bytes.subarray(0, META_SCAN_BYTES)).toString("latin1");
  const decoder =
    decoderFor(bomLabel(bytes)) ??
    decoderFor(HEADER_CHARSET.exec(contentType)?.[1]) ??
    decoderFor(META_CHARSET.exec(head)?.[1]) ??
    new TextDecoder("utf-8");
  return decoder.decode(bytes);
}
