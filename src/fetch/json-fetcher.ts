import net from "node:net";
import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import { isPublicAddress } from "./address-policy.js";
import { guardedLookup, type Resolve, systemResolve } from "./guarded-lookup.js";
import { decodersFor, readBody } from "./read-body.js";
import { userAgent } from "./user-agent.js";

export type JsonFetcherLimits = {
  /** Largest body, counted after decompression. */
  maxBytes: number;
  /** Overall time one `fetch()` call may take, DNS and body included. */
  deadlineMs: number;
};

export type JsonFetcherOptions = {
  /** The deployed version, named in the User-Agent. */
  version: string;
  /** DNS. Tests inject a fake; the default asks the system resolver. */
  resolve?: Resolve;
  /** The address rule. Tests inject one that also allows a loopback test server. */
  isAllowed?: (ip: string) => boolean;
  limits?: Partial<JsonFetcherLimits>;
  /** Extra trusted CA certificate. Tests use it for a local HTTPS server; production leaves it unset. */
  ca?: string | Buffer;
};

const DEFAULT_LIMITS: JsonFetcherLimits = { maxBytes: 64 * 1024, deadlineMs: 5_000 };

/** The only caller headers that reach the remote server. Anything else could carry a credential. */
const FORWARDED_REQUEST_HEADERS = ["accept", "if-none-match", "if-modified-since"];

/** The first two are dropped because the body is already decoded; set-cookie because it belongs to the remote site. */
const DROPPED_RESPONSE_HEADERS = new Set(["set-cookie", "content-encoding", "content-length"]);

/** A redirect is returned as itself: its body is not read, and its Location is never requested. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** `new Response` throws if these carry a body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Run before the request. A socket never looks up an IP literal, so the address is checked here. */
function assertAllowedUrl(url: URL, isAllowed: (ip: string) => boolean) {
  if (url.protocol !== "https:") {
    throw new Error(`refused ${url.protocol} URL: only https is allowed`);
  }
  if (url.username || url.password) throw new Error("refused URL with credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isAllowed(host)) throw new Error(`refused address ${host}`);
}

/** Closes a body unread. undici errors a destroyed body, so the error is swallowed. */
function discard(body: Readable) {
  body.on("error", () => {});
  body.destroy();
}

/**
 * A `fetch` for documents a remote party names by URL (OAuth client metadata, key sets). Public
 * addresses only: the socket's own lookup is replaced, so the address that passed the check is the
 * one connected to. Redirects are never followed. `undici.request` is used rather than `fetch` so
 * redirect handling stays ours and no port list filters the request.
 */
export function createJsonFetcher(options: JsonFetcherOptions) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const isAllowed = options.isAllowed ?? isPublicAddress;
  const agent = new Agent({
    allowH2: false,
    connect: { ca: options.ca, lookup: guardedLookup(options.resolve ?? systemResolve, isAllowed) },
  });

  async function run(
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    const res = await request(url, { dispatcher: agent, method: "GET", headers, signal });

    const out = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
    }

    if (NULL_BODY_STATUSES.has(res.statusCode) || REDIRECT_STATUSES.has(res.statusCode)) {
      discard(res.body);
      return new Response(null, { status: res.statusCode, headers: out });
    }
    const encoding = res.headers["content-encoding"];
    const decoders = decodersFor(encoding);
    if (!decoders) {
      discard(res.body);
      throw new Error(`unsupported content-encoding ${String(encoding)}`);
    }
    const bytes = await readBody(res.body, decoders, limits.maxBytes, signal);
    return new Response(new Uint8Array(bytes), { status: res.statusCode, headers: out });
  }

  return {
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(input instanceof Request ? input.url : input);
      assertAllowedUrl(url, isAllowed);

      const source = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
      const headers: Record<string, string> = {
        "user-agent": userAgent(options.version, "fetches OAuth client documents"),
        "accept-encoding": "gzip, deflate, br",
      };
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = source.get(name);
        if (value !== null) headers[name] = value;
      }

      const callerSignals = [init?.signal, input instanceof Request ? input.signal : undefined];
      const signal = AbortSignal.any([
        ...callerSignals.filter((s): s is AbortSignal => !!s),
        AbortSignal.timeout(limits.deadlineMs),
      ]);
      signal.throwIfAborted();
      // A lookup that never answers is not cancelled by the signal, so the call settles on abort itself.
      let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([run(url, headers, signal), aborted]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    close: () => agent.destroy(),
  };
}
