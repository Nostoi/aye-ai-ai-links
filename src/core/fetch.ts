/** Why a URL was never requested, or a request was stopped before any page was read. */
export type RefusedReason =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "address"
  | "bad_redirect"
  | "too_many_redirects";

/** The ways any guarded fetch can end without a usable body, whatever it was fetching. */
export type FetchFailure =
  | { kind: "refused"; reason: RefusedReason }
  | { kind: "http_error"; status: number }
  | { kind: "network_error"; code: string }
  | { kind: "too_large" }
  | { kind: "timeout" }
  /** The caller's signal fired; distinct from `timeout`, which is the fetcher's own deadline. */
  | { kind: "aborted" };

/** Every way a fetch can end. Programmer errors aside, `fetch()` returns one of these and never throws. */
export type FetchOutcome =
  | { kind: "ok"; finalUrl: string; contentType: string; html: string }
  | { kind: "not_html"; contentType: string }
  | FetchFailure;

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

/** The image types kept: the magic bytes decide, never the server's `Content-Type`. */
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Every way an image fetch can end. `too_large` also covers an image whose header declares too
 * many pixels; `not_image` covers a body that is not one of the kept types, or whose header
 * cannot be read.
 */
export type ImageOutcome =
  | { kind: "ok"; contentType: ImageType; bytes: Uint8Array }
  | { kind: "not_image"; contentType: string }
  | FetchFailure;

/** Fetches a link's preview image, under the same address rules as `PageFetcher`. */
export interface ImageFetcher {
  fetch(url: string, signal?: AbortSignal): Promise<ImageOutcome>;
  close(): Promise<void>;
}

/** Every way a link check can end: a 2xx answer after any redirects (its body unread), or a failure. */
export type LinkCheckOutcome = { kind: "ok"; finalUrl: string } | FetchFailure;

/**
 * Checks that a saved link still leads somewhere, under the same address rules as `PageFetcher`.
 * It never reads the page: a 2xx body is discarded. `close()` stops checks in flight.
 */
export interface LinkChecker {
  check(url: string, signal?: AbortSignal): Promise<LinkCheckOutcome>;
  /** Whether the server can resolve a known name right now, asking the DNS servers directly rather than the system's cache. False on any failure, past its deadline, or once `signal` fires. Never throws. */
  canResolve(signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
