import type { ImageFetcher } from "../core/fetch.js";
import { pngFromIco } from "../core/ico.js";
import { checkImage, MAX_IMAGE_BYTES } from "../core/image-type.js";
import { createGuardedRequest, discard } from "./guarded-request.js";
import { type ImageFetcherOptions, READABLE_TYPE } from "./image-fetcher.js";
import { decodersFor, readBody } from "./read-body.js";
import { userAgent } from "./user-agent.js";

const headersFor = (version: string) => ({
  "user-agent": userAgent(version, "fetches pages its owner saved"),
  accept: "image/webp,image/png,image/x-icon,image/vnd.microsoft.icon,image/jpeg,image/gif;q=0.9",
  "accept-encoding": "gzip, deflate, br",
});

/**
 * Fetches site favicons (#272) under the image fetcher's rules: the guarded request, its address
 * rules, redirects and deadline, and the 2 MiB cap on the decoded body. It differs in one way: an
 * ICO file, known by its own header whatever the server's type, yields its largest PNG entry
 * (`pngFromIco`), stored as `image/png`. Every other body is judged as the image fetcher judges
 * it: an image-like type, then `checkImage`. Favicons only: the large picture and saved copies
 * use the image fetcher, which refuses ICO.
 */
export function createFaviconFetcher(options: ImageFetcherOptions): ImageFetcher {
  const requests = createGuardedRequest({
    resolve: options.resolve,
    isAllowed: options.isAllowed,
    maxRedirects: 5,
    deadlineMs: 15_000,
    headers: headersFor(options.version),
  });

  return {
    fetch: (rawUrl, caller) =>
      requests.fetch(rawUrl, caller, async ({ contentType, contentEncoding, body, signal }) => {
        const decoders = decodersFor(contentEncoding);
        if (!decoders) {
          discard(body);
          return { kind: "not_image", contentType } as const;
        }
        // Read whatever the type: servers label an ICO anything from image/x-icon to text/html.
        const read = await readBody(body, decoders, MAX_IMAGE_BYTES, signal);
        const entry = pngFromIco(read);
        if (!entry && !READABLE_TYPE.test(contentType)) {
          return { kind: "not_image", contentType } as const;
        }
        const bytes = entry ?? new Uint8Array(read);
        const check = checkImage(bytes);
        if (!check.ok) {
          return check.reason === "too_large"
            ? ({ kind: "too_large" } as const)
            : ({ kind: "not_image", contentType } as const);
        }
        return { kind: "ok", contentType: check.type, bytes } as const;
      }),
    close: requests.close,
  };
}
