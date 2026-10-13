import net from "node:net";
import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import type { FetchOutcome, PageFetcher, RefusedReason } from "../core/fetch.js";
import { isPublicAddress } from "./address-policy.js";
import { decodeHtml } from "./decode-html.js";
import {
  guardedLookup,
  RefusedAddressError,
  type Resolve,
  systemResolve,
} from "./guarded-lookup.js";
import { BodyTooLargeError, decodersFor, readBody } from "./read-body.js";

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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPE = /^\s*(text\/html|application\/xhtml\+xml)\s*(;|$)/i;
const TIMEOUT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT",
]);

const refused = (reason: RefusedReason): FetchOutcome => ({ kind: "refused", reason });

const firstValue = (header: string | string[] | undefined) =>
  Array.isArray(header) ? header[0] : header;

/** Run before every request, redirects included. A socket never looks up an IP literal, so the address is checked here. */
function refusalFor(url: URL, isAllowed: (ip: string) => boolean): FetchOutcome | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") return refused("scheme");
  if (url.username || url.password) return refused("credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isAllowed(host)) return refused("address");
  return undefined;
}

/** Closes a body unread. undici errors a destroyed body, so the error is swallowed. */
function discard(body: Readable) {
  body.on("error", () => {});
  body.destroy();
}

function causes(err: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let e = err; e && chain.length < 5; e = (e as { cause?: unknown }).cause) chain.push(e);
  return chain;
}

function codeOf(err: unknown): string {
  for (const e of causes(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

/**
 * Fetches pages from public addresses only.
 *
 * The socket's own lookup is replaced, so the address that passed the check is the one connected
 * to. Redirects are followed by hand so each hop is checked again. `undici.request` is used
 * rather than `fetch` because `fetch` refuses ports on the Fetch standard's blocked list.
 */
export function createGuardedFetcher(options: GuardedFetcherOptions = {}): PageFetcher {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const isAllowed = options.isAllowed ?? isPublicAddress;
  const agent = new Agent({
    connect: { lookup: guardedLookup(options.resolve ?? systemResolve, isAllowed) },
  });

  async function run(rawUrl: string, signal: AbortSignal): Promise<FetchOutcome> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return refused("invalid_url");
    }
    for (let hop = 0; ; hop++) {
      const refusal = refusalFor(url, isAllowed);
      if (refusal) return refusal;
      const res = await request(url, {
        dispatcher: agent,
        method: "GET",
        headers: HEADERS,
        signal,
      });

      if (REDIRECT_STATUSES.has(res.statusCode)) {
        discard(res.body);
        const location = firstValue(res.headers.location);
        if (!location) return refused("bad_redirect");
        if (hop >= limits.maxRedirects) return refused("too_many_redirects");
        try {
          url = new URL(location, url);
        } catch {
          return refused("bad_redirect");
        }
        continue;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        discard(res.body);
        return { kind: "http_error", status: res.statusCode };
      }
      const contentType = firstValue(res.headers["content-type"]) ?? "";
      const decoders = decodersFor(res.headers["content-encoding"]);
      if (!HTML_TYPE.test(contentType) || !decoders) {
        discard(res.body);
        return { kind: "not_html", contentType };
      }
      const bytes = await readBody(res.body, decoders, limits.maxBytes, signal);
      return { kind: "ok", finalUrl: url.href, contentType, html: decodeHtml(bytes, contentType) };
    }
  }

  function outcomeOf(err: unknown, caller: AbortSignal | undefined, deadline: AbortSignal) {
    if (caller?.aborted) return { kind: "aborted" } as const;
    if (deadline.aborted) return { kind: "timeout" } as const;
    const chain = causes(err);
    if (chain.some((e) => e instanceof BodyTooLargeError)) return { kind: "too_large" } as const;
    if (chain.some((e) => e instanceof RefusedAddressError)) return refused("address");
    const code = codeOf(err);
    if (TIMEOUT_CODES.has(code)) return { kind: "timeout" } as const;
    return { kind: "network_error", code } as const;
  }

  return {
    async fetch(rawUrl, caller) {
      if (caller?.aborted) return { kind: "aborted" };
      const deadline = AbortSignal.timeout(limits.deadlineMs);
      const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
      // A lookup that never answers is not cancelled by the signal, so the call settles on abort itself.
      let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([run(rawUrl, signal), aborted]);
      } catch (err) {
        return outcomeOf(err, caller, deadline);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    close: () => agent.destroy(),
  };
}
