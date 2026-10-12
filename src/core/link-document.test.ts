import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type DocumentInput,
  documentHash,
  linkDocument,
  PAGE_CHARS,
  SUMMARY_CHARS,
} from "./link-document.js";

const input = (o: Partial<DocumentInput> = {}): DocumentInput => ({
  url: "https://ex.com/a",
  title: "Title",
  summary: "Summary",
  why: "Why",
  tags: ["one", "two"],
  pageTitle: "Page title",
  pageDescription: "Page description",
  pageText: "Page text",
  ...o,
});

const codePoints = (s: string) => [...s].length;
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("linkDocument (D-T1)", () => {
  it("puts the owner fields first, then the URL, then the page parts, one per line", () => {
    expect(linkDocument(input())).toBe(
      [
        "Title",
        "Why",
        "one, two",
        "Summary",
        "https://ex.com/a",
        "Page title",
        "Page description",
        "Page text",
      ].join("\n"),
    );
  });

  it("skips empty and missing parts", () => {
    const doc = linkDocument(
      input({ title: null, why: "", tags: [], summary: "  ", pageTitle: null, pageText: null }),
    );
    expect(doc).toBe("https://ex.com/a\nPage description");
  });

  it("is never empty: a link with nothing but its URL is its URL", () => {
    const doc = linkDocument({
      url: "https://github.com/x",
      title: null,
      summary: null,
      why: null,
      tags: [],
      pageTitle: null,
      pageDescription: null,
      pageText: null,
    });
    expect(doc).toBe("https://github.com/x");
  });

  it("caps the summary at 1,000 code points", () => {
    const doc = linkDocument(input({ summary: "s".repeat(SUMMARY_CHARS + 50) }));
    expect(doc).toContain(`\n${"s".repeat(SUMMARY_CHARS)}\nhttps://ex.com/a`);
  });

  it("cuts only the page parts, to 1,500 code points counting their line breaks", () => {
    const doc = linkDocument(
      input({
        pageTitle: "T".repeat(700),
        pageDescription: "D".repeat(700),
        pageText: "X".repeat(5000),
      }),
    );
    const page = doc.slice(doc.indexOf("https://ex.com/a\n") + "https://ex.com/a\n".length);
    expect(codePoints(page)).toBe(PAGE_CHARS);
    expect(page).toBe(`${"T".repeat(700)}\n${"D".repeat(700)}\n${"X".repeat(PAGE_CHARS - 1402)}`);
  });

  it("never splits a surrogate pair at the page cut", () => {
    const doc = linkDocument(
      input({ pageTitle: null, pageDescription: null, pageText: "😀".repeat(PAGE_CHARS + 10) }),
    );
    expect(doc).not.toMatch(loneSurrogate);
    expect(doc.endsWith("😀".repeat(PAGE_CHARS))).toBe(true);
  });

  it("never splits a surrogate pair in the summary", () => {
    // The leading "a" puts a code-unit cut at 1,000 in the middle of a pair.
    const doc = linkDocument(input({ summary: `a${"😀".repeat(SUMMARY_CHARS)}` }));
    expect(doc).not.toMatch(loneSurrogate);
    expect(doc).toContain(`\na${"😀".repeat(SUMMARY_CHARS - 1)}\nhttps://ex.com/a`);
  });

  it("D-T1b: long owner fields are kept whole; why and tags survive a 1,000-char title and summary", () => {
    const before = input({
      title: "T".repeat(1000),
      summary: "S".repeat(1000),
      why: "Learning about automobile repairs",
      tags: ["Car maintenance"],
    });
    const after = { ...before, why: "Learning about vegetable gardening", tags: ["Gardening"] };
    const a = linkDocument(before);
    const b = linkDocument(after);
    expect(a).toContain("Learning about automobile repairs");
    expect(a).toContain("Car maintenance");
    expect(a).toContain("T".repeat(1000));
    expect(b).toContain("Gardening");
    expect(documentHash("m", a)).not.toBe(documentHash("m", b));
  });

  it("keeps a very long title whole: the page budget never touches owner fields", () => {
    const doc = linkDocument(input({ title: "T".repeat(5000) }));
    expect(doc.startsWith(`${"T".repeat(5000)}\nWhy`)).toBe(true);
  });
});

describe("documentHash (D-T2)", () => {
  it("is the sha256 hex of the model key, a line break and the document", () => {
    expect(documentHash("m", "doc")).toBe(createHash("sha256").update("m\ndoc").digest("hex"));
  });

  it("is the same for the same input", () => {
    expect(documentHash("m", linkDocument(input()))).toBe(documentHash("m", linkDocument(input())));
  });

  it("changes when any part changes", () => {
    const base = documentHash("m", linkDocument(input()));
    const edits: Partial<DocumentInput>[] = [
      { title: "Other" },
      { summary: "Other" },
      { why: "Other" },
      { tags: ["one"] },
      { tags: ["two", "one"] },
      { url: "https://ex.com/b" },
      { pageTitle: "Other" },
      { pageDescription: "Other" },
      { pageText: "Other" },
    ];
    for (const e of edits) {
      expect(documentHash("m", linkDocument(input(e))), JSON.stringify(e)).not.toBe(base);
    }
  });

  it("changes with the model key", () => {
    const doc = linkDocument(input());
    expect(documentHash("m1", doc)).not.toBe(documentHash("m2", doc));
  });
});
