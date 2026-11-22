import { describe, expect, it } from "vitest";
import { openedScript } from "./open-link.js";
import { runPage } from "./opened-test-kit.js";

/** An opening carries the receipt of the list its link sits in, read when the link is clicked (#360). */

const page = (root: string, withReceipt: boolean) =>
  runPage(`<main data-receipt="page-receipt">
<div id="mine" data-receipt="own-receipt"><ul><li data-id="7"><a data-open href="https://a.example/7" target="_blank">Seven</a></li></ul></div>
<div id="bare"><ul><li data-id="8"><a data-open href="https://a.example/8" target="_blank">Eight</a></li></ul></div>
</main>
${openedScript(root, "/links/opened", withReceipt)}`);

describe("openedScript with receipts", () => {
  it("sends the receipt of the nearest list around the link, not the page's", async () => {
    const p = page("mine", true);
    p.dispatch(p.$("#mine a"), "click");
    await p.settle();
    expect(p.sent).toEqual([
      {
        url: "/links/opened",
        body: { id: "7", receipt: "own-receipt" },
        redirect: "manual",
        keepalive: true,
      },
    ]);
  });

  it("sends the page's receipt from a list inside the page's own main", async () => {
    const p = page("bare", true);
    p.dispatch(p.$("#bare a"), "click");
    await p.settle();
    expect(p.sent.map((s) => s.body)).toEqual([{ id: "8", receipt: "page-receipt" }]);
  });

  it("reads the receipt at click time, so a list that gains one later is covered", async () => {
    const p = page("bare", true);
    p.$("main").setAttribute("data-receipt", "later");
    p.dispatch(p.$("#bare a"), "click");
    await p.settle();
    expect(p.sent.map((s) => s.body)).toEqual([{ id: "8", receipt: "later" }]);
  });

  it("sends no receipt when the call asks for none", async () => {
    const p = page("mine", false);
    p.dispatch(p.$("#mine a"), "click");
    await p.settle();
    expect(p.sent.map((s) => s.body)).toEqual([{ id: "7" }]);
  });
});
