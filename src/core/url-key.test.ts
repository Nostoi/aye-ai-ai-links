import { describe, expect, it } from "vitest";
import { CoreError } from "./errors.js";
import { urlKey } from "./url-key.js";

const merges: [string, string][] = [
  ["HTTPS://Ex.COM:443/A/?utm_source=x#top", "https://ex.com/A"],
  ["https://ex.com/a?", "https://ex.com/a"],
  ["https://ex.com/a/", "https://ex.com/a"],
  ["https://ex.com/a//", "https://ex.com/a"],
  ["  https://ex.com  ", "https://ex.com/"],
  ["https://ex.com:8080/a", "https://ex.com:8080/a"],
  ["https://ex.com/a?fbclid=1&x=2&UTM_medium=m&gclid=3", "https://ex.com/a?x=2"],
  ["https://ex.com/a?%75tm_source=x&k=v", "https://ex.com/a?k=v"],
  ["https://ex.com/a?&&k=v&", "https://ex.com/a?k=v"],
  ["https://ex.com/a?_ga=1", "https://ex.com/a"],
  ["https://ex.com/a#/route", "https://ex.com/a#/route"],
  ["https://ex.com/a#!bang", "https://ex.com/a#!bang"],
  ["https://bücher.de/a", "https://xn--bcher-kva.de/a"],
];

const distinct: [string, string][] = [
  ["http://ex.com/a", "https://ex.com/a"],
  ["https://www.ex.com/a", "https://ex.com/a"],
  ["https://ex.com/A", "https://ex.com/a"],
  ["https://ex.com/#/one", "https://ex.com/#/two"],
  ["https://ex.com/?a=%FF", "https://ex.com/?a=%FE"],
  ["https://ex.com/?a=1&b=2", "https://ex.com/?b=2&a=1"],
  ["https://ex.com/?ref=1", "https://ex.com/"],
  ["https://ex.com/a", "https://ex.com:8080/a"],
];

describe("urlKey", () => {
  it.each(merges)("normalizes %s", (input, expected) => {
    expect(urlKey(input)).toBe(expected);
  });

  it.each(distinct)("keeps %s distinct from %s", (a, b) => {
    expect(urlKey(a)).not.toBe(urlKey(b));
  });

  it("keeps raw percent-encoding in the query", () => {
    expect(urlKey("https://ex.com/?a=%FF")).toBe("https://ex.com/?a=%FF");
  });

  it("is idempotent", () => {
    for (const [a, b] of [...merges, ...distinct]) {
      for (const u of [a, b]) expect(urlKey(urlKey(u))).toBe(urlKey(u));
    }
  });

  it.each([
    "ftp://ex.com/a",
    "javascript:alert(1)",
    "not a url",
    "",
    "https://u:p@ex.com/",
    "https://u@ex.com/",
  ])("rejects %j as invalid_url", (input) => {
    try {
      urlKey(input);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CoreError);
      expect((e as CoreError).code).toBe("invalid_url");
    }
  });
});
