import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { orderNav, orderSelect, orderSelectScript } from "./link-orders.js";

const dom = (html: string) => parseHTML(html).document;

describe("orderNav", () => {
  it("links each order in turn with the address the page gives, marking only the current one", () => {
    const links = [...dom(orderNav("oldest", (o) => `/x?o=${o}&a=1&b=2`)).querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Newest first", "/x?o=newest&a=1&b=2"],
      ["Oldest first", "/x?o=oldest&a=1&b=2"],
      ["Recently opened", "/x?o=opened&a=1&b=2"],
    ]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "true", null]);
  });
});

describe("orderSelect", () => {
  const select = (order: "newest" | "oldest" | "opened") =>
    dom(orderSelect(order, { action: "/spaces", hidden: { tag: 'a "b" <c>' } }));

  it("is a GET form to the action with the hidden fields, a label and the order selected", () => {
    const d = select("opened");
    const form = d.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/spaces");
    expect(form?.getAttribute("method")).toBe("get");
    expect(d.querySelector("input[name=tag]")?.getAttribute("value")).toBe('a "b" <c>');
    expect(d.querySelector("label[for=order]")?.textContent).toBe("Order");
    const options = [...d.querySelectorAll("option")];
    expect(options.map((o) => [o.getAttribute("value"), o.textContent])).toEqual([
      ["", "Newest first"],
      ["oldest", "Oldest first"],
      ["opened", "Recently opened"],
    ]);
    expect(options.map((o) => o.hasAttribute("selected"))).toEqual([false, false, true]);
  });

  it("selects newest, whose option sends no value, when no other order is asked", () => {
    const options = [...select("newest").querySelectorAll("option")];
    expect(options.map((o) => o.hasAttribute("selected"))).toEqual([true, false, false]);
  });

  describe("script", () => {
    /** Picks each of `values` in turn; the select's name at each submit is what the form would send. */
    function choose(...values: string[]) {
      const { document, window } = parseHTML(
        orderSelect("newest", { action: "/spaces", hidden: { tag: "k" } }),
      );
      const form = document.querySelector("form") as HTMLFormElement;
      const field = form.querySelector("select") as HTMLSelectElement;
      new Function("document", orderSelectScript)(document);
      const sent: (string | null)[] = [];
      form.submit = () => sent.push(field.getAttribute("name"));
      for (const value of values) {
        // linkedom's select value is read-only.
        Object.defineProperty(field, "value", { get: () => value, configurable: true });
        field.dispatchEvent(new window.Event("change", { bubbles: true }));
      }
      return sent;
    }

    it("submits on a change, naming the select order for a chosen order", () => {
      expect(choose("oldest")).toEqual(["order"]);
    });

    it("leaves the empty newest choice nameless, so it sends no order, and names it again after", () => {
      expect(choose("opened", "", "oldest")).toEqual(["order", "", "order"]);
    });
  });
});
