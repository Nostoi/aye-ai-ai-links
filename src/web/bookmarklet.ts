import { SAVE_PATH } from "../auth/login-return.js";
import { TITLE_MAX } from "../core/links.js";

/**
 * The longest address, once encoded, that the bookmarklet sends (#129). The signed-out path
 * encodes the Save address again inside `/login?next=`, so this keeps that request under Node's
 * 16 KiB header limit; past it, the bookmarklet opens `/save?long=1`.
 */
export const LONG_ADDRESS = 4_000;

/**
 * The bookmarklet: one `javascript:` URL that opens this site's Save page in a new tab, with
 * `noopener`, filled with the current page's address and title. It reads `location.href` and
 * `document.title` and calls `window.open`, and nothing else, so it changes and sends nothing in
 * the page it runs on. The title is trimmed and cut to `TITLE_MAX` code points, as core counts
 * them. The code ends by evaluating to `undefined`, so the browser keeps the page, and holds no
 * `%`, which a browser decodes in a bookmark's address. Only `base`'s origin is used.
 */
export function bookmarkletCode(base: string): string {
  const origin = JSON.stringify(new URL(base).origin);
  return `javascript:(()=>{const u=encodeURIComponent(location.href);const t=encodeURIComponent(Array.from(document.title.trim()).slice(0,${TITLE_MAX}).join(""));window.open(${origin}+(u.length>${LONG_ADDRESS}?"${SAVE_PATH}?long=1":"${SAVE_PATH}?url="+u+"&title="+t),"_blank","noopener");})()`;
}
