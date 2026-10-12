import { describe, expect, it } from "vitest";
import { GET_DIGEST, GET_PROFILE, INSTRUCTIONS, SAVE_LINK, UPDATE_TAG } from "./guidance.js";

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
      'When you send kind, source also labels the kind: send kind with "stated" or "asked" only if the owner gave the kind; otherwise leave kind out, or send it with source "inferred".';
    for (const text of [INSTRUCTIONS, SAVE_LINK]) expect(text).toContain(rule);
  });

  it("says update_tag also confirms a kind the tag already has", () => {
    expect(UPDATE_TAG).toContain("confirms it");
    expect(UPDATE_TAG).not.toContain("changes nothing");
  });
});

describe("get_digest guidance", () => {
  it("names every reason, and the cautions that go with focus words and openings", () => {
    for (const kind of ["focus_words", "no_why", "not_opened_recently", "never_surfaced"]) {
      expect(GET_DIGEST).toContain(`- ${kind}:`);
    }
    expect(GET_DIGEST).toContain("not proof it is relevant");
    expect(GET_DIGEST).toContain('source is "inferred" as a guess');
    expect(GET_DIGEST).toContain('update_link as "asked"');
    expect(GET_DIGEST).toContain("never tell the owner they haven't opened it");
    expect(GET_DIGEST).toContain("snoozedUntil");
    expect(GET_DIGEST).toMatch(/marks the links it returns as shown.*Don't call it again/s);
  });
});
