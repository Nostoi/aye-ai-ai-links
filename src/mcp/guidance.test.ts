import { describe, expect, it } from "vitest";
import * as guidance from "./guidance.js";
import {
  GET_DIGEST,
  GET_PROFILE,
  INSTRUCTIONS,
  SAVE_LINK,
  UPDATE_LINK,
  UPDATE_TAG,
} from "./guidance.js";

describe("list_links guidance", () => {
  const LIST_LINKS = (guidance as Record<string, string>).LIST_LINKS ?? "";

  it("points to list_links from the shared instructions and search_links, for listing and counting", () => {
    expect(INSTRUCTIONS).toMatch(/list or count.*list_links/);
    expect(guidance.SEARCH_LINKS).toMatch(/list_links/);
  });

  it("says what each order lists, what the total counts, and how cursors behave", () => {
    for (const order of ['"newest"', '"oldest"', '"opened"']) expect(LIST_LINKS).toContain(order);
    // #124: openings are recorded from every web page, not only home's cards.
    expect(LIST_LINKS).toMatch(/opened: true.*from the web page.*bookmark/s);
    expect(LIST_LINKS).not.toMatch(/home page/);
    expect(LIST_LINKS).toMatch(/total counts/);
    expect(LIST_LINKS).toMatch(/nextCursor is null on the last page/);
    expect(LIST_LINKS).toMatch(/opened while you page.*missed/s);
    expect(LIST_LINKS).toMatch(/archived links are included/);
  });
});

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

describe("summary guidance", () => {
  it("tells agents on save_link and update_link that the server may replace their summary and how to send the owner's", () => {
    for (const text of [SAVE_LINK, UPDATE_LINK]) {
      expect(text).toContain("The server may replace a summary you wrote yourself");
      expect(text).toContain('{text, source} with "stated" or "asked"');
    }
  });

  it("tells update_link that plain text never replaces the server's or the owner's summary", () => {
    expect(UPDATE_LINK).toContain(
      'Plain text never replaces the server\'s or the owner\'s summary: to change one at the owner\'s request, send {text, source: "stated"} (or "asked").',
    );
  });
});

describe("get_digest guidance", () => {
  it("names every reason, and the cautions that go with focus words and openings", () => {
    for (const kind of [
      "focus_words",
      "came_back",
      "no_why",
      "not_opened_recently",
      "never_surfaced",
      "still_using_check",
    ]) {
      expect(GET_DIGEST).toContain(`- ${kind}:`);
    }
    const cameBack = GET_DIGEST.split("\n").find((l) => l.startsWith("- came_back:")) ?? "";
    expect(cameBack).toContain("put this link away");
    expect(cameBack).toContain("putAwayAt");
    expect(cameBack).toContain('source is "inferred" as a guess');
    expect(cameBack).toContain('state "active"');
    expect(GET_DIGEST).toContain("not proof it is relevant");
    expect(GET_DIGEST).toContain('source is "inferred" as a guess');
    expect(GET_DIGEST).toContain('update_link as "asked"');
    expect(GET_DIGEST).toContain("never tell the owner they haven't opened it");
    expect(GET_DIGEST).toContain("snoozedUntil");
    expect(GET_DIGEST).toMatch(/marks the links it returns as shown.*Don't call it again/s);
  });

  it("says the web page records openings too, and does not claim agents are the only source", () => {
    expect(GET_DIGEST).not.toContain("recorded only when an agent sends opened: true");
    // #124: openings are recorded from every web page, not only home's cards.
    expect(GET_DIGEST).toMatch(/opened: true.*from the web page.*bookmark/s);
    expect(GET_DIGEST).not.toMatch(/home page/);
  });
});

describe("the owner's word for archiving is stale", () => {
  it('get_digest offers to mark a link stale, still sending state "archived"', () => {
    expect(GET_DIGEST).toContain('mark it stale (state "archived")');
    expect(GET_DIGEST).toContain("offer to mark it stale or send handy");
    expect(GET_DIGEST).not.toMatch(/archive it/);
  });
});

describe("gone guidance", () => {
  it("get_link, search_links and list_links end with the gone note; the shared instructions do not carry it", () => {
    const GONE_NOTE = (guidance as Record<string, string>).GONE_NOTE ?? "";
    expect(GONE_NOTE).toMatch(
      /seems gone.*never that it is certainly dead.*offer to mark it stale \(update_link state "archived"\)/s,
    );
    expect(GONE_NOTE).not.toMatch(/offer to archive/);
    for (const d of [guidance.GET_LINK, guidance.SEARCH_LINKS, guidance.LIST_LINKS]) {
      expect(d.endsWith(`\n${GONE_NOTE}`)).toBe(true);
    }
    expect(guidance.INSTRUCTIONS).not.toContain(GONE_NOTE);
  });
});

describe("get_link guidance", () => {
  it("says what savedCopy means and that the copy is not available to the agent", () => {
    expect(guidance.GET_LINK).toContain(
      "savedCopy is {madeAt} when the server keeps a saved copy of the page, which the owner can read from Saved copy on the link's card on the web page, and null when it keeps none. The copy itself is not available to you.",
    );
    expect(guidance.GET_LINK.endsWith(`\n${guidance.GONE_NOTE}`)).toBe(true);
  });
});

describe("Keep handy guidance", () => {
  it("tells save_link when to keep, when to ask once, and that a guess only suggests", () => {
    expect(SAVE_LINK).toMatch(/says they use a link regularly.*"keep", source: "stated"/s);
    expect(SAVE_LINK).toContain("a login page, form or dashboard");
    expect(SAVE_LINK).toContain(
      '"Is this something you\'ll use regularly?" at most once, only after a save returns created: true: send "keep" or "not_handy" with "asked" through update_link.',
    );
    // The guess is tied to tool-like pages, so an agent never suggests every link it saves.
    expect(SAVE_LINK).toContain(
      `If you don't ask about such a page, send "keep" with "inferred", which only suggests it.`,
    );
    expect(SAVE_LINK).toMatch(/repeat save ignores handy.*update_link/s);
  });

  it("tells update_link what each action does and what the handy view holds", () => {
    for (const word of ['"keep"', '"still_using"', '"not_handy"', "{status, source, due}"]) {
      expect(UPDATE_LINK).toContain(word);
    }
    expect(UPDATE_LINK).toMatch(/"inferred" only suggests it/);
    expect(UPDATE_LINK).toContain('"keep" keeps the link handy as a tool');
    expect(UPDATE_LINK).not.toMatch(/shelf/i);
    expect(UPDATE_LINK).toMatch(/present a "suggested" link as a guess/);
  });

  it("tells get_digest to report the days since the last recorded opening, never that the owner hasn't used it", () => {
    expect(GET_DIGEST).toContain("daysSinceOpened");
    expect(GET_DIGEST).toMatch(/last recorded opening/);
    expect(GET_DIGEST).toContain("never say the owner hasn't used it");
    expect(GET_DIGEST).toMatch(/Bookmark clicks are not seen/);
    // Every handy example carries the source the schema requires.
    expect(GET_DIGEST).toContain('handy {action: "still_using", source: "asked"}');
    expect(GET_DIGEST).toContain('handy {action: "not_handy", source: "asked"}');
  });

  it("leaves the server instructions as they were, already at the 2048-character limit", () => {
    expect(INSTRUCTIONS).not.toContain("handy");
  });
});
