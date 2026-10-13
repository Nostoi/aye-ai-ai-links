import { describe, expect, it } from "vitest";
import { decodersFor } from "./read-body.js";

describe("decodersFor", () => {
  it("allows one coding", () => {
    expect(decodersFor("gzip")).toEqual(["gzip"]);
  });

  it("refuses two or more codings, so a header cannot stack decoders", () => {
    expect(decodersFor("gzip, br")).toBeUndefined();
    expect(decodersFor("br,br")).toBeUndefined();
    expect(decodersFor(Array(4000).fill("br").join(","))).toBeUndefined();
  });

  it("does not count identity or empty entries toward the limit", () => {
    expect(decodersFor("identity, gzip, ,identity")).toEqual(["gzip"]);
    expect(decodersFor(undefined)).toEqual([]);
  });

  it("refuses an unknown coding", () => {
    expect(decodersFor("zstd")).toBeUndefined();
  });
});
