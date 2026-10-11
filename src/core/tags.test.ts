import { describe, expect, it } from "vitest";
import { normalizeTags } from "./tags.js";

describe("normalizeTags", () => {
  it("trims, collapses whitespace and lower-cases the key", () => {
    expect(normalizeTags([{ name: "  Home   Batteries ", source: "stated" }])).toEqual([
      { key: "home batteries", name: "Home Batteries", source: "stated", kind: "topic" },
    ]);
  });

  it("collapses duplicate keys: first name, strongest source, any order", () => {
    const a = { name: "Solar", source: "inferred" as const };
    const b = { name: "solar", source: "stated" as const };
    const c = { name: "SOLAR", source: "asked" as const };
    expect(normalizeTags([a, b, c])).toEqual([
      { key: "solar", name: "Solar", source: "stated", kind: "topic" },
    ]);
    expect(normalizeTags([c, b, a])).toEqual([
      { key: "solar", name: "SOLAR", source: "stated", kind: "topic" },
    ]);
    expect(normalizeTags([a, c])).toEqual([
      { key: "solar", name: "Solar", source: "asked", kind: "topic" },
    ]);
  });

  it("lets project win over topic on duplicate keys, in any order, keeping the first name", () => {
    const topic = { name: "Solar", source: "stated" as const, kind: "topic" as const };
    const project = { name: "SOLAR", source: "inferred" as const, kind: "project" as const };
    const wins = (name: string) => [{ key: "solar", name, source: "stated", kind: "project" }];
    expect(normalizeTags([topic, project])).toEqual(wins("Solar"));
    expect(normalizeTags([project, topic])).toEqual(wins("SOLAR"));
    expect(normalizeTags([project, { name: "solar", source: "stated" }])).toEqual(wins("SOLAR"));
  });

  it("rejects a blank name as invalid_input", () => {
    expect(() => normalizeTags([{ name: "  \t ", source: "stated" }])).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});
