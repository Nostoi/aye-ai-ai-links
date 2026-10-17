import { describe, expect, it } from "vitest";
import { loginRedirect, returnAfterLogin } from "../auth/login-return.js";
import { LONG_ADDRESS } from "./bookmarklet.js";

/** Node's 16 KiB limit covers the request line and every header together; this leaves 4 KiB for the headers. */
const MOST = 12_288;
const ORIGIN = "https://links.example";
const PREFIX = "https://ex.com/";
const TITLE = "😀".repeat(200);

/** An address whose encoded length is exactly `LONG_ADDRESS`, built mostly from `char`. */
function addressOf(char: string): string {
  const room = LONG_ADDRESS - encodeURIComponent(PREFIX).length;
  const cost = encodeURIComponent(char).length;
  const count = Math.floor(room / cost);
  const address = PREFIX + char.repeat(count) + "a".repeat(room - count * cost);
  expect(encodeURIComponent(address)).toHaveLength(LONG_ADDRESS);
  return address;
}

describe("the signed-out Save round trip at the longest address the bookmarklet sends", () => {
  it.each(["(", "/", "é"])(
    "keeps every request under the header limit for an address of %s",
    (char) => {
      const save = `/save?url=${encodeURIComponent(addressOf(char))}&title=${encodeURIComponent(TITLE)}`;
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
