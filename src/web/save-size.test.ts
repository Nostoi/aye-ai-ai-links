import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { loginRedirect, returnAfterLogin } from "../auth/login-return.js";
import { bookmarkletCode, LONG_ADDRESS } from "./bookmarklet.js";

/** Node's 16 KiB limit covers the request line and every header together; this leaves 4 KiB for the headers. */
const MOST = 12_288;
const ORIGIN = "https://links.example";
const PREFIX = "https://ex.com/";
const TITLE = "😀".repeat(200);

/** The URL the bookmarklet passes to `window.open` for `href`. */
function opened(href: string): string {
  let url = "";
  runInNewContext(bookmarkletCode(ORIGIN).slice("javascript:".length), {
    location: { href },
    document: { title: TITLE },
    window: { open: (u: string) => (url = u) },
  });
  return url;
}

/** The longest address of `char` after `PREFIX` that the bookmarklet still sends to the full form. */
function longestSent(char: string): string {
  const address = (n: number) => PREFIX + char.repeat(n);
  let low = 0;
  let high = LONG_ADDRESS;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (opened(address(mid)).endsWith("long=1")) high = mid - 1;
    else low = mid;
  }
  expect(opened(address(low + 1))).toBe(`${ORIGIN}/save?long=1`);
  return address(low);
}

describe("the signed-out Save round trip at the longest address the bookmarklet sends", () => {
  it.each(["(", "/", "é", "'"])(
    "keeps every request under the header limit for an address of %s",
    (char) => {
      const sent = new URL(opened(longestSent(char)));
      const save = sent.pathname + sent.search;
      expect(sent.pathname).toBe("/save");
      const toLogin = loginRedirect(new URL(save, ORIGIN));
      const next = new URL(toLogin, ORIGIN).searchParams.get("next");
      const back = returnAfterLogin(next);
      // The Referer on the return request is the whole login URL.
      const referer = ORIGIN + toLogin;
      expect(save.length).toBeLessThanOrEqual(MOST);
      expect(referer.length).toBeLessThanOrEqual(MOST);
      expect(back.length).toBeLessThanOrEqual(MOST);
    },
  );
});
