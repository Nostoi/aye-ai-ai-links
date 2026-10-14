import net from "node:net";
import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import type { FetchFailure, RefusedReason } from "../core/fetch.js";
import { isPublicAddress } from "./address-policy.js";
import {
  guardedLookup,
  RefusedAddressError,
  type Resolve,
  systemResolve,
} from "./guarded-lookup.js";
import { BodyTooLargeError } from "./read-body.js";

export type GuardedRequestOptions = {
  /** DNS. Tests inject a fake; the default asks the system resolver. */
  resolve?: Resolve | undefined;
  /** The address rule. Tests inject one that also allows a loopback test server. */
  isAllowed?: ((ip: string) => boolean) | undefined;
  maxRedirects: number;
  /** Overall time one `fetch()` call may take, DNS and body included. */
  deadlineMs: number;
  headers: Record<string, string>;
};

/** A 2xx answer, for the caller to judge and read. */
export type Answer = {
  finalUrl: string;
  contentType: string;
  contentEncoding: string | string[] | undefined;
  body: Readable;
  /** The call's signal: the caller's and the deadline together. Pass it to `readBody`. */
  signal: AbortSignal;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TIMEOUT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT",
]);

const refused = (reason: RefusedReason): FetchFailure => ({ kind: "refused", reason });

const firstValue = (header: string | string[] | undefined) =>
  Array.isArray(header) ? header[0] : header;

/** Run before every request, redirects included. A socket never looks up an IP literal, so the address is checked here. */
function refusalFor(url: URL, isAllowed: (ip: string) => boolean): FetchFailure | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") return refused("scheme");
  if (url.username || url.password) return refused("credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isAllowed(host)) return refused("address");
  return undefined;
}

/** Closes a body unread. undici errors a destroyed body, so the error is swallowed. */
export function discard(body: Readable) {
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
 * GET requests to public addresses only, the one rule set every fetcher of remote content uses.
 *
 * The socket's own lookup is replaced, so the address that passed the check is the one connected
 * to. Redirects are followed by hand so each hop is checked again. `undici.request` is used
 * rather than `fetch` because `fetch` refuses ports on the Fetch standard's blocked list.
 *
 * `fetch` hands a 2xx answer to `read`, which runs inside the same deadline and abort, and whose
 * errors (a `BodyTooLargeError` from `readBody`, a reset connection) map to a `FetchFailure`.
 */
export function createGuardedRequest(options: GuardedRequestOptions) {
  const isAllowed = options.isAllowed ?? isPublicAddress;
  const agent = new Agent({
    connect: { lookup: guardedLookup(options.resolve ?? systemResolve, isAllowed) },
  });

  async function run<T>(
    rawUrl: string,
    signal: AbortSignal,
    read: (answer: Answer) => Promise<T>,
  ): Promise<T | FetchFailure> {
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
        headers: options.headers,
        signal,
      });

      if (REDIRECT_STATUSES.has(res.statusCode)) {
        discard(res.body);
        const location = firstValue(res.headers.location);
        if (!location) return refused("bad_redirect");
        if (hop >= options.maxRedirects) return refused("too_many_redirects");
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
      return read({
        finalUrl: url.href,
        contentType: firstValue(res.headers["content-type"]) ?? "",
        contentEncoding: res.headers["content-encoding"],
        body: res.body,
        signal,
      });
    }
  }

  function outcomeOf(
    err: unknown,
    caller: AbortSignal | undefined,
    deadline: AbortSignal,
  ): FetchFailure {
    if (caller?.aborted) return { kind: "aborted" };
    if (deadline.aborted) return { kind: "timeout" };
    const chain = causes(err);
    if (chain.some((e) => e instanceof BodyTooLargeError)) return { kind: "too_large" };
    if (chain.some((e) => e instanceof RefusedAddressError)) return refused("address");
    const code = codeOf(err);
    if (TIMEOUT_CODES.has(code)) return { kind: "timeout" };
    return { kind: "network_error", code };
  }

  return {
    async fetch<T>(
      rawUrl: string,
      caller: AbortSignal | undefined,
      read: (answer: Answer) => Promise<T>,
    ): Promise<T | FetchFailure> {
      if (caller?.aborted) return { kind: "aborted" };
      const deadline = AbortSignal.timeout(options.deadlineMs);
      const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
      // A lookup that never answers is not cancelled by the signal, so the call settles on abort itself.
      let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([run(rawUrl, signal, read), aborted]);
      } catch (err) {
        return outcomeOf(err, caller, deadline);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    close: () => agent.destroy(),
  };
}
