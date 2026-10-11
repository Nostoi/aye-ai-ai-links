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

  it("takes the kind from the strongest source on duplicate keys, the first on a tie", () => {
    const statedTopic = { name: "Solar", source: "stated" as const, kind: "topic" as const };
    const inferredProject = {
      name: "SOLAR",
      source: "inferred" as const,
      kind: "project" as const,
    };
    const statedProject = { name: "solar", source: "stated" as const, kind: "project" as const };
    const tag = (name: string, kind: string) => [{ key: "solar", name, source: "stated", kind }];
    expect(normalizeTags([statedTopic, inferredProject])).toEqual(tag("Solar", "topic"));
    expect(normalizeTags([inferredProject, statedTopic])).toEqual(tag("SOLAR", "topic"));
    expect(normalizeTags([inferredProject, statedProject])).toEqual(tag("SOLAR", "project"));
    expect(normalizeTags([statedTopic, statedProject])).toEqual(tag("Solar", "topic"));
    expect(normalizeTags([statedProject, statedTopic])).toEqual(tag("solar", "project"));
  });

  it("rejects a blank name as invalid_input", () => {
    expect(() => normalizeTags([{ name: "  \t ", source: "stated" }])).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});
