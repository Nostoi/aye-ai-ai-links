import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { LONG_MESSAGE, saveForm } from "./save-form.js";

/** The Save page as served. Its dialog's behaviour is in `save-dialog.test.ts`. */

const NEWS = "https://news.example/a?b=1";
const doc = (html: string) => parseHTML(html).document;
const value = (html: string, id: string) =>
  doc(html).querySelector(`#save-dialog #${id}`)?.getAttribute("value");

describe("the Save page as served", () => {
  it("fills the dialog's address and title, shows the address's host, and leaves the why empty", () => {
    const html = saveForm({ url: NEWS, title: "A story", long: false });
    const d = doc(html);
    expect(d.getElementById("save-dialog")?.hasAttribute("data-page")).toBe(true);
    expect(value(html, "save-url")).toBe(NEWS);
    expect(value(html, "save-title")).toBe("A story");
    expect(d.querySelector("#save-dialog .save-host")?.textContent).toBe(
      "Saving a page from news.example",
    );
    expect(d.querySelector("#save-dialog .save-letter")?.textContent).toBe("N");
    expect(d.getElementById("save-why")?.textContent).toBe("");
    expect(d.querySelector("main h1")?.textContent).toBe("Save a link");
  });

  it("escapes a hostile query into attribute values, never into markup or a script", () => {
    const url = `https://ex.com/"><script>alert(1)</script>`;
    const title = `"><img src=x onerror=alert(2)>`;
    const html = saveForm({ url, title, long: false });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    const d = doc(html);
    expect(d.querySelectorAll("img")).toHaveLength(0);
    expect(value(html, "save-url")).toBe(url);
    expect(value(html, "save-title")).toBe(title);
    for (const script of d.querySelectorAll("script")) {
      expect(script.textContent).not.toContain("alert(");
    }
  });

  it("round-trips ampersands, quotes, a closing textarea and a javascript: address as values", () => {
    const url = "javascript:alert(1)&a=1";
    const title = `Tom & Jerry's </textarea><b>x</b> "q"`;
    const html = saveForm({ url, title, long: false });
    const d = doc(html);
    expect(value(html, "save-url")).toBe(url);
    expect(value(html, "save-title")).toBe(title);
    expect(d.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("hides the host line and the letter for an address that does not parse", () => {
    const d = doc(saveForm({ url: "not an address", title: "", long: false }));
    expect(d.querySelector("#save-dialog .save-host")?.hasAttribute("hidden")).toBe(true);
    expect(d.querySelector("#save-dialog .save-letter")?.textContent).toBe("");
  });

  it("long shows the long-address message, and the dialog is neither opened at load nor filled", () => {
    const d = doc(saveForm({ url: NEWS, title: "A story", long: true }));
    expect(d.querySelector("main")?.textContent).toContain(LONG_MESSAGE);
    expect(d.getElementById("save-dialog")?.hasAttribute("data-page")).toBe(false);
    expect(d.querySelector("#save-dialog #save-url")?.getAttribute("value")).toBe("");
    expect(LONG_MESSAGE).toBe("This page's address is too long to save from the bookmarklet.");
  });

  it("makes no outside request; a filled form's only finding is the address field's own value", () => {
    expect(outsideRefs(saveForm({ url: "", title: "", long: false }))).toEqual([]);
    expect(outsideRefs(saveForm({ url: "", title: "", long: true }))).toEqual([]);
    expect(outsideRefs(saveForm({ url: "https://ex.com/a", title: "T", long: false }))).toEqual([
      "<input value=https://ex.com/a>",
    ]);
  });
});
