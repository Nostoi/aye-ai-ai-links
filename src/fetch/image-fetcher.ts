import type { ImageFetcher } from "../core/fetch.js";
import { checkImage, MAX_IMAGE_BYTES } from "../core/image-type.js";
import type { Resolve } from "./guarded-lookup.js";
import { createGuardedRequest, discard } from "./guarded-request.js";
import { decodersFor, readBody } from "./read-body.js";
import { userAgent } from "./user-agent.js";

export type ImageFetcherOptions = {
  /** The deployed version, named in the User-Agent. */
  version: string;
  /** DNS. Tests inject a fake; the default asks the system resolver. */
  resolve?: Resolve;
  /** The address rule. Tests inject one that also allows a loopback test server. */
  isAllowed?: (ip: string) => boolean;
};

const headersFor = (version: string) => ({
  "user-agent": userAgent(version, "fetches pages its owner saved"),
  accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9",
  "accept-encoding": "gzip, deflate, br",
});

/** Servers label images loosely, so a generic binary type is read too; the bytes decide. */
const READABLE_TYPE =
  /^\s*(image\/[^\s;]+|application\/octet-stream|binary\/octet-stream)\s*(;|$)/i;

/**
 * Fetches preview images and site icons through the guarded request (`guarded-request.ts`), so pages and images
 * share one address rule. The kept type is the one the magic bytes name (PNG, JPEG, GIF or WebP),
 * never the server's; SVG and AVIF are refused.
 */
export function createImageFetcher(options: ImageFetcherOptions): ImageFetcher {
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
        if (!READABLE_TYPE.test(contentType) || !decoders) {
          discard(body);
          return { kind: "not_image", contentType } as const;
        }
        const bytes = await readBody(body, decoders, MAX_IMAGE_BYTES, signal);
        const check = checkImage(bytes);
        if (!check.ok) {
          return check.reason === "too_large"
            ? ({ kind: "too_large" } as const)
            : ({ kind: "not_image", contentType } as const);
        }
        return { kind: "ok", contentType: check.type, bytes: new Uint8Array(bytes) } as const;
      }),
    close: requests.close,
  };
}
