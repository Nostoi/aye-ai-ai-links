import { describe, expect, it } from "vitest";
import { decodeHtml } from "./decode-html.js";

const latin1 = (text: string) => Buffer.from(text, "latin1");

describe("decodeHtml", () => {
  it("decodes UTF-8 when nothing says otherwise", () => {
    expect(decodeHtml(Buffer.from("<p>café ☕</p>"), "text/html")).toBe("<p>café ☕</p>");
  });

  it("takes the charset from the Content-Type header", () => {
    expect(decodeHtml(latin1("<p>café</p>"), "text/html; charset=ISO-8859-1")).toBe("<p>café</p>");
  });

  it("takes the charset from <meta charset> when the header has none", () => {
    const bytes = latin1('<meta charset="iso-8859-2"><p>\xb1</p>');
    expect(decodeHtml(bytes, "text/html")).toContain("ą");
  });

  it("takes the charset from a <meta http-equiv> declaration", () => {
    const bytes = latin1(
      '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>café</p>',
    );
    expect(decodeHtml(bytes, "text/html")).toContain("café");
  });

  it("prefers the header over <meta>", () => {
    const bytes = latin1('<meta charset="utf-8"><p>café</p>');
    expect(decodeHtml(bytes, "text/html; charset=iso-8859-1")).toContain("café");
  });

  it("lets a UTF-8 BOM beat the header, and strips it", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>café</p>")]);
    expect(decodeHtml(bytes, "text/html; charset=iso-8859-1")).toBe("<p>café</p>");
  });

  it("lets a UTF-16LE BOM beat the header", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<p>é</p>", "utf16le")]);
    expect(decodeHtml(bytes, "text/html; charset=utf-8")).toBe("<p>é</p>");
  });

  it("falls back to UTF-8 for an unknown header label, without throwing", () => {
    const bytes = Buffer.concat([Buffer.from("<p>caf"), Buffer.from([0xe9]), Buffer.from("</p>")]);
    expect(decodeHtml(bytes, "text/html; charset=not-a-charset")).toBe("<p>caf�</p>");
  });

  it("falls back to UTF-8 for an unknown <meta> label", () => {
    const bytes = Buffer.from('<meta charset="not-a-charset"><p>café</p>');
    expect(decodeHtml(bytes, "text/html")).toContain("café");
  });
});
