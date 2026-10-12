import type { ExtractOutcome, PageMetadata } from "./extract.js";
import type { FetchOutcome } from "./fetch.js";
import type { SnapshotRecord } from "./snapshot-store.js";
import type { SnapshotStatus } from "./types.js";

/** Attempts a snapshot gets, counting the first. */
export const MAX_ATTEMPTS = 6;

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Wait after attempt n (1-based) before attempt n+1: index n-1. */
export const RETRY_DELAYS_MS: readonly number[] = [MIN, 10 * MIN, HOUR, 6 * HOUR, 24 * HOUR];

/**
 * How one attempt ended: a fetch that did not produce a page, or an extraction of a page that did.
 *
 * `aborted` (either stage) maps to a retry that uses up the attempt. The runner decides on its own
 * signal whether a shutdown abort should be released instead, and then does not call this.
 */
export type AttemptOutcome =
  | { stage: "fetch"; fetch: Exclude<FetchOutcome, { kind: "ok" }> }
  | { stage: "extract"; extract: ExtractOutcome };

/** True when no attempts remain; `attempts` is the lease count and may exceed `MAX_ATTEMPTS`. */
export function exhausted(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}

type Verdict =
  | {
      terminal: SnapshotStatus;
      error: string;
      metadata?: PageMetadata | null;
      text?: string | null;
    }
  | { retry: true; error: string };

const terminal = (status: SnapshotStatus, error: string): Verdict => ({ terminal: status, error });
const retry = (error: string): Verdict => ({ retry: true, error });

function judge(outcome: AttemptOutcome): Verdict {
  if (outcome.stage === "extract") {
    const e = outcome.extract;
    switch (e.kind) {
      case "ok":
        return { terminal: "ok", error: "", metadata: e.metadata, text: e.text };
      case "timeout":
        return { ...terminal("extract_timeout", "extract:timeout"), metadata: e.metadata };
      case "out_of_memory":
        return {
          ...terminal("extract_out_of_memory", "extract:out_of_memory"),
          metadata: e.metadata,
        };
      case "crashed":
        return {
          ...terminal("extract_crashed", `extract:crashed:${e.detail}`),
          metadata: e.metadata,
        };
      case "spawn_failed":
        return retry(`extract:spawn_failed:${e.detail}`);
      case "aborted":
        return retry("extract:aborted");
      default: {
        const unreachable: never = e;
        return unreachable;
      }
    }
  }
  const f = outcome.fetch;
  switch (f.kind) {
    case "refused":
      return terminal("refused", `fetch:refused:${f.reason}`);
    case "not_html":
      return terminal("not_html", "fetch:not_html");
    case "too_large":
      return terminal("failed", "fetch:too_large");
    case "http_error": {
      const error = `fetch:http:${f.status}`;
      const transient = f.status >= 500 || f.status === 408 || f.status === 429;
      return transient ? retry(error) : terminal("failed", error);
    }
    case "network_error":
      return retry(`fetch:network:${f.code}`);
    case "timeout":
      return retry("fetch:timeout");
    case "aborted":
      return retry("fetch:aborted");
    default: {
      const unreachable: never = f;
      return unreachable;
    }
  }
}

/**
 * The record to write for a finished attempt. `attempts` is the lease count (this attempt
 * included) and is written back unchanged. A retry that has no attempts left becomes `failed`.
 * Nothing here produces `pending`.
 */
export function snapshotRecord(input: {
  outcome: AttemptOutcome;
  attempts: number;
  now: Date;
}): SnapshotRecord {
  const { outcome, attempts, now } = input;
  const v = judge(outcome);
  const base = { attempts, title: null, description: null, imageUrl: null, text: null };
  if ("retry" in v) {
    const delay = exhausted(attempts) ? undefined : RETRY_DELAYS_MS[attempts - 1];
    return {
      ...base,
      status: delay === undefined ? "failed" : "retrying",
      nextFetchAt: delay === undefined ? null : new Date(now.getTime() + delay),
      fetchedAt: null,
      lastError: v.error,
    };
  }
  return {
    ...base,
    status: v.terminal,
    nextFetchAt: null,
    // A page was fetched in every extract-stage terminal; none is in a fetch-stage one.
    fetchedAt: outcome.stage === "extract" ? now : null,
    title: v.metadata?.title ?? null,
    description: v.metadata?.description ?? null,
    imageUrl: v.metadata?.imageUrl ?? null,
    text: v.text ?? null,
    lastError: v.terminal === "ok" ? null : v.error,
  };
}
