import type { LinkChecker } from "../core/fetch.js";
import type { Resolve } from "./guarded-lookup.js";
import { createGuardedRequest, discard } from "./guarded-request.js";
import { userAgent } from "./user-agent.js";

export type LinkCheckerOptions = {
  /** The deployed version, named in the User-Agent. */
  version: string;
  /** DNS. Tests inject a fake; the default asks the system resolver. */
  resolve?: Resolve;
  /** The address rule. Tests inject one that also allows a loopback test server. */
  isAllowed?: (ip: string) => boolean;
};

const headersFor = (version: string) => ({
  "user-agent": userAgent(version, "checks that pages its owner saved still exist"),
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
});

/**
 * Checks saved links through the guarded request (`guarded-request.ts`), so checks share the page
 * fetcher's address rules: public addresses only, checked again on every redirect hop, at most 5
 * redirects, and a 15 s deadline. GET, since many servers answer HEAD wrongly. A 2xx body is
 * discarded unread, so a large or endless page is still `ok`. Not `PageFetcher`, which reads up to
 * 5 MB and calls a larger page `too_large`.
 */
export function createLinkChecker(options: LinkCheckerOptions): LinkChecker {
  const requests = createGuardedRequest({
    resolve: options.resolve,
    isAllowed: options.isAllowed,
    maxRedirects: 5,
    deadlineMs: 15_000,
    headers: headersFor(options.version),
  });
  return {
    check: (rawUrl, caller) =>
      requests.fetch(rawUrl, caller, async ({ finalUrl, body }) => {
        discard(body);
        return { kind: "ok", finalUrl } as const;
      }),
    close: requests.close,
  };
}
