import { describe, expect, it } from "vitest";
import type { Link } from "../core/types.js";
import { initialsOf, initialsText } from "./initials.js";

const link = (title: string | null, url: string) => ({ title, url }) as Link;

describe("initialsOf", () => {
  it("takes the first letter or digit of the first two words that have one, uppercased", () => {
    expect(initialsOf("a quokka field guide")).toBe("AQ");
    expect(initialsOf("— 2 fast")).toBe("2F");
    expect(initialsOf("")).toBe("");
  });
});

describe("initialsText", () => {
  it("uses the title's initials, else the host's without www", () => {
    expect(initialsText(link("Quokka habitat", "https://a.example/x"))).toBe("QH");
    expect(initialsText(link(null, "https://www.stoat.example/x"))).toBe("SE");
    expect(initialsText(link("  ", "https://www.stoat.example/x"))).toBe("SE");
  });
});
