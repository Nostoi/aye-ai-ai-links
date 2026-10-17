import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { LONG_MESSAGE, saveForm } from "./save-form.js";

const NEWS = "https://news.example/a?b=1";
const doc = (html: string) => parseHTML(html).document;
const value = (html: string, id: string) => doc(html).getElementById(id)?.getAttribute("value");

describe("the Save page as served", () => {
  it("fills the address and title, shows the address's host, and leaves the why empty", () => {
    const html = saveForm({ url: NEWS, title: "A story", long: false });
    const d = doc(html);
    const address = d.getElementById("save-url");
    expect(address?.getAttribute("type")).toBe("url");
    expect(address?.hasAttribute("required")).toBe(true);
    expect(address?.getAttribute("value")).toBe(NEWS);
    expect(value(html, "save-title")).toBe("A story");
    expect(d.getElementById("save-host")?.textContent).toBe("Saving a page from news.example");
    expect(d.getElementById("save-host")?.hasAttribute("hidden")).toBe(false);
    expect(d.getElementById("save-why")?.tagName).toBe("TEXTAREA");
    expect(d.getElementById("save-why")?.textContent).toBe("");
    expect(d.querySelector('label[for="save-why"]')?.textContent).toBe(
      "Why are you saving it? (optional)",
    );
    expect(d.querySelector("#save-form button[type=submit]")?.textContent).toBe("Save");
    expect(d.getElementById("result")?.hasAttribute("hidden")).toBe(true);
    expect(d.getElementById("save-heading")?.textContent).toBe("Save a link");
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

  it("has each id Task 5's script relies on exactly once, filled or empty", () => {
    const ids = [
      "save-heading",
      "save-form",
      "save-url",
      "save-host",
      "url-error",
      "save-title",
      "title-error",
      "save-why",
      "save-error",
      "result",
      "saved-link",
      "saved-why",
      "why-kept",
      "bring-back",
      "close",
      "close-note",
      "result-error",
    ];
    for (const o of [
      { url: NEWS, title: "A story" },
      { url: "", title: "" },
    ]) {
      const d = doc(saveForm({ ...o, long: false }));
      for (const id of ids) {
        expect(d.querySelectorAll(`[id="${id}"]`), id).toHaveLength(1);
      }
    }
  });

  it("round-trips ampersands, quotes, a closing textarea and a javascript: address as values", () => {
    const url = "javascript:alert(1)&a=1";
    const title = `Tom & Jerry's </textarea><b>x</b> "q"`;
    const html = saveForm({ url, title, long: false });
    const d = doc(html);
    expect(value(html, "save-url")).toBe(url);
    expect(value(html, "save-title")).toBe(title);
    expect(d.querySelectorAll("b")).toHaveLength(0);
    expect(d.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("hides the host line for an address that does not parse", () => {
    const d = doc(saveForm({ url: "not an address", title: "", long: false }));
    expect(d.getElementById("save-host")?.hasAttribute("hidden")).toBe(true);
  });

  it("is an empty add-a-link form with no query", () => {
    const html = saveForm({ url: "", title: "", long: false });
    expect(value(html, "save-url")).toBe("");
    expect(value(html, "save-title")).toBe("");
    expect(doc(html).getElementById("save-host")?.hasAttribute("hidden")).toBe(true);
  });

  it("long shows the long-address message and no form", () => {
    const d = doc(saveForm({ url: "", title: "", long: true }));
    expect(d.querySelector("form")).toBeNull();
    expect(d.querySelector("main")?.textContent).toContain(LONG_MESSAGE);
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
