import { describe, expect, it } from "vitest";
import { normalizeTags } from "./tags.js";

describe("normalizeTags", () => {
  it("trims, collapses whitespace and lower-cases the key", () => {
    expect(normalizeTags([{ name: "  Home   Batteries ", source: "stated" }])).toEqual([
      { key: "home batteries", name: "Home Batteries", source: "stated" },
    ]);
  });

  it("collapses duplicate keys: first name, strongest source, any order", () => {
    const a = { name: "Solar", source: "inferred" as const };
    const b = { name: "solar", source: "stated" as const };
    const c = { name: "SOLAR", source: "asked" as const };
    expect(normalizeTags([a, b, c])).toEqual([{ key: "solar", name: "Solar", source: "stated" }]);
    expect(normalizeTags([c, b, a])).toEqual([{ key: "solar", name: "SOLAR", source: "stated" }]);
    expect(normalizeTags([a, c])).toEqual([{ key: "solar", name: "Solar", source: "asked" }]);
  });

  it("rejects a blank name as invalid_input", () => {
    expect(() => normalizeTags([{ name: "  \t ", source: "stated" }])).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});
