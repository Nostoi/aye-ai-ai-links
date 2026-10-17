import { describe, expect, it } from "vitest";
import {
  avif,
  gif,
  gifExtension,
  jpeg,
  jpegSegment,
  png,
  svg,
  webpExtended,
  webpLossless,
  webpLossy,
} from "./image-test-kit.js";
import { checkImage, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, readImageHeader } from "./image-type.js";

describe("readImageHeader", () => {
  it.each([
    ["PNG", png(640, 480), "image/png"],
    ["GIF", gif(640, 480), "image/gif"],
    ["JPEG", jpeg(640, 480), "image/jpeg"],
    ["lossy WebP", webpLossy(640, 480), "image/webp"],
    ["lossless WebP", webpLossless(640, 480), "image/webp"],
    ["extended WebP", webpExtended(640, 480), "image/webp"],
  ])("reads a %s's type and size from its magic bytes and header", (_, bytes, type) => {
    expect(readImageHeader(bytes)).toEqual({ type, width: 640, height: 480 });
  });

  it("reads sizes past 16 bits for PNG and past 14 bits for extended WebP", () => {
    expect(readImageHeader(png(100_000, 100_000))).toMatchObject({ width: 100_000 });
    expect(readImageHeader(webpExtended(100_000, 3))).toMatchObject({ width: 100_000, height: 3 });
  });

  // Each is cut one byte before the end of its size field.
  it.each([
    ["PNG", png(640, 480), 23],
    ["GIF", gif(640, 480), 27],
    ["JPEG", jpeg(640, 480), 28],
    ["lossy WebP", webpLossy(640, 480), 29],
    ["lossless WebP", webpLossless(640, 480), 24],
    ["extended WebP", webpExtended(640, 480), 29],
  ])("refuses a %s cut off before its size", (_, bytes, cut) => {
    expect(readImageHeader(bytes.subarray(0, cut + 1))).not.toBeNull();
    expect(readImageHeader(bytes.subarray(0, cut))).toBeNull();
  });

  it("reads a GIF's size as the larger of its screen and its first frame's extent", () => {
    const frame = { left: 0, top: 0, width: 20_000, height: 20_000 };
    expect(readImageHeader(gif(1, 1, { frame }))).toEqual({
      type: "image/gif",
      width: 20_000,
      height: 20_000,
    });
    const offset = { left: 5, top: 7, width: 10, height: 10 };
    expect(readImageHeader(gif(10, 10, { frame: offset }))).toMatchObject({
      width: 15,
      height: 17,
    });
    expect(readImageHeader(gif(640, 480, { frame: { ...offset, width: 1 } }))).toMatchObject({
      width: 640,
      height: 480,
    });
  });

  it("reads a GIF's frame past graphic control, application and comment extensions", () => {
    const extensions = [
      gifExtension(0xf9, Buffer.from([0, 10, 0, 0])),
      gifExtension(0xff, Buffer.from("NETSCAPE2.0")),
      gifExtension(0xfe, Buffer.from("made by a test")),
    ];
    expect(readImageHeader(gif(640, 480, { extensions }))).toEqual({
      type: "image/gif",
      width: 640,
      height: 480,
    });
  });

  it("refuses a GIF that ends, or reaches an unknown block, before any frame", () => {
    const screen = gif(640, 480).subarray(0, 19);
    expect(readImageHeader(Buffer.concat([screen, Buffer.from([0x3b])]))).toBeNull();
    expect(readImageHeader(Buffer.concat([screen, Buffer.from([0x99, 0, 0, 0])]))).toBeNull();
    const unended = Buffer.concat([screen, Buffer.from([0x21, 0xfe, 5, 1, 2])]);
    expect(readImageHeader(unended)).toBeNull();
  });

  it("reads a JPEG's frame past APP0, APP1, DQT and DHT segments", () => {
    const before = [
      jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
      jpegSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), Buffer.alloc(40)])),
      jpegSegment(0xdb, Buffer.alloc(65)),
      jpegSegment(0xc4, Buffer.alloc(30)),
    ];
    expect(readImageHeader(jpeg(640, 480, before))).toEqual({
      type: "image/jpeg",
      width: 640,
      height: 480,
    });
  });

  it.each([
    ["a restart marker", 0xd0],
    ["a stuffed zero", 0x00],
  ])("refuses a JPEG with %s before its frame, which would desync the walk", (_, marker) => {
    const payload = Buffer.alloc(65_530);
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01]).copy(payload, 65_515);
    const crafted = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, marker]),
      jpegSegment(0xef, payload),
      jpeg(8000, 8000).subarray(2 + 18),
    ]);
    expect(readImageHeader(crafted)).toBeNull();
  });

  it.each([
    ["RST7", 0xd7],
    ["TEM", 0x01],
    ["SOS", 0xda],
    ["JPG0", 0xf0],
  ])("refuses a JPEG with %s before its frame", (_, marker) => {
    const bytes = jpeg(640, 480);
    const withMarker = Buffer.concat([
      bytes.subarray(0, 2),
      Buffer.from([0xff, marker]),
      bytes.subarray(2),
    ]);
    expect(readImageHeader(withMarker)).toBeNull();
  });

  it("refuses a JPEG whose markers end before any frame header", () => {
    const noFrame = Buffer.concat([jpeg(1, 1).subarray(0, 20), Buffer.from([0xff, 0xd9])]);
    expect(readImageHeader(noFrame)).toBeNull();
  });

  it("refuses a JPEG with a segment length that points nowhere", () => {
    const bad = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00]);
    expect(readImageHeader(bad)).toBeNull();
  });

  it("refuses a zero width or height", () => {
    expect(readImageHeader(png(0, 480))).toBeNull();
    expect(readImageHeader(gif(640, 0))).toBeNull();
  });

  it.each([
    ["SVG", svg],
    ["AVIF", avif],
    ["HTML", Buffer.from("<!doctype html><title>x</title>")],
    ["an empty body", Buffer.alloc(0)],
  ])("refuses %s", (_, bytes) => {
    expect(readImageHeader(bytes)).toBeNull();
  });
});

describe("checkImage, the one image check for fetched and uploaded pictures", () => {
  it("accepts each kept type, naming the type its own header reads", () => {
    expect(checkImage(png(640, 480))).toEqual({ ok: true, type: "image/png" });
    expect(checkImage(jpeg(640, 480))).toEqual({ ok: true, type: "image/jpeg" });
    expect(checkImage(gif(640, 480))).toEqual({ ok: true, type: "image/gif" });
    expect(checkImage(webpLossy(640, 480))).toEqual({ ok: true, type: "image/webp" });
  });

  it("refuses SVG, AVIF and a header cut short as not_image", () => {
    for (const bytes of [svg, avif, png(640, 480).subarray(0, 20)]) {
      expect(checkImage(bytes)).toEqual({ ok: false, reason: "not_image" });
    }
  });

  it("takes exactly 2 MiB and refuses 2 MiB + 1 byte as too_large", () => {
    const head = png(10, 10);
    const sized = (n: number) => Buffer.concat([head, Buffer.alloc(n - head.length)]);
    expect(checkImage(sized(MAX_IMAGE_BYTES))).toEqual({ ok: true, type: "image/png" });
    expect(checkImage(sized(MAX_IMAGE_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
  });

  it("takes exactly MAX_IMAGE_PIXELS and refuses one column more as too_large", () => {
    expect(checkImage(png(MAX_IMAGE_PIXELS / 4000, 4000))).toEqual({ ok: true, type: "image/png" });
    expect(checkImage(png(MAX_IMAGE_PIXELS / 4000 + 1, 4000))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});
