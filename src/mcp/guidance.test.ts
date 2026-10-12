import { describe, expect, it } from "vitest";
import { GET_PROFILE, INSTRUCTIONS, SAVE_LINK, UPDATE_TAG } from "./guidance.js";

describe("guidance on a tag's kindSource", () => {
  it("tells agents in the shared instructions, save_link and get_profile to present an unstated project as a guess", () => {
    for (const text of [INSTRUCTIONS, SAVE_LINK, GET_PROFILE]) {
      expect(text).toContain("kindSource");
      expect(text).toContain("as a guess");
      expect(text).toContain("update_tag only when the owner confirms");
    }
  });

  it("says update_tag also confirms a kind the tag already has", () => {
    expect(UPDATE_TAG).toContain("confirms it");
    expect(UPDATE_TAG).not.toContain("changes nothing");
  });
});
