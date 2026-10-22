import { describe, expect, it } from "vitest";
import { CPU_BUDGET_TIMEOUT_MS, cpuTimed } from "../core/cpu-time-test-kit.js";
import { decodeHtml } from "./decode-html.js";

const latin1 = (text: string) => Buffer.from(text, "latin1");

describe("decodeHtml", () => {
  it("decodes UTF-8 when nothing says otherwise", () => {
    expect(decodeHtml(Buffer.from("<p>café ☕</p>"), "text/html")).toBe("<p>café ☕</p>");
  });

  it("takes the charset from the Content-Type header", () => {
    expect(decodeHtml(latin1("<p>café</p>"), "text/html; charset=ISO-8859-1")).toBe("<p>café</p>");
  });

  it(
    "reads a header padded with 16,000 spaces after charset= in linear time",
    () => {
      const header = `text/html; charset=${" ".repeat(16_000)}`;
      expect(cpuTimed(() => decodeHtml(Buffer.from("<p>x"), header)).ms).toBeLessThan(100);
    },
    CPU_BUDGET_TIMEOUT_MS,
  );

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

  describe("windows-1252 and the labels that mean it", () => {
    const labels = ["iso-8859-1", "latin1", "windows-1252", "us-ascii"];
    const bytes = Buffer.concat([
      Buffer.from("<p>"),
      Buffer.from([0x80, 0x93, 0x94, 0x96, 0x99, 0x81]),
      Buffer.from("</p>"),
    ]);

    it.each(labels)("maps 0x80-0x9F to the WHATWG table for header label %s", (label) => {
      expect(decodeHtml(bytes, `text/html; charset=${label}`)).toBe(
        "<p>\u20ac\u201c\u201d\u2013\u2122\u0081</p>",
      );
    });

    it.each(labels)("maps 0x80-0x9F to the WHATWG table for <meta> label %s", (label) => {
      const page = Buffer.concat([Buffer.from(`<meta charset="${label}">`), bytes]);
      expect(decodeHtml(page, "text/html")).toContain("\u20ac\u201c\u201d\u2013\u2122\u0081");
    });

    it(
      "decodes a 5 MB page quickly",
      () => {
        const page = Buffer.alloc(5 * 1024 * 1024, 0x93);
        const { result: text, ms } = cpuTimed(() =>
          decodeHtml(page, "text/html; charset=windows-1252"),
        );
        expect(text.length).toBe(page.length);
        expect(text.startsWith("““")).toBe(true);
        expect(ms).toBeLessThan(500);
      },
      CPU_BUDGET_TIMEOUT_MS,
    );

    it("leaves bytes above 0x9F as in ISO-8859-1", () => {
      expect(decodeHtml(Buffer.from([0xe9, 0xff]), "text/html; charset=windows-1252")).toBe(
        "\u00e9\u00ff",
      );
    });
  });

  describe("a UTF-16 label in <meta>", () => {
    it.each(["utf-16", "utf-16le", "utf-16be"])("reads the page as UTF-8 for %s", (label) => {
      const page = Buffer.from(`<meta charset="${label}"><p>caf\u00e9</p>`);
      expect(decodeHtml(page, "text/html")).toBe(`<meta charset="${label}"><p>caf\u00e9</p>`);
    });
  });
});
