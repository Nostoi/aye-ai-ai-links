/** Why a URL was never requested, or a request was stopped before any page was read. */
export type RefusedReason =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "address"
  | "bad_redirect"
  | "too_many_redirects";

/** Every way a fetch can end. Programmer errors aside, `fetch()` returns one of these and never throws. */
export type FetchOutcome =
  | { kind: "ok"; finalUrl: string; contentType: string; html: string }
  | { kind: "refused"; reason: RefusedReason }
  | { kind: "not_html"; contentType: string }
  | { kind: "http_error"; status: number }
  | { kind: "network_error"; code: string }
  | { kind: "too_large" }
  | { kind: "timeout" }
  /** The caller's signal fired; distinct from `timeout`, which is the fetcher's own deadline. */
  | { kind: "aborted" };

/**
 * Fetches one web page for a snapshot.
 *
 * - Refuses private, loopback and link-local addresses, including after redirects.
 * - Never throws for a network, protocol or content problem; see `FetchOutcome`.
 * - `close()` stops in-flight fetches and releases connections; call it at shutdown.
 */
export interface PageFetcher {
  fetch(url: string, signal?: AbortSignal): Promise<FetchOutcome>;
  close(): Promise<void>;
}
