import { promises as dns } from "node:dns";
import type { LinkChecker } from "../core/fetch.js";
import type { Resolve } from "./guarded-lookup.js";
import { createGuardedRequest, discard } from "./guarded-request.js";
import { userAgent } from "./user-agent.js";

/** A name that is always in the DNS, to tell "this name is gone" from "the server is offline". */
const CANARY_NAME = "example.com";
/** The canary lookup's total time, however many tries the resolver makes. */
const CANARY_DEADLINE_MS = 5_000;

export type CanaryResolver = Pick<dns.Resolver, "resolve4" | "resolve6" | "cancel">;

export type LinkCheckerOptions = {
  /** The deployed version, named in the User-Agent. */
  version: string;
  /** DNS. Tests inject a fake; the default asks the system resolver. */
  resolve?: Resolve;
  /** The address rule. Tests inject one that also allows a loopback test server. */
  isAllowed?: (ip: string) => boolean;
  /** The resolver for `canResolve`, one per probe. Tests inject a fake; the default asks the DNS servers directly. */
  dnsResolver?: () => CanaryResolver;
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
 * 5 MB and calls a larger page `too_large`. `canResolve` asks the DNS servers directly, bypassing the
 * system's lookup cache.
 */
export function createLinkChecker(options: LinkCheckerOptions): LinkChecker {
  const requests = createGuardedRequest({
    resolve: options.resolve,
    isAllowed: options.isAllowed,
    maxRedirects: 5,
    deadlineMs: 15_000,
    headers: headersFor(options.version),
  });
  const newResolver = options.dnsResolver ?? (() => new dns.Resolver({ timeout: 2_000, tries: 2 }));
  return {
    canResolve: (signal) => canResolve(newResolver, signal),
    check: (rawUrl, caller) =>
      requests.fetch(rawUrl, caller, async ({ finalUrl, body }) => {
        discard(body);
        return { kind: "ok", finalUrl } as const;
      }),
    close: requests.close,
  };
}

/** Whether `CANARY_NAME` resolves (IPv4 or IPv6) within the deadline and before `signal` fires. Never throws. */
async function canResolve(
  newResolver: () => CanaryResolver,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const resolver = newResolver();
  let stop = () => {};
  const interrupted = new Promise<false>((resolve) => {
    const end = () => {
      resolver.cancel();
      resolve(false);
    };
    const timer = setTimeout(end, CANARY_DEADLINE_MS);
    signal?.addEventListener("abort", end, { once: true });
    stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", end);
    };
  });
  const answered = Promise.any([
    resolver.resolve4(CANARY_NAME),
    resolver.resolve6(CANARY_NAME),
  ]).then(
    (addresses) => addresses.length > 0,
    () => false,
  );
  try {
    return await Promise.race([answered, interrupted]);
  } finally {
    stop();
  }
}
