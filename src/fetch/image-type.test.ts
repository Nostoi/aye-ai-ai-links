import { describe, expect, it } from "vitest";
import {
  avif,
  gif,
  jpeg,
  png,
  svg,
  webpExtended,
  webpLossless,
  webpLossy,
} from "./image-fixtures.js";
import { readImageHeader } from "./image-type.js";

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
    ["GIF", gif(640, 480), 9],
    ["JPEG", jpeg(640, 480), 28],
    ["lossy WebP", webpLossy(640, 480), 29],
    ["lossless WebP", webpLossless(640, 480), 24],
    ["extended WebP", webpExtended(640, 480), 29],
  ])("refuses a %s cut off before its size", (_, bytes, cut) => {
    expect(readImageHeader(bytes.subarray(0, cut + 1))).not.toBeNull();
    expect(readImageHeader(bytes.subarray(0, cut))).toBeNull();
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
