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

describe("intent guidance", () => {
  it("tells agents in the instructions to label intent like the why, save_link how to send it, and update_link what each means", () => {
    expect(INSTRUCTIONS).toContain("Intent (explore or keep) is labelled like the why.");
    expect(SAVE_LINK).toContain("with intentSource. A repeat save ignores it too.");
    for (const text of ["To explore", "To keep", '"inferred" if you worked it out']) {
      expect(UPDATE_LINK).toContain(text);
    }
    expect(UPDATE_LINK).toContain("An inferred intent never replaces one the owner gave");
    expect(UPDATE_LINK).toContain("A link kept handy stays To keep");
    expect(UPDATE_LINK).toContain("Send both intent and intentSource, or neither");
  });
});

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

describe("get_stats guidance", () => {
  const GET_STATS = (guidance as Record<string, string>).GET_STATS ?? "";

  it("says counts are distinct links, opened misses outside openings, and partialCounts names the low ones", () => {
    expect(GET_STATS).toMatch(/distinct links, not events/);
    expect(GET_STATS).toMatch(/opened only counts openings made through the app or an AI/);
    expect(GET_STATS).toMatch(/misses any opening from a browser bookmark/);
    expect(GET_STATS).toMatch(/trackingSince/);
    expect(GET_STATS).toMatch(
      /partialCounts names the counts that may be too low.*say so for those counts; the others don't depend on when tracking began/,
    );
    expect(GET_STATS).not.toMatch(/treat the others as complete/);
  });

  it("counts archived links in setAside, as stats.ts does (#288)", () => {
    expect(GET_STATS).toMatch(/setAside is links archived or declined as a kept tool;/);
  });

  it("tells agents to present the reading as a guess", () => {
    expect(GET_STATS).toMatch(/reading.*guess.*never as a fact/s);
  });

  it("says the reading is null when the server has no AI connection", () => {
    expect(GET_STATS).toMatch(/null.*no AI connection/s);
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
    for (const kind of ["focus_words", "no_why", "not_opened_recently", "still_using_check"]) {
      expect(GET_DIGEST).toContain(`- ${kind}:`);
    }
    expect(GET_DIGEST).not.toContain("came_back");
    expect(GET_DIGEST).not.toContain("never_surfaced");
    expect(GET_DIGEST).toContain("Reasons may be empty");
    const focusLine = GET_DIGEST.split("\n").find((l) => l.startsWith("- focus_words:")) ?? "";
    expect(focusLine).toContain("`words`");
    expect(focusLine).toContain("own title, summary, why or tags");
    expect(GET_DIGEST).toContain("not proof it is relevant");
    expect(GET_DIGEST).toContain('source is "inferred" as a guess');
    expect(GET_DIGEST).toContain('update_link as "asked"');
    expect(GET_DIGEST).toContain("never tell the owner they haven't opened it");
    expect(GET_DIGEST).toContain("snoozedUntil");
    expect(GET_DIGEST).toContain("a repeat call returns the same links");
    expect(GET_DIGEST).not.toMatch(/marks the links it returns/);
  });

  it("says how long a snooze holds the link back from Tidy up and from Explore", () => {
    expect(GET_DIGEST).toContain(
      "A snooze of up to two weeks also holds the link back from Tidy up; a longer one hides it from Explore only.",
    );
  });

  it("says the web page records openings too, and does not claim agents are the only source", () => {
    expect(GET_DIGEST).not.toContain("recorded only when an agent sends opened: true");
    // #124: openings are recorded from every web page, not only home's cards.
    expect(GET_DIGEST).toMatch(/opened: true.*from the web page.*bookmark/s);
    expect(GET_DIGEST).not.toMatch(/home page/);
  });
});

describe("archiving guidance", () => {
  it('get_digest offers to archive a link, sending state "archived"', () => {
    expect(GET_DIGEST).toContain('archive it (state "archived")');
    expect(GET_DIGEST).toContain("offer to archive it or send handy");
    expect(GET_DIGEST).not.toMatch(/mark it done/);
  });

  it("update_link says opening never changes state, and has no putAway", () => {
    expect(UPDATE_LINK).toContain("Opening a link never changes its state.");
    expect(UPDATE_LINK).not.toContain("putAway");
    expect(UPDATE_LINK).toContain("archived means the owner archived it");
  });
});

describe("gone guidance", () => {
  it("get_link, search_links and list_links end with the gone note; the shared instructions do not carry it", () => {
    const GONE_NOTE = (guidance as Record<string, string>).GONE_NOTE ?? "";
    expect(GONE_NOTE).toMatch(
      /seems gone.*never that it is certainly dead.*offer to archive it \(update_link state "archived"\)/s,
    );
    expect(GONE_NOTE).not.toMatch(/mark it done/);
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

  it("leaves Keep handy out of the server instructions, which sit at the 2048-character limit", () => {
    expect(INSTRUCTIONS).not.toContain("handy");
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    expect(SAVE_LINK.length).toBeLessThanOrEqual(2048);
    expect(UPDATE_LINK.length).toBeLessThanOrEqual(2048);
  });
});

describe("open link guidance (#133)", () => {
  const LINK_TOOLS = {
    search_links: guidance.SEARCH_LINKS,
    list_links: guidance.LIST_LINKS,
    get_link: guidance.GET_LINK,
    get_digest: GET_DIGEST,
  };

  it("tells every tool that hands out links to show openUrl, and not to send opened: true for it", () => {
    for (const [tool, text] of Object.entries(LINK_TOOLS)) {
      expect(text, tool).toMatch(/link to click, show its openUrl/);
      expect(text, tool).toMatch(/url if openUrl is null/);
      expect(text, tool).toMatch(/records the opening, so don't also send opened: true/);
    }
    expect(GET_DIGEST).not.toContain("Send opened: true if the owner opens one");
  });

  it("tells the tools an agent reads pages from to fetch url, never openUrl", () => {
    for (const text of [
      guidance.SEARCH_LINKS,
      guidance.LIST_LINKS,
      guidance.GET_LINK,
      GET_DIGEST,
    ]) {
      expect(text).toContain("fetch url, never openUrl");
    }
  });

  it("says an openUrl click is a recorded opening wherever the texts say how openings are recorded", () => {
    expect(UPDATE_LINK).toMatch(
      /opened: true when the owner opens the link other than through its openUrl/,
    );
    expect(guidance.LIST_LINKS).toMatch(/from the web page or an openUrl/);
    expect(GET_DIGEST).toMatch(/from the web page or an openUrl/);
    expect(guidance.GET_STATS).toMatch(/on the web page or through an openUrl/);
  });
});

describe("undo_tag_change guidance", () => {
  it("after a too-late refusal has the agent show the owner what list_tags shows and let them decide, never judging it already undone", () => {
    const text = guidance.UNDO_TAG_CHANGE;
    expect(text).toMatch(/tell the owner what list_tags shows/i);
    expect(text).toMatch(/owner decides/i);
    expect(text).not.toMatch(/do not offer/i);
    expect(text).not.toMatch(/shows the change already undone/i);
    expect(text.length).toBeLessThanOrEqual(2048);
  });

  it("reverses a merge or delete by hand only by re-adding the tag with update_link, never by renaming back", () => {
    const text = guidance.UNDO_TAG_CHANGE;
    expect(text).toMatch(/update_link/);
    expect(text).not.toMatch(/update_tag/);
    expect(text).not.toMatch(/rename/i);
  });
});

describe("the intent rule is true of Explore and Tidy up (#340)", () => {
  it("does not promise that Tidy up never asks about a To keep link, and says what Tidy still asks", () => {
    expect(guidance.INTENT_RULE).not.toContain("Today");
    expect(guidance.INTENT_RULE).not.toMatch(/Tidy up never ask/);
    expect(guidance.INTENT_RULE).toContain("Explore never shows it");
    expect(guidance.INTENT_RULE).toContain("whether a gone page still works");
  });
});
