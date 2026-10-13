import { describe, expect, it } from "vitest";
import { decodersFor } from "./read-body.js";

describe("decodersFor", () => {
  it("returns the codings in the order to apply them", () => {
    expect(decodersFor("gzip, br")).toEqual(["br", "gzip"]);
  });

  it("allows two codings and refuses three, so a header cannot stack a pile of decoders", () => {
    expect(decodersFor("br,br")).toEqual(["br", "br"]);
    expect(decodersFor("br,br,br")).toBeUndefined();
    expect(decodersFor(Array(4000).fill("br").join(","))).toBeUndefined();
  });

  it("does not count identity or empty entries toward the limit", () => {
    expect(decodersFor("identity, gzip, , br, identity")).toEqual(["br", "gzip"]);
  });

  it("refuses an unknown coding", () => {
    expect(decodersFor("zstd")).toBeUndefined();
  });
});
