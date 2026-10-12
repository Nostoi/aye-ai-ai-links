import { describe, expect, it } from "vitest";
import type { ExtractOutcome, PageMetadata } from "./extract.js";
import type { FetchOutcome, RefusedReason } from "./fetch.js";
import {
  type AttemptOutcome,
  exhausted,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  snapshotRecord,
} from "./snapshot-outcome.js";
import type { SnapshotRecord } from "./snapshot-store.js";

const now = new Date("2026-10-11T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const meta: PageMetadata = { title: "T", description: "D", imageUrl: "https://x.test/i.png" };

type FailedFetch = Exclude<FetchOutcome, { kind: "ok" }>;
const fetchOf = (fetch: FailedFetch): AttemptOutcome => ({ stage: "fetch", fetch });
const extractOf = (extract: ExtractOutcome): AttemptOutcome => ({ stage: "extract", extract });
const map = (outcome: AttemptOutcome, attempts = 1): SnapshotRecord =>
  snapshotRecord({ outcome, attempts, now });
const after = (ms: number) => new Date(now.getTime() + ms);

/** The store's rule: pending and retrying need a time; every other status needs none. */
function expectConsistent(r: SnapshotRecord) {
  const open = r.status === "pending" || r.status === "retrying";
  expect(r.nextFetchAt !== null).toBe(open);
}

const refusedReasons: RefusedReason[] = [
  "invalid_url",
  "scheme",
  "credentials",
  "address",
  "bad_redirect",
  "too_many_redirects",
];

// Adding an outcome kind makes one of these switches fail to compile.
function assertAllFetchKinds(o: FetchOutcome): string {
  switch (o.kind) {
    case "ok":
    case "refused":
    case "not_html":
    case "http_error":
    case "network_error":
    case "too_large":
    case "timeout":
    case "aborted":
      return o.kind;
    default: {
      const never: never = o;
      return never;
    }
  }
}
function assertAllExtractKinds(o: ExtractOutcome): string {
  switch (o.kind) {
    case "ok":
    case "timeout":
    case "out_of_memory":
    case "crashed":
    case "spawn_failed":
    case "aborted":
      return o.kind;
    default: {
      const never: never = o;
      return never;
    }
  }
}

describe("retry schedule", () => {
  it("is 1 min, 10 min, 1 h, 6 h, 24 h, and 6 attempts in all", () => {
    expect(RETRY_DELAYS_MS).toEqual([MIN, 10 * MIN, HOUR, 6 * HOUR, 24 * HOUR]);
    expect(MAX_ATTEMPTS).toBe(6);
  });

  it.each([
    [1, MIN],
    [2, 10 * MIN],
    [3, HOUR],
    [4, 6 * HOUR],
    [5, 24 * HOUR],
  ])("attempt %i retries after %i ms", (attempts, delay) => {
    const r = map(fetchOf({ kind: "timeout" }), attempts);
    expect(r).toMatchObject({ status: "retrying", attempts, nextFetchAt: after(delay) });
    expect(exhausted(attempts)).toBe(false);
  });

  it.each([6, 7, 20])("attempt %i fails for good", (attempts) => {
    const r = map(fetchOf({ kind: "timeout" }), attempts);
    expect(r).toMatchObject({ status: "failed", attempts, nextFetchAt: null });
    expect(r.lastError).toBe("fetch:timeout");
    expect(exhausted(attempts)).toBe(true);
  });

  it("exhausted turns true exactly at MAX_ATTEMPTS", () => {
    expect(exhausted(MAX_ATTEMPTS - 1)).toBe(false);
    expect(exhausted(MAX_ATTEMPTS)).toBe(true);
  });
});

describe("snapshotRecord", () => {
  const retryable: [string, AttemptOutcome, string][] = [
    ["timeout", fetchOf({ kind: "timeout" }), "fetch:timeout"],
    [
      "network_error",
      fetchOf({ kind: "network_error", code: "ECONNRESET" }),
      "fetch:network:ECONNRESET",
    ],
    ["http 500", fetchOf({ kind: "http_error", status: 500 }), "fetch:http:500"],
    ["http 503", fetchOf({ kind: "http_error", status: 503 }), "fetch:http:503"],
    ["http 599", fetchOf({ kind: "http_error", status: 599 }), "fetch:http:599"],
    ["http 408", fetchOf({ kind: "http_error", status: 408 }), "fetch:http:408"],
    ["http 429", fetchOf({ kind: "http_error", status: 429 }), "fetch:http:429"],
    ["fetch aborted", fetchOf({ kind: "aborted" }), "fetch:aborted"],
    [
      "extract spawn_failed",
      extractOf({ kind: "spawn_failed", detail: "EAGAIN" }),
      "extract:spawn_failed:EAGAIN",
    ],
    ["extract aborted", extractOf({ kind: "aborted" }), "extract:aborted"],
  ];
  it.each(retryable)("%s retries", (_n, outcome, lastError) => {
    const r = map(outcome, 2);
    expect(r).toEqual({
      status: "retrying",
      attempts: 2,
      nextFetchAt: after(10 * MIN),
      fetchedAt: null,
      title: null,
      description: null,
      imageUrl: null,
      text: null,
      lastError,
    });
    expectConsistent(r);
  });

  const terminal: [string, AttemptOutcome, string, string][] = [
    [
      "not_html",
      fetchOf({ kind: "not_html", contentType: "image/png" }),
      "not_html",
      "fetch:not_html",
    ],
    ["too_large", fetchOf({ kind: "too_large" }), "failed", "fetch:too_large"],
    ["http 404", fetchOf({ kind: "http_error", status: 404 }), "failed", "fetch:http:404"],
    ["http 403", fetchOf({ kind: "http_error", status: 403 }), "failed", "fetch:http:403"],
    ["http 301", fetchOf({ kind: "http_error", status: 301 }), "failed", "fetch:http:301"],
    ...refusedReasons.map((reason): [string, AttemptOutcome, string, string] => [
      `refused ${reason}`,
      fetchOf({ kind: "refused", reason }),
      "refused",
      `fetch:refused:${reason}`,
    ]),
  ];
  it.each(terminal)("%s is terminal", (_n, outcome, status, lastError) => {
    const r = map(outcome, 1);
    expect(r).toEqual({
      status,
      attempts: 1,
      nextFetchAt: null,
      fetchedAt: null,
      title: null,
      description: null,
      imageUrl: null,
      text: null,
      lastError,
    });
    expectConsistent(r);
  });

  it("ok keeps metadata and text, stamps fetchedAt, and has no error", () => {
    const r = map(extractOf({ kind: "ok", metadata: meta, text: "body" }), 3);
    expect(r).toEqual({
      status: "ok",
      attempts: 3,
      nextFetchAt: null,
      fetchedAt: now,
      title: "T",
      description: "D",
      imageUrl: "https://x.test/i.png",
      text: "body",
      lastError: null,
    });
    expectConsistent(r);
  });

  it("ok with no text stores null text", () => {
    expect(map(extractOf({ kind: "ok", metadata: meta, text: null })).text).toBeNull();
  });

  const extractFails: [string, ExtractOutcome, string, string][] = [
    ["timeout", { kind: "timeout", metadata: meta }, "extract_timeout", "extract:timeout"],
    [
      "out_of_memory",
      { kind: "out_of_memory", metadata: meta },
      "extract_out_of_memory",
      "extract:out_of_memory",
    ],
    [
      "crashed",
      { kind: "crashed", metadata: meta, detail: "exit code 1" },
      "extract_crashed",
      "extract:crashed:exit code 1",
    ],
  ];
  it.each(extractFails)(
    "extract %s is terminal and keeps the posted metadata",
    (_n, extract, status, lastError) => {
      const r = map(extractOf(extract), 2);
      expect(r).toEqual({
        status,
        attempts: 2,
        nextFetchAt: null,
        fetchedAt: now,
        title: "T",
        description: "D",
        imageUrl: "https://x.test/i.png",
        text: null,
        lastError,
      });
      expectConsistent(r);
    },
  );

  it.each(extractFails)(
    "extract %s without metadata leaves it null, even on the last attempt",
    (_n, extract, status) => {
      const r = map(extractOf({ ...extract, metadata: null } as ExtractOutcome), 6);
      expect(r).toMatchObject({
        status,
        nextFetchAt: null,
        title: null,
        description: null,
        imageUrl: null,
      });
    },
  );

  it("a retryable outcome past the last attempt fails, and a terminal one is unchanged", () => {
    expect(map(extractOf({ kind: "spawn_failed", detail: "x" }), 6)).toMatchObject({
      status: "failed",
      nextFetchAt: null,
      lastError: "extract:spawn_failed:x",
    });
    expect(map(fetchOf({ kind: "refused", reason: "address" }), 7).status).toBe("refused");
  });

  it("never produces pending", () => {
    for (const [, o] of retryable) expect(map(o, 1).status).not.toBe("pending");
  });

  it("covers every outcome kind (compile-time guard)", () => {
    expect(assertAllFetchKinds({ kind: "aborted" })).toBe("aborted");
    expect(assertAllExtractKinds({ kind: "aborted" })).toBe("aborted");
  });
});
