import type { PageFetcher } from "../core/fetch.js";
import { decodeHtml } from "./decode-html.js";
import type { Resolve } from "./guarded-lookup.js";
import { createGuardedRequest, discard } from "./guarded-request.js";
import { decodersFor, readBody } from "./read-body.js";

export type FetcherLimits = {
  /** Largest page, counted after decompression. */
  maxBytes: number;
  maxRedirects: number;
  /** Overall time one `fetch()` call may take, DNS and body included. */
  deadlineMs: number;
};

export type GuardedFetcherOptions = {
  /** DNS. Tests inject a fake; the default asks the system resolver. */
  resolve?: Resolve;
  /** The address rule. Tests inject one that also allows a loopback test server. */
  isAllowed?: (ip: string) => boolean;
  limits?: Partial<FetcherLimits>;
};

const DEFAULT_LIMITS: FetcherLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  deadlineMs: 15_000,
};

const HEADERS = {
  "user-agent": "aye-ai-ai-links/0.1 (personal link library; fetches pages its owner saved)",
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  "accept-encoding": "gzip, deflate, br",
};

const HTML_TYPE = /^\s*(text\/html|application\/xhtml\+xml)\s*(;|$)/i;

/** Fetches pages from public addresses only, through the guarded request (`guarded-request.ts`). */
export function createGuardedFetcher(options: GuardedFetcherOptions = {}): PageFetcher {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const requests = createGuardedRequest({
    resolve: options.resolve,
    isAllowed: options.isAllowed,
    maxRedirects: limits.maxRedirects,
    deadlineMs: limits.deadlineMs,
    headers: HEADERS,
  });

  return {
    fetch: (rawUrl, caller) =>
      requests.fetch(
        rawUrl,
        caller,
        async ({ finalUrl, contentType, contentEncoding, body, signal }) => {
          const decoders = decodersFor(contentEncoding);
          if (!HTML_TYPE.test(contentType) || !decoders) {
            discard(body);
            return { kind: "not_html", contentType } as const;
          }
          const bytes = await readBody(body, decoders, limits.maxBytes, signal);
          return {
            kind: "ok",
            finalUrl,
            contentType,
            html: decodeHtml(bytes, contentType),
          } as const;
        },
      ),
    close: requests.close,
  };
}
