import { describe, expect, it } from "vitest";
import type { ExtractOutcome, PageMetadata } from "./extract.js";
import type { FetchOutcome, RefusedReason } from "./fetch.js";
import {
  type AttemptOutcome,
  MAX_ATTEMPTS,
  pastLastAttempt,
  pastLastAttemptRecord,
  RETRY_DELAYS_MS,
  snapshotRecord,
} from "./snapshot-outcome.js";
import type { SnapshotRecord } from "./snapshot-store.js";

const now = new Date("2026-10-11T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const meta: PageMetadata = {
  title: "T",
  description: "D",
  imageUrl: "https://x.test/i.png",
  iconUrls: ["https://x.test/a.png", "https://x.test/b.png"],
  faviconUrls: ["https://x.test/a.png", "https://x.test/b.png", "https://x.test/c.png"],
};

type FailedFetch = Exclude<FetchOutcome, { kind: "ok" }>;
const fetchOf = (fetch: FailedFetch): AttemptOutcome => ({ stage: "fetch", fetch });
const extractOf = (extract: ExtractOutcome): AttemptOutcome => ({ stage: "extract", extract });
const PAGE = "https://x.test/page";
const map = (outcome: AttemptOutcome, attempts = 1, url = PAGE): SnapshotRecord =>
  snapshotRecord({ outcome, attempts, now, url });
const after = (ms: number) => new Date(now.getTime() + ms);

/** The store's rule: pending and retrying need a time; every other status needs none. */
function expectConsistent(r: SnapshotRecord) {
  const open = r.status === "pending" || r.status === "retrying";
  expect(r.nextFetchAt !== null).toBe(open);
}

const refusedReasons = Object.keys({
  invalid_url: 0,
  scheme: 0,
  credentials: 0,
  address: 0,
  bad_redirect: 0,
  too_many_redirects: 0,
} satisfies Record<RefusedReason, 0>) as RefusedReason[];

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
  });

  it.each([6, 7, 20])("attempt %i fails for good", (attempts) => {
    const r = map(fetchOf({ kind: "timeout" }), attempts);
    expect(r).toMatchObject({ status: "failed", attempts, nextFetchAt: null });
    expect(r.lastError).toBe("fetch:timeout");
  });

  it("still fetches the last allowed attempt, and skips only beyond it", () => {
    expect(pastLastAttempt(MAX_ATTEMPTS)).toBe(false);
    expect(pastLastAttempt(MAX_ATTEMPTS + 1)).toBe(true);
  });

  it("a lease past the last attempt records failed, final, with its attempts unchanged", () => {
    const r = pastLastAttemptRecord(MAX_ATTEMPTS + 1);
    expect(r).toEqual({
      status: "failed",
      attempts: MAX_ATTEMPTS + 1,
      nextFetchAt: null,
      fetchedAt: null,
      title: null,
      description: null,
      imageUrl: null,
      iconUrls: [],
      // Looked, found nothing (#272): an empty list writes a `none` favicon, so it is not looked for again.
      faviconUrls: [],
      text: null,
      lastError: "lease:expired",
    });
    expectConsistent(r);
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
      iconUrls: [],
      faviconUrls: null,
      text: null,
      lastError,
    });
    expectConsistent(r);
  });

  /** Each terminal fetch outcome: its status, its error and its favicon candidates (#272). */
  const terminal: [string, AttemptOutcome, string, string, string[] | null][] = [
    [
      "not_html",
      fetchOf({ kind: "not_html", finalUrl: "https://x.test/i.png", contentType: "image/png" }),
      "not_html",
      "fetch:not_html",
      ["https://x.test/apple-touch-icon.png", "https://x.test/favicon.ico"],
    ],
    ["too_large", fetchOf({ kind: "too_large" }), "failed", "fetch:too_large", []],
    ["http 404", fetchOf({ kind: "http_error", status: 404 }), "failed", "fetch:http:404", []],
    ["http 403", fetchOf({ kind: "http_error", status: 403 }), "failed", "fetch:http:403", []],
    ["http 301", fetchOf({ kind: "http_error", status: 301 }), "failed", "fetch:http:301", []],
    ...refusedReasons.map((reason): [string, AttemptOutcome, string, string, string[]] => [
      `refused ${reason}`,
      fetchOf({ kind: "refused", reason }),
      "refused",
      `fetch:refused:${reason}`,
      [],
    ]),
  ];
  it.each(terminal)("%s is terminal", (_n, outcome, status, lastError, faviconUrls) => {
    const r = map(outcome, 1);
    expect(r).toEqual({
      status,
      attempts: 1,
      nextFetchAt: null,
      fetchedAt: null,
      title: null,
      description: null,
      imageUrl: null,
      iconUrls: [],
      faviconUrls,
      text: null,
      lastError,
    });
    expectConsistent(r);
  });

  it("★ a link that is not a web page takes the root favicons of its final address, not its saved one (#272)", () => {
    // [Building them from the saved short link, or leaving the favicon unlooked-for.]
    const pdf = fetchOf({
      kind: "not_html",
      finalUrl: "https://files.example:8443/docs/report.pdf?x=1",
      contentType: "application/pdf",
    });
    expect(map(pdf, 1, "https://short.example/abc").faviconUrls).toEqual([
      "https://files.example:8443/apple-touch-icon.png",
      "https://files.example:8443/favicon.ico",
    ]);
  });

  it("★ a fetch that ends with no page records no favicon candidates; a retry leaves them (#272)", () => {
    // [Leaving it null: no favicon row is written, so the link reads as never looked at.]
    for (const fetch of [
      { kind: "refused", reason: "address" },
      { kind: "too_large" },
      { kind: "http_error", status: 404 },
    ] as const) {
      expect(map(fetchOf(fetch)).faviconUrls, fetch.kind).toEqual([]);
    }
    const transient = fetchOf({ kind: "http_error", status: 503 });
    expect(map(transient, MAX_ATTEMPTS - 1)).toMatchObject({
      status: "retrying",
      faviconUrls: null,
    });
    expect(map(transient, MAX_ATTEMPTS)).toMatchObject({ status: "failed", faviconUrls: [] });
    expect(pastLastAttemptRecord(MAX_ATTEMPTS + 1).faviconUrls).toEqual([]);
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
      iconUrls: meta.iconUrls,
      faviconUrls: meta.faviconUrls,
      text: "body",
      lastError: null,
    });
    expectConsistent(r);
  });

  it("★ keeps at most MAX_ICON_URLS icons, and reads a missing list as none (R2)", () => {
    // [Handing the store a record it refuses, which ends a good page as failed.]
    const three = {
      ...meta,
      iconUrls: ["https://x.test/1.png", "https://x.test/2.png", "https://x.test/3.png"],
    };
    expect(map(extractOf({ kind: "ok", metadata: three, text: "b" })).iconUrls).toEqual([
      "https://x.test/1.png",
      "https://x.test/2.png",
    ]);
    const { iconUrls: _, ...old } = meta;
    expect(
      map(extractOf({ kind: "ok", metadata: old as PageMetadata, text: "b" })).iconUrls,
    ).toEqual([]);
  });

  it.each([
    ["a number", 5, []],
    ["an object", {}, []],
    ["a string", "abc", []],
    ["null", null, []],
    ["an array with non-strings", [1, {}, "https://a/x.png"], ["https://a/x.png"]],
  ])("reads iconUrls that is %s without throwing, keeping only string icons", (_n, bad, want) => {
    const metadata = { ...meta, iconUrls: bad } as unknown as PageMetadata;
    expect(map(extractOf({ kind: "ok", metadata, text: "b" })).iconUrls).toEqual(want);
  });

  it.each<[string, ExtractOutcome]>([
    ["ok", { kind: "ok", metadata: meta, text: "body" }],
    ["timeout", { kind: "timeout", metadata: meta }],
    ["crashed", { kind: "crashed", metadata: meta, detail: "SIGSEGV" }],
    ["out_of_memory", { kind: "out_of_memory", metadata: meta }],
  ])(
    "★ %s for a word-picture host keeps no preview, but its icons and the rest (#193)",
    (_n, extract) => {
      // [Recording GitHub's card of words as the preview, so its icon is never fetched.]
      const control = map(extractOf(extract));
      const r = map(extractOf(extract), 1, "https://github.com/Nostoi/aye-ai-ai-links");
      expect(control.imageUrl).toBe("https://x.test/i.png");
      expect(r).toEqual({ ...control, imageUrl: null });
      expect(r.iconUrls).toEqual(meta.iconUrls);
    },
  );

  it("★ keeps at most MAX_FAVICON_URLS favicons, string ones only, apart from the icons (#272)", () => {
    // [Handing the store a record it refuses, or trusting the child's unvalidated list.]
    const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => `https://x.test/f${n}.png`);
    const r = map(extractOf({ kind: "ok", metadata: { ...meta, faviconUrls: seven }, text: "b" }));
    expect(r.faviconUrls).toEqual(seven.slice(0, 6));
    expect(r.iconUrls).toEqual(meta.iconUrls);
    for (const bad of [5, {}, "abc", null, undefined]) {
      const metadata = { ...meta, faviconUrls: bad } as unknown as PageMetadata;
      expect(map(extractOf({ kind: "ok", metadata, text: "b" })).faviconUrls).toEqual([]);
    }
    const mixed = { ...meta, faviconUrls: [1, "https://a/x.png"] } as unknown as PageMetadata;
    expect(map(extractOf({ kind: "ok", metadata: mixed, text: "b" })).faviconUrls).toEqual([
      "https://a/x.png",
    ]);
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
        iconUrls: meta.iconUrls,
        faviconUrls: meta.faviconUrls,
        text: null,
        lastError,
      });
      expectConsistent(r);
    },
  );

  it.each(extractFails)(
    "★ extract %s without metadata keeps the page's fields null and records no favicon candidates (#272)",
    (_n, extract, status) => {
      for (const attempts of [1, 6]) {
        const r = map(extractOf({ ...extract, metadata: null } as ExtractOutcome), attempts);
        expect(r).toMatchObject({
          status,
          nextFetchAt: null,
          title: null,
          description: null,
          imageUrl: null,
          iconUrls: [],
          faviconUrls: [],
        });
      }
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
