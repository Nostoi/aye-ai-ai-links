import { describe, expect, it } from "vitest";
import { isWordPictureHost, keptPreview } from "./word-picture-host.js";

describe("isWordPictureHost", () => {
  it.each([
    "https://github.com/Nostoi/aye-ai-ai-links",
    "http://github.com/x",
    "https://www.github.com/x",
    "https://GitHub.com/x",
    "https://x.com/github/status/1",
    "https://www.x.com/github",
    "https://twitter.com/github",
    "https://www.twitter.com/github",
  ])("is true for %s", (url) => {
    expect(isWordPictureHost(url)).toBe(true);
  });

  it.each([
    "https://gist.github.com/x",
    "https://mobile.twitter.com/github",
    "https://notgithub.com/x",
    "https://github.com.evil.example/x",
    "https://example.com/github.com",
    "not a url",
    "",
  ])("is false for %s", (url) => {
    expect(isWordPictureHost(url)).toBe(false);
  });
});

describe("keptPreview", () => {
  const PREVIEW = "https://opengraph.githubassets.com/abc/Nostoi/aye-ai-ai-links";
  it("keeps the preview of an ordinary page", () => {
    expect(keptPreview("https://example.com/a", PREVIEW)).toBe(PREVIEW);
  });
  it("★ keeps no preview for a word-picture host, judged on the saved address", () => {
    // [Ignoring the host, so GitHub's card of words shows.]
    expect(keptPreview("https://github.com/Nostoi/aye-ai-ai-links", PREVIEW)).toBeNull();
  });
  it("keeps none when the page named none", () => {
    expect(keptPreview("https://example.com/a", null)).toBeNull();
  });
});
