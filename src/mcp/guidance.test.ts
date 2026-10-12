import { describe, expect, it } from "vitest";
import { GET_PROFILE, INSTRUCTIONS, SAVE_LINK, UPDATE_TAG } from "./guidance.js";

describe("guidance on a tag's kindSource", () => {
  it("tells agents in the shared instructions, save_link and get_profile to present an inferred project as a guess", () => {
    for (const text of [INSTRUCTIONS, SAVE_LINK, GET_PROFILE]) {
      expect(text).toContain("kindSource");
      expect(text).toContain('whose kindSource is "inferred" as a guess');
      expect(text).toContain("update_tag only when the owner confirms");
      expect(text).not.toContain('not "stated"');
    }
  });

  it("tells agents in the shared instructions and save_link that a tag's source also labels its kind", () => {
    const rule =
      'When you send kind, source also labels the kind: send kind with "stated" only if the owner said what kind it is; otherwise leave kind out, or send it with source "inferred".';
    for (const text of [INSTRUCTIONS, SAVE_LINK]) expect(text).toContain(rule);
  });

  it("says update_tag also confirms a kind the tag already has", () => {
    expect(UPDATE_TAG).toContain("confirms it");
    expect(UPDATE_TAG).not.toContain("changes nothing");
  });
});
