import { describe, expect, it } from "vitest";
import type { Tag } from "../core/types.js";
import { backTarget } from "./copy-from.js";

const tag = (key: string, name: string): Tag => ({
  key,
  name,
  kind: "topic",
  kindSource: "stated",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
});
const CATALOG = [tag("kitchen", "Kitchen"), tag("de sk", "Desk & Chair")];
const ALL = { label: "All links", href: "/all" };

describe("backTarget", () => {
  it.each([
    ["/", { label: "Home", href: "/" }],
    ["/all", ALL],
    ["/all/done", { label: "Out of your lists", href: "/all/done" }],
    ["/spaces?tag=kitchen", { label: "Kitchen", href: "/spaces?tag=kitchen" }],
    ["/spaces?tag=KITCHEN", { label: "Kitchen", href: "/spaces?tag=kitchen" }],
    ["/spaces/done?tag=kitchen", { label: "Kitchen", href: "/spaces/done?tag=kitchen" }],
    ["/spaces?tag=de%20sk", { label: "Desk & Chair", href: "/spaces?tag=de%20sk" }],
    ["/search?q=quokka", { label: "your search", href: "/search?q=quokka" }],
    [
      "/search?q=a%20b&tag=kitchen&keep=1",
      { label: "your search", href: "/search?q=a%20b&tag=kitchen&keep=1" },
    ],
    ["/search", { label: "your search", href: "/search?q=" }],
  ])("maps %s to a rebuilt address and a fixed label", (raw, expected) => {
    expect(backTarget(raw, CATALOG)).toEqual(expected);
  });

  it("drops the order and the page position, so Back lands on the list's first page", () => {
    expect(backTarget("/all?order=opened&before=garbage", CATALOG)).toEqual(ALL);
    expect(backTarget("/all/done?before=x", CATALOG)).toEqual({
      label: "Out of your lists",
      href: "/all/done",
    });
    expect(backTarget("/spaces?tag=kitchen&order=banana&before=zz", CATALOG)).toEqual({
      label: "Kitchen",
      href: "/spaces?tag=kitchen",
    });
    expect(backTarget("/search?q=x&order=opened&before=9", CATALOG).href).toBe("/search?q=x");
  });

  it("keeps a search's words but drops a tag the owner has not got", () => {
    expect(backTarget("/search?q=x&tag=nope", CATALOG)).toEqual({
      label: "your search",
      href: "/search?q=x",
    });
    expect(backTarget("/search?q=x&tag=nope&keep=1", []).href).toBe("/search?q=x&keep=1");
  });

  it("falls back to All links when the value is not a path to a list the owner can have", () => {
    for (const raw of [
      undefined,
      "",
      "//evil.example/",
      "//evil.example/all",
      "https://evil.example/all",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "/links/1/copy",
      "/links/1/copy?from=/all",
      "/tags",
      "/all/",
      "/ALL",
      "/spaces",
      "/spaces?tag=nobody",
      "/spaces?tag=",
      "/spaces/done?tag=someone-elses",
      "/all%2Fdone",
      "/\t/evil.example",
      "all",
    ]) {
      expect(backTarget(raw, CATALOG), String(raw)).toEqual(ALL);
    }
  });
});
