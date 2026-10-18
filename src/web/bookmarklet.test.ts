import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { bookmarkletCode, LONG_ADDRESS } from "./bookmarklet.js";

const BASE = "https://links.example";

/**
 * Runs the code against a fake page in its own realm. Every property read, write, definition and
 * deletion on `location`, `document` and `window` is recorded, so a test can show it touched
 * nothing but what it must.
 */
function run(code: string, href: string, title: string) {
  const touched: string[] = [];
  const opened: unknown[][] = [];
  const fake = (name: string, values: Record<string, unknown>) =>
    new Proxy(values, {
      get(target, key) {
        touched.push(`${name}.${String(key)}`);
        return target[key as string];
      },
      set(_target, key) {
        touched.push(`set ${name}.${String(key)}`);
        return true;
      },
      defineProperty(_target, key) {
        touched.push(`define ${name}.${String(key)}`);
        return true;
      },
      deleteProperty(_target, key) {
        touched.push(`delete ${name}.${String(key)}`);
        return true;
      },
    });
  const context = {
    location: fake("location", { href }),
    document: fake("document", { title }),
    window: fake("window", {
      open: (...args: unknown[]) => {
        opened.push(args);
        return null;
      },
    }),
  };
  expect(code.startsWith("javascript:")).toBe(true);
  const result = runInNewContext(code.slice("javascript:".length), context);
  return { result, touched, opened };
}

const saveUrl = (href: string, title: string) =>
  `${BASE}/save?url=${encodeURIComponent(href)}&title=${encodeURIComponent(title)}`;

describe("bookmarkletCode", () => {
  it("opens the Save page for this page in a new tab, with noopener, and touches nothing else", () => {
    const href = "https://news.example/a?b=1&c=d#top";
    const { result, touched, opened } = run(bookmarkletCode(BASE), href, "A story");
    expect(opened).toEqual([[saveUrl(href, "A story"), "_blank", "noopener"]]);
    expect(result).toBeUndefined();
    expect(touched).toEqual(["location.href", "document.title", "window.open"]);
  });

  it("trims the title and cuts it to 200 code points, dropping a 201st emoji whole", () => {
    const title = `  ${"x".repeat(199)}😀😀  `;
    const { opened } = run(bookmarkletCode(BASE), "https://ex.com/", title);
    expect(opened[0]?.[0]).toBe(saveUrl("https://ex.com/", `${"x".repeat(199)}😀`));
  });

  it(`opens the full form for an encoded address of ${LONG_ADDRESS} characters, and ?long=1 past it`, () => {
    const prefix = "https://ex.com/";
    const fits = prefix + "a".repeat(LONG_ADDRESS - encodeURIComponent(prefix).length);
    expect(encodeURIComponent(fits)).toHaveLength(LONG_ADDRESS);
    const over = `${fits}a`;
    expect(run(bookmarkletCode(BASE), fits, "T").opened[0]?.[0]).toBe(saveUrl(fits, "T"));
    expect(run(bookmarkletCode(BASE), over, "T").opened[0]?.[0]).toBe(`${BASE}/save?long=1`);
  });

  it("counts each apostrophe as the three characters a browser sends it as", () => {
    const prefix = "https://ex.com/";
    const room = LONG_ADDRESS - encodeURIComponent(prefix).length;
    const fits = prefix + "'".repeat(Math.floor(room / 3));
    const over = `${fits}'`;
    expect(run(bookmarkletCode(BASE), fits, "T").opened[0]?.[0]).toBe(saveUrl(fits, "T"));
    expect(run(bookmarkletCode(BASE), over, "T").opened[0]?.[0]).toBe(`${BASE}/save?long=1`);
  });

  it("holds no % character, which a browser would decode in a bookmark's address", () => {
    expect(bookmarkletCode(BASE)).not.toContain("%");
  });

  it("quotes an origin that holds a double quote, so the code holds no % and opens that origin", () => {
    const origin = new URL('https://a"b.example').origin;
    expect(origin).toContain('"');
    const code = bookmarkletCode('https://a"b.example');
    expect(code).not.toContain("%");
    const { opened } = run(code, "https://ex.com/", "T");
    expect(String(opened[0]?.[0]).startsWith(`${origin}/save?url=`)).toBe(true);
  });

  it("uses only the configured origin, never a path or query that came with it", () => {
    const { opened } = run(bookmarkletCode(`${BASE}/some/path?q=1`), "https://ex.com/", "T");
    expect(opened[0]?.[0]).toBe(saveUrl("https://ex.com/", "T"));
  });
});
