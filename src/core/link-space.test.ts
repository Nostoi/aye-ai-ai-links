import { describe, expect, it } from "vitest";
import { linkSpace, spaceColor } from "./link-space.js";
import type { Link, LinkTag, Tag } from "./types.js";

const tag = (over: Partial<Tag> & { key: string }): Tag => ({
  name: over.key,
  kind: "topic",
  kindSource: "stated",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
  ...over,
});

const onLink = (key: string): LinkTag => ({
  key,
  name: key,
  source: "stated",
  kind: "topic",
  kindSource: "stated",
});

const link = (...keys: string[]): Pick<Link, "tags"> => ({ tags: keys.map(onLink) });

const KITCHEN = tag({ key: "kitchen", name: "Kitchen", color: "clay", pinned: true });
const HOME = tag({ key: "home", name: "Home batteries", color: "teal", pinned: true });
const BAKING = tag({ key: "baking", name: "Baking", color: "violet" });

describe("linkSpace", () => {
  it("is null for a link with no pinned tag, even one whose tag has a color", () => {
    expect(linkSpace(link(), [KITCHEN])).toBeNull();
    expect(linkSpace(link("baking"), [BAKING, KITCHEN])).toBeNull();
    expect(linkSpace(link("unknown"), [KITCHEN])).toBeNull();
  });

  it("takes the first pinned tag in the order the link's tags were attached", () => {
    const catalog = [HOME, KITCHEN];
    expect(linkSpace(link("baking", "kitchen", "home"), catalog)).toEqual({
      key: "kitchen",
      name: "Kitchen",
      color: "clay",
    });
    expect(linkSpace(link("home", "kitchen"), catalog)?.key).toBe("home");
  });

  it("lets `within` win when it names one of the link's pinned tags", () => {
    const catalog = [HOME, KITCHEN];
    expect(linkSpace(link("kitchen", "home"), catalog, { within: "home" })?.key).toBe("home");
    // Not one of the link's tags, or not pinned: the attach order decides.
    expect(linkSpace(link("kitchen", "home"), catalog, { within: "garden" })?.key).toBe("kitchen");
    expect(linkSpace(link("baking", "kitchen"), [BAKING, KITCHEN], { within: "baking" })?.key).toBe(
      "kitchen",
    );
  });

  it.each([
    ["amber", "amber"],
    ["a capitalised color", "Teal"],
    ["a hex value", "#2F8F83"],
    ["a color with CSS after it", "teal;x"],
    ["no color", null],
  ])("skips a pinned tag with %s and tries the next one", (_, color) => {
    const bad = tag({ key: "bad", color, pinned: true });
    expect(linkSpace(link("bad", "kitchen"), [bad, KITCHEN])?.color).toBe("clay");
    expect(linkSpace(link("bad"), [bad])).toBeNull();
    expect(linkSpace(link("bad", "kitchen"), [bad, KITCHEN], { within: "bad" })?.key).toBe(
      "kitchen",
    );
  });
});

describe("spaceColor", () => {
  it("is a tag's color only when it is a space color, pinned or not", () => {
    expect(spaceColor(BAKING)).toBe("violet");
    expect(spaceColor(KITCHEN)).toBe("clay");
    for (const color of ["amber", "Teal", "teal;x", "", null]) {
      expect(spaceColor(tag({ key: "x", color }))).toBeNull();
    }
  });
});
