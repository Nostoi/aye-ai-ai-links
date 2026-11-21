import { describe, expect, it } from "vitest";
import { mergeTags, normalizeTags } from "./tags.js";
import type { LinkTag, Source, TagKind } from "./types.js";

describe("normalizeTags", () => {
  it("trims, collapses whitespace and lower-cases the key", () => {
    expect(normalizeTags([{ name: "  Home   Batteries ", source: "stated" }])).toEqual([
      {
        key: "home batteries",
        name: "Home Batteries",
        source: "stated",
        kind: "topic",
        kindSource: "inferred",
      },
    ]);
  });

  it("collapses duplicate keys: first name, strongest source, any order", () => {
    const a = { name: "Solar", source: "inferred" as const };
    const b = { name: "solar", source: "stated" as const };
    const c = { name: "SOLAR", source: "asked" as const };
    const tag = (name: string, source: Source) => [
      { key: "solar", name, source, kind: "topic", kindSource: "inferred" },
    ];
    expect(normalizeTags([a, b, c])).toEqual(tag("Solar", "stated"));
    expect(normalizeTags([c, b, a])).toEqual(tag("SOLAR", "stated"));
    expect(normalizeTags([a, c])).toEqual(tag("Solar", "asked"));
  });

  it("takes the kind from the strongest source on duplicate keys, the first on a tie", () => {
    const statedTopic = { name: "Solar", source: "stated" as const, kind: "topic" as const };
    const inferredProject = {
      name: "SOLAR",
      source: "inferred" as const,
      kind: "project" as const,
    };
    const statedProject = { name: "solar", source: "stated" as const, kind: "project" as const };
    const tag = (name: string, kind: string) => [
      { key: "solar", name, source: "stated", kind, kindSource: "stated" },
    ];
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

describe("normalizeTags: who decided the kind", () => {
  type Mention = { name: string; source: Source; kind?: TagKind };
  const one = (...mentions: Mention[]) => {
    const [tag, ...rest] = normalizeTags(mentions);
    expect(rest).toEqual([]);
    return { source: tag?.source, kind: tag?.kind, kindSource: tag?.kindSource };
  };

  it("an explicit kind carries its mention's source", () => {
    expect(one({ name: "x", source: "inferred", kind: "project" })).toMatchObject({
      kind: "project",
      kindSource: "inferred",
    });
    expect(one({ name: "x", source: "asked", kind: "project" })).toMatchObject({
      kind: "project",
      kindSource: "asked",
    });
    expect(one({ name: "x", source: "stated", kind: "project" })).toMatchObject({
      kind: "project",
      kindSource: "stated",
    });
  });

  it("no kind gives a topic nobody stated, whatever the mention's source", () => {
    for (const source of ["stated", "asked", "inferred"] as const) {
      expect(one({ name: "x", source })).toMatchObject({ kind: "topic", kindSource: "inferred" });
    }
  });

  it("the winning mention decides, so a losing explicit kind never supplies the source", () => {
    const askedProject: Mention = { name: "x", source: "asked", kind: "project" };
    const stated: Mention = { name: "X", source: "stated" };
    const expected = { source: "stated", kind: "topic", kindSource: "inferred" };
    expect(one(askedProject, stated)).toEqual(expected);
    expect(one(stated, askedProject)).toEqual(expected);
  });

  it("a stronger explicit kind wins over a weaker one, in either order", () => {
    const inferredProject: Mention = { name: "x", source: "inferred", kind: "project" };
    const statedProject: Mention = { name: "X", source: "stated", kind: "project" };
    const expected = { source: "stated", kind: "project", kindSource: "stated" };
    expect(one(inferredProject, statedProject)).toEqual(expected);
    expect(one(statedProject, inferredProject)).toEqual(expected);
  });

  it("on a tie the first mention wins, kind source included", () => {
    const explicit: Mention = { name: "x", source: "stated", kind: "project" };
    const bare: Mention = { name: "X", source: "stated" };
    expect(one(explicit, bare)).toEqual({
      source: "stated",
      kind: "project",
      kindSource: "stated",
    });
    expect(one(bare, explicit)).toEqual({
      source: "stated",
      kind: "topic",
      kindSource: "inferred",
    });
  });
});

describe("mergeTags", () => {
  const tag = (key: string, source: Source, kind: TagKind = "topic"): LinkTag => ({
    key,
    name: key,
    source,
    kind,
    kindSource: source,
  });
  const brief = (tags: LinkTag[]) => tags.map((t) => `${t.key}:${t.source}`);

  it("a guess keeps every stated or asked tag it leaves out, in place", () => {
    const current = [tag("a", "stated"), tag("b", "asked"), tag("c", "inferred")];
    const merged = mergeTags(current, [tag("d", "inferred")], true);
    expect(brief(merged)).toEqual(["a:stated", "b:asked", "d:inferred"]);
  });

  it("a guess never turns an owner tag into a guess", () => {
    const current = [tag("a", "stated", "project")];
    expect(mergeTags(current, [tag("a", "inferred")], true)).toEqual(current);
  });

  it("a guess removes inferred tags it leaves out and keeps ones it repeats", () => {
    const current = [tag("a", "inferred"), tag("b", "inferred")];
    expect(brief(mergeTags(current, [tag("b", "inferred")], true))).toEqual(["b:inferred"]);
    expect(mergeTags(current, [], true)).toEqual([]);
  });

  it("a guess keeps the current order and adds new tags after it, in the guess's order", () => {
    const current = [tag("a", "stated"), tag("b", "inferred")];
    const sent = [tag("z", "inferred"), tag("b", "inferred"), tag("y", "inferred")];
    expect(brief(mergeTags(current, sent, true))).toEqual([
      "a:stated",
      "b:inferred",
      "z:inferred",
      "y:inferred",
    ]);
  });

  it("an inferred tag the guess sends as stated becomes stated", () => {
    expect(brief(mergeTags([tag("a", "inferred")], [tag("a", "stated")], true))).toEqual([
      "a:stated",
    ]);
  });

  it("the owner's say replaces the set in its own order", () => {
    const current = [tag("a", "stated"), tag("b", "inferred")];
    const sent = [tag("c", "stated"), tag("b", "inferred")];
    expect(brief(mergeTags(current, sent, false))).toEqual(["c:stated", "b:inferred"]);
    expect(mergeTags(current, [], false)).toEqual([]);
  });

  it("the owner's say still never turns an owner tag into a guess", () => {
    expect(brief(mergeTags([tag("a", "stated")], [tag("a", "inferred")], false))).toEqual([
      "a:stated",
    ]);
  });
});
