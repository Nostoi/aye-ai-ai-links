import { describe, expect, it } from "vitest";
import { finishedMarkdown, imageRef, isCopyDraft, pausedMessage } from "./saved-copy.js";

const N = "0123456789abcdef0123456789abcdef";
const M = "fedcba9876543210fedcba9876543210";

describe("finishedMarkdown", () => {
  it("rewrites stored images to their file and the rest to a lost picture with its alt text", () => {
    const md = `x ![a](${imageRef(1, N)}) y ![b\\]c](${imageRef(2, N)}) ![d](${imageRef(3, N)})`;
    const out = finishedMarkdown(md, N, [
      { n: 1, ext: "jpg" },
      { n: 2, ext: null },
    ]);
    expect(out).toBe("x ![a](images/01.jpg) y ![b\\]c]() ![d]()");
  });

  it("never grows a copy whose pictures are all lost, long alt text included", () => {
    const nums = Array.from({ length: 30 }, (_, n) => n + 1);
    const md = nums.map((n) => `![${"long alt ".repeat(n)}](${imageRef(n, N)})`).join("\n");
    const out = finishedMarkdown(md, N, []);
    expect(out).toBe(nums.map((n) => `![${"long alt ".repeat(n)}]()`).join("\n"));
    expect(Buffer.byteLength(out)).toBeLessThan(Buffer.byteLength(md));
  });

  it.each([
    ["a code span", "`![a](images/01)`"],
    ["a fenced block", "```\n![a](images/01)\n```"],
    ["a finished-looking reference", "![a](images/01.png)"],
    ["another nonce", `![a](${imageRef(1, M)})`],
    ["a reference without the bang", `[x](images/01-${N})`],
  ])("leaves page text alone: %s", (_name, text) => {
    expect(finishedMarkdown(text, N, [{ n: 1, ext: "png" }])).toBe(text);
  });

  it("is not swallowed by an earlier literal image opener", () => {
    expect(finishedMarkdown(`![foo ![a](${imageRef(1, N)})`, N, [{ n: 1, ext: "png" }])).toBe(
      "![foo ![a](images/01.png)",
    );
  });

  it("rewrites a repeated image at every place and never grows", () => {
    const twice = `![a](${imageRef(1, N)}) ![a](${imageRef(1, N)})`;
    expect(finishedMarkdown(twice, N, [{ n: 1, ext: "gif" }])).toBe(
      "![a](images/01.gif) ![a](images/01.gif)",
    );
    const nums = Array.from({ length: 30 }, (_, i) => i + 1);
    const md = nums.flatMap((n) => [1, 2, 3].map(() => `![i](${imageRef(n, N)})`)).join(" ");
    const out = finishedMarkdown(
      md,
      N,
      nums.map((n) => ({ n, ext: "webp" as const })),
    );
    expect(Buffer.byteLength(out)).toBeLessThan(Buffer.byteLength(md));
    expect(out).not.toContain(N);
  });

  it("rewrites a reference whose alt ends in an escaped backslash", () => {
    expect(finishedMarkdown(`![foo\\\\](${imageRef(1, N)})`, N, [{ n: 1, ext: "png" }])).toBe(
      "![foo\\\\](images/01.png)",
    );
  });

  it("refuses an invalid nonce", () => {
    expect(() => finishedMarkdown("x", "x", [])).toThrow("Invalid copy nonce");
  });
});

describe("isCopyDraft", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  const ok = { markdown: "m", imageUrls: ["https://ex.com/a.png"], nonce };
  it("accepts a valid draft", () => {
    expect(isCopyDraft(ok)).toBe(true);
    expect(isCopyDraft({ ...ok, imageUrls: [] })).toBe(true);
  });
  it.each([
    ["a non-object", "x"],
    ["null", null],
    ["a non-string markdown", { ...ok, markdown: 1 }],
    ["a nonce of 31 hex", { ...ok, nonce: nonce.slice(1) }],
    ["an uppercase nonce", { ...ok, nonce: "0123456789ABCDEF0123456789ABCDEF" }],
    [
      "31 URLs",
      { ...ok, imageUrls: Array.from({ length: 31 }, (_, i) => `https://ex.com/${i}.png`) },
    ],
    ["a sparse imageUrls", { ...ok, imageUrls: new Array(1) }],
    [
      "a hole after a valid URL",
      { ...ok, imageUrls: Object.assign([...ok.imageUrls], { length: 2 }) },
    ],
    [
      "a hole hidden by a named property",
      { ...ok, imageUrls: Object.assign(new Array(1), { foo: "x" }) },
    ],
    ["a duplicate pair", { ...ok, imageUrls: ["https://ex.com/a.png", "https://ex.com/a.png"] }],
    ["a string imageUrls", { ...ok, imageUrls: "https://ex.com/a.png" }],
    ["an object with length", { ...ok, imageUrls: { length: 0 } }],
    ["a javascript: URL", { ...ok, imageUrls: ["javascript:alert(1)"] }],
    ["a non-URL string", { ...ok, imageUrls: ["not a url"] }],
  ])("rejects %s", (_name, value) => {
    expect(isCopyDraft(value)).toBe(false);
  });
});

describe("pausedMessage", () => {
  const ACCESS = "Privacy & Security";
  const ASIDE = "move this one aside and restart";
  it("names the folder", () => {
    expect(pausedMessage("/x/copies", { state: "mismatch", detail: "d" })).toContain(
      "paused (/x/copies): d",
    );
  });
  it("advises access for an unwritable EACCES and for a mismatch EACCES", () => {
    for (const state of ["unwritable", "mismatch"] as const) {
      const m = pausedMessage("/x", { state, detail: "EACCES: denied" });
      expect(m).toContain(ACCESS);
      expect(m).not.toContain(ASIDE);
    }
  });
  it("advises moving a plain mismatch aside, and nothing for a plain unwritable", () => {
    expect(pausedMessage("/x", { state: "mismatch", detail: "d" })).toContain(ASIDE);
    expect(pausedMessage("/x", { state: "unwritable", detail: "d" })).toBe(
      "[saved copies] paused (/x): d",
    );
  });
});
