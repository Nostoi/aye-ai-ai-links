import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopyPass } from "./copy-pass.js";
import type { ExtractOutcome, PageExtractor } from "./extract.js";
import { FakeSavedCopies } from "./fake-saved-copies.js";
import { FakeStore } from "./fake-store.js";
import type { FetchOutcome, ImageFetcher, PageFetcher } from "./fetch.js";
import { RETRY_BASE_MS, RETRY_MAX_MS } from "./image-indexer.js";
import { createCopyKeeper } from "./keep-copy.js";
import type { LinkCheck } from "./link-check-store.js";
import { type CopyDraft, type FolderCheck, MAX_COPY_BYTES } from "./saved-copy.js";
import { at, newLink, record } from "./snapshot-store-contract.js";
import type { ToolRecord } from "./tool-store.js";

const OWNER = "o";
const NONCE = "0".repeat(32);
const draft = (markdown = "# Hi"): CopyDraft => ({ markdown, imageUrls: [], nonce: NONCE });
const META = { title: null, description: null, imageUrl: null };
const okPage = (url: string): FetchOutcome => ({
  kind: "ok",
  finalUrl: url,
  contentType: "text/html",
  html: "<html></html>",
});
const okExtract = (copy?: CopyDraft | null): ExtractOutcome => ({
  kind: "ok",
  metadata: META,
  text: "t",
  ...(copy !== undefined && { copy }),
});
const kept: ToolRecord = {
  status: "kept",
  source: "stated",
  since: at(0),
  answeredAt: null,
  waitDays: 30,
};
const gone: LinkCheck = {
  checkedAt: at(100),
  result: "dead",
  detail: "http:404",
  firstDeadAt: at(100),
  flaggedAt: at(1),
  stillWorksAt: null,
};
const ready: FolderCheck = { state: "ready" };

type Answer<T> = (url: string, signal?: AbortSignal) => Promise<T> | T;

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()));
});

function setup(
  o: {
    limitBytes?: number;
    initialCheck?: FolderCheck;
    page?: Answer<FetchOutcome>;
    extract?: (options: { copy?: boolean } | undefined) => Promise<ExtractOutcome> | ExtractOutcome;
    store?: FakeStore;
    copies?: FakeSavedCopies;
  } = {},
) {
  const store = o.store ?? new FakeStore();
  const copies = o.copies ?? new FakeSavedCopies(store);
  const limitBytes = o.limitBytes ?? 10 * MAX_COPY_BYTES;
  const pageCalls: string[] = [];
  const extractOptions: ({ copy?: boolean } | undefined)[] = [];
  const pages: PageFetcher = {
    fetch: async (url, signal) => {
      pageCalls.push(url);
      return (o.page ?? okPage)(url, signal);
    },
    close: async () => {},
  };
  const extractor: PageExtractor = {
    extract: async (_html, _url, _signal, options) => {
      extractOptions.push(options);
      return (o.extract ?? (() => okExtract(draft())))(options);
    },
    close: async () => {},
  };
  const images: ImageFetcher = {
    fetch: async () => ({ kind: "aborted" }),
    close: async () => {},
  };
  let clock = at(1000).getTime();
  const logged: string[] = [];
  let later = 0;
  const now = () => new Date(clock);
  const pass = createCopyPass({
    copies,
    keeper: createCopyKeeper({ copies, tools: store, limitBytes, now }),
    pages,
    extractor,
    images,
    limitBytes,
    dir: "/saved",
    initialCheck: o.initialCheck ?? ready,
    now,
    log: (message) => logged.push(message),
    onLaterPhases: () => {
      later++;
    },
  });
  running.push(pass);
  return {
    store,
    copies,
    pass,
    pageCalls,
    extractOptions,
    logged,
    now,
    laterRuns: () => later,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Passes the longest backoff. */
    wait: () => {
      clock += RETRY_MAX_MS;
    },
    /** Saves a link whose snapshot has text, so the backfill offers it. */
    async link(n: number) {
      const { link } = await store.insertIfAbsent(OWNER, newLink(n, at(0)));
      const lease = await store.leaseSnapshot(OWNER, link.id, at(1), at(100));
      await store.recordSnapshot(OWNER, link.id, lease?.claim ?? -1, record({ text: "body" }));
      return link.id;
    },
    status: (id: string) => copies.rowStatus(OWNER, id),
    /** Sweeps `n` times, waiting out the backoff before each. */
    async sweeps(n: number) {
      for (let i = 0; i < n; i++) {
        clock += RETRY_MAX_MS;
        await pass.sweep();
      }
    },
  };
}

describe("copy pass backfill", () => {
  it("saves a copy for a candidate, asking the extractor for one", async () => {
    const t = setup();
    const id = await t.link(1);
    await t.pass.sweep();
    expect(t.status(id)).toBe("ok");
    expect(await t.copies.readCopy(OWNER, id)).toMatchObject({ markdown: "# Hi" });
    expect(t.extractOptions).toEqual([{ copy: true }]);
  });

  it("fetches one page per sweep", async () => {
    const t = setup();
    const a = await t.link(1);
    const b = await t.link(2);
    await t.pass.sweep();
    expect(t.pageCalls).toHaveLength(1);
    expect([t.status(a), t.status(b)]).toEqual(["ok", null]);
    await t.pass.sweep();
    expect(t.pageCalls).toHaveLength(2);
    expect([t.status(a), t.status(b)]).toEqual(["ok", "ok"]);
  });

  describe("outcomes", () => {
    it("records none for a page with no article", async () => {
      const t = setup({ extract: () => okExtract(null) });
      const id = await t.link(1);
      await t.pass.sweep();
      expect(t.status(id)).toBe("none");
    });

    it("records none for a 404", async () => {
      const t = setup({ page: () => ({ kind: "http_error", status: 404 }) });
      const id = await t.link(1);
      await t.pass.sweep();
      expect(t.status(id)).toBe("none");
    });

    it("records none for a refused address", async () => {
      const t = setup({ page: () => ({ kind: "refused", reason: "address" }) });
      const id = await t.link(1);
      await t.pass.sweep();
      expect(t.status(id)).toBe("none");
    });

    it("tries a 503 again, and settles failed on the fifth failure with no sixth fetch", async () => {
      const t = setup({ page: () => ({ kind: "http_error", status: 503 }) });
      const id = await t.link(1);
      await t.pass.sweep();
      expect(t.status(id)).toBeNull();
      await t.sweeps(3);
      expect(t.status(id)).toBeNull();
      await t.sweeps(1);
      expect(t.status(id)).toBe("failed");
      await t.sweeps(2);
      expect(t.pageCalls).toHaveLength(5);
    });

    it("does not retry before the backoff has passed", async () => {
      const t = setup({ page: () => ({ kind: "network_error", code: "ECONNRESET" }) });
      await t.link(1);
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(1);
    });

    it.each([
      ["a crashed extraction", { kind: "crashed", metadata: null, detail: "x" } as ExtractOutcome],
      ["a text with no copy key", okExtract()],
    ])("counts %s as a transient failure", async (_name, outcome) => {
      const t = setup({ extract: () => outcome });
      const id = await t.link(1);
      await t.pass.sweep();
      expect(t.status(id)).toBeNull();
      await t.sweeps(4);
      expect(t.status(id)).toBe("failed");
      expect(t.pageCalls).toHaveLength(5);
    });

    it("leaves an aborted extraction as no row and no failure", async () => {
      const t = setup({ extract: () => ({ kind: "aborted" }) });
      const id = await t.link(1);
      await t.sweeps(6);
      expect(t.status(id)).toBeNull();
      expect(t.pageCalls).toHaveLength(6);
    });

    it("does not count a pass abort after the text, whatever the extractor answers", async () => {
      let fetches = 0;
      let stopping: Promise<void> | undefined;
      const t = setup({
        page: (url) => (++fetches <= 4 ? { kind: "http_error", status: 503 } : okPage(url)),
        extract: () => {
          stopping = t.pass.stop();
          return okExtract();
        },
      });
      const id = await t.link(1);
      await t.sweeps(4);
      expect(t.status(id)).toBeNull();
      await t.sweeps(1);
      await stopping;
      expect(t.status(id)).toBeNull();
      expect(t.logged.some((m) => m.includes("attempt 5"))).toBe(false);
    });
  });

  describe("store errors", () => {
    it("counts a thrown write as a failed attempt, settling failed after five", async () => {
      const t = setup();
      vi.spyOn(t.copies, "saveCopy").mockRejectedValue(new Error("EIO"));
      const id = await t.link(1);
      await t.sweeps(4);
      expect(t.status(id)).toBeNull();
      await t.sweeps(1);
      expect(t.status(id)).toBe("failed");
      await t.sweeps(2);
      expect(t.pageCalls).toHaveLength(5);
    });

    it("fetches exactly five times when the final write keeps throwing, then writes failed", async () => {
      const t = setup({ page: () => ({ kind: "http_error", status: 503 }) });
      const id = await t.link(1);
      await t.sweeps(4);
      const write = vi.spyOn(t.copies, "recordNoCopy");
      write.mockRejectedValueOnce(new Error("busy"));
      write.mockRejectedValueOnce(new Error("busy"));
      write.mockRejectedValueOnce(new Error("busy"));
      await t.sweeps(1);
      expect(t.status(id)).toBeNull();
      await t.sweeps(2);
      expect(t.status(id)).toBeNull();
      expect(t.pageCalls).toHaveLength(5);
      await t.sweeps(1);
      expect(t.status(id)).toBe("failed");
      expect(write).toHaveBeenCalledTimes(4);
      expect(t.pageCalls).toHaveLength(5);
    });

    it("keeps a failure budget through a sweep in which the link is not a candidate", async () => {
      const limit = 2 * MAX_COPY_BYTES;
      const t = setup({ limitBytes: limit, page: () => ({ kind: "http_error", status: 503 }) });
      const id = await t.link(1);
      const limits = { copyBytes: MAX_COPY_BYTES, totalBytes: 0 };
      await t.copies.saveCopy(OWNER, id, draft(), limits, at(2));
      expect(t.status(id)).toBe("no_room");
      await t.sweeps(4);
      expect(t.pageCalls).toHaveLength(4);
      vi.spyOn(t.copies, "usedBytes").mockResolvedValueOnce(limit);
      await t.sweeps(1);
      expect(t.pageCalls).toHaveLength(4);
      await t.sweeps(1);
      expect(t.pageCalls).toHaveLength(5);
      expect(t.status(id)).toBe("failed");
    });

    it("does not count a pause mid-attempt, and copies once the folder is back", async () => {
      let fetches = 0;
      const t = setup({
        page: (url) => (++fetches <= 4 ? { kind: "http_error", status: 503 } : okPage(url)),
      });
      const id = await t.link(1);
      await t.sweeps(4);
      vi.spyOn(t.copies, "saveCopy").mockImplementationOnce(async () => {
        t.copies.fail("unwritable");
        throw new Error("EACCES");
      });
      await t.sweeps(1);
      expect(t.status(id)).toBeNull();
      expect(t.logged.filter((m) => m.includes("paused"))).toHaveLength(1);
      await t.sweeps(1);
      expect(t.pageCalls).toHaveLength(5);
      t.copies.heal();
      await t.sweeps(1);
      expect(t.pageCalls).toHaveLength(6);
      expect(t.status(id)).toBe("ok");
    });

    it("does not count saveCopy answering unavailable", async () => {
      const t = setup();
      vi.spyOn(t.copies, "saveCopy").mockResolvedValue("unavailable");
      const id = await t.link(1);
      await t.sweeps(6);
      expect(t.status(id)).toBeNull();
      expect(t.pageCalls).toHaveLength(6);
    });
  });

  describe("who gets no fetch", () => {
    it("records none for a kept tool without fetching it", async () => {
      const t = setup();
      const id = await t.link(1);
      await t.store.updateToolIf(OWNER, id, null, kept);
      await t.pass.sweep();
      expect(t.status(id)).toBe("none");
      expect(t.pageCalls).toHaveLength(0);
    });

    it("moves past a kept tool to the next candidate in the same sweep", async () => {
      const t = setup();
      const a = await t.link(1);
      const b = await t.link(2);
      await t.store.updateToolIf(OWNER, a, null, kept);
      await t.pass.sweep();
      expect([t.status(a), t.status(b)]).toEqual(["none", "ok"]);
      expect(t.pageCalls).toEqual(["https://ex.com/2"]);
    });

    it("never offers a link flagged gone", async () => {
      const t = setup();
      const id = await t.link(1);
      await t.store.updateCheckIf(OWNER, id, null, gone);
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(0);
      expect(t.status(id)).toBeNull();
    });

    it("fetches nothing at limit 0, but still checks the folder every sweep", async () => {
      const t = setup({ limitBytes: 0 });
      const check = vi.spyOn(t.copies, "checkFolder");
      await t.link(1);
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(0);
      expect(check).toHaveBeenCalledTimes(2);
    });
  });

  describe("full, then room again", () => {
    it("records no_room, and a pass with a higher limit retries and saves the link", async () => {
      const store = new FakeStore();
      const copies = new FakeSavedCopies(store);
      const big = "x".repeat(50);
      const t1 = setup({ store, copies, limitBytes: 14, extract: () => okExtract(draft(big)) });
      const a = await t1.link(1);
      const b = await t1.link(2);
      await copies.saveCopy(
        OWNER,
        a,
        draft(),
        { copyBytes: MAX_COPY_BYTES, totalBytes: 100 },
        at(2),
      );
      await t1.pass.sweep();
      expect(copies.rowStatus(OWNER, b)).toBe("no_room");
      await t1.sweeps(2);
      expect(t1.pageCalls).toHaveLength(1);

      const t2 = setup({
        store,
        copies,
        limitBytes: 4 + MAX_COPY_BYTES,
        extract: () => okExtract(draft(big)),
      });
      await t2.pass.sweep();
      expect(copies.rowStatus(OWNER, b)).toBe("ok");
      expect(await copies.readCopy(OWNER, b)).toMatchObject({ markdown: big });
    });
  });

  describe("folder state", () => {
    it("fetches nothing while paused, logs paused once, then resumed once and runs", async () => {
      const t = setup();
      await t.link(1);
      t.copies.fail("unwritable");
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(0);
      expect(t.logged.filter((m) => m.includes("paused"))).toHaveLength(1);
      t.copies.heal();
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.logged.filter((m) => m.includes("resumed"))).toHaveLength(1);
      expect(t.pageCalls).toHaveLength(1);
    });

    it("does not log paused again when the start-up check already found it", async () => {
      const t = setup({ initialCheck: { state: "unwritable", detail: "EACCES" } });
      t.copies.fail("unwritable");
      await t.pass.sweep();
      expect(t.logged.filter((m) => m.includes("paused"))).toHaveLength(0);
    });
  });

  describe("shutdown", () => {
    it("aborts a pending page fetch, writes nothing, and leaves the link a candidate", async () => {
      const t = setup({
        page: (_url, signal) =>
          new Promise<FetchOutcome>((resolve) => {
            signal?.addEventListener("abort", () => resolve({ kind: "aborted" }));
          }),
      });
      const id = await t.link(1);
      const sweeping = t.pass.sweep();
      await vi.waitFor(() => expect(t.pageCalls).toHaveLength(1));
      await t.pass.stop();
      await sweeping;
      expect(t.status(id)).toBeNull();
      expect(await t.copies.backfillCandidates(null, 10, { retryNoRoom: false })).toHaveLength(1);
    });
  });
});

describe("copy pass fix round 1", () => {
  it.each(["usedBytes", "backfillCandidates"] as const)(
    "a throw from %s while the folder breaks pauses the sweep",
    async (method) => {
      const t = setup();
      await t.link(1);
      vi.spyOn(t.copies, method).mockImplementationOnce(async () => {
        t.copies.fail("unwritable");
        throw new Error("EIO");
      });
      await t.pass.sweep();
      expect(t.logged.filter((m) => m.includes("paused"))).toHaveLength(1);
      expect(t.laterRuns()).toBe(0);
      await t.pass.sweep();
      expect(t.logged.filter((m) => m.includes("paused"))).toHaveLength(1);
    },
  );

  it("a throw from usedBytes with the folder still ready ends only the backfill", async () => {
    const t = setup();
    await t.link(1);
    vi.spyOn(t.copies, "usedBytes").mockRejectedValueOnce(new Error("busy"));
    await t.pass.sweep();
    expect(t.logged).toContain("copy pass backfill failed");
    expect(t.logged.some((m) => m.includes("paused"))).toBe(false);
    expect(t.laterRuns()).toBe(1);
  });

  it("a checkFolder that throws in the re-check ends the sweep and changes no logged state", async () => {
    const t = setup();
    await t.link(1);
    vi.spyOn(t.copies, "usedBytes").mockRejectedValueOnce(new Error("busy"));
    const check = vi.spyOn(t.copies, "checkFolder");
    check.mockResolvedValueOnce(ready);
    check.mockRejectedValueOnce(new Error("gone"));
    await t.pass.sweep();
    expect(t.laterRuns()).toBe(0);
    expect(t.logged.some((m) => m.includes("paused") || m.includes("resumed"))).toBe(false);
    expect(t.logged).toContain("copy pass backfill failed");
  });

  it("a settle write that throws does not block the next link's backfill", async () => {
    let fail = true;
    const t = setup({
      page: (url) => (fail ? { kind: "http_error", status: 503 } : okPage(url)),
    });
    const a = await t.link(1);
    await t.sweeps(4);
    vi.spyOn(t.copies, "recordNoCopy").mockRejectedValue(new Error("busy"));
    await t.sweeps(1);
    fail = false;
    const b = await t.link(2);
    await t.sweeps(1);
    expect(t.status(b)).toBe("ok");
    expect(t.status(a)).toBeNull();
  });

  it("a refuse that throws does not block the next link's backfill", async () => {
    const t = setup();
    const a = await t.link(1);
    const b = await t.link(2);
    vi.spyOn(t.store, "getTool").mockRejectedValueOnce(new Error("busy"));
    await t.pass.sweep();
    expect(t.status(a)).toBeNull();
    expect(t.status(b)).toBe("ok");
  });

  it("counts nothing for a store throw after stop", async () => {
    let fetches = 0;
    let stopping: Promise<void> | undefined;
    const t = setup({
      page: (url) => (++fetches <= 4 ? { kind: "http_error", status: 503 } : okPage(url)),
    });
    const id = await t.link(1);
    await t.sweeps(4);
    vi.spyOn(t.copies, "saveCopy").mockImplementationOnce(async () => {
      stopping = t.pass.stop();
      throw new Error("EIO");
    });
    await t.sweeps(1);
    await stopping;
    expect(t.status(id)).toBeNull();
    expect(t.logged.some((m) => m.includes("attempt 5"))).toBe(false);
  });

  it.each([
    ["a 503", { kind: "http_error", status: 503 } as FetchOutcome],
    ["a 404", { kind: "http_error", status: 404 } as FetchOutcome],
  ])("counts nothing for %s answered after stop", async (_n, outcome) => {
    let stopping: Promise<void> | undefined;
    const t = setup({
      page: () => {
        stopping = t.pass.stop();
        return outcome;
      },
    });
    const id = await t.link(1);
    await t.pass.sweep();
    await stopping;
    expect(t.status(id)).toBeNull();
    expect(t.logged.some((m) => m.includes("attempt"))).toBe(false);
  });

  it.each([
    [1, RETRY_BASE_MS],
    [2, RETRY_BASE_MS * 2],
    [3, RETRY_BASE_MS * 4],
  ])("waits RETRY_BASE_MS * 2^(k-1) after attempt %i", async (k, gap) => {
    const t = setup({ page: () => ({ kind: "http_error", status: 503 }) });
    await t.link(1);
    await t.pass.sweep();
    for (let j = 1; j < k; j++) {
      t.advance(RETRY_BASE_MS * 2 ** (j - 1));
      await t.pass.sweep();
    }
    expect(t.pageCalls).toHaveLength(k);
    t.advance(gap - 1);
    await t.pass.sweep();
    expect(t.pageCalls).toHaveLength(k);
    t.advance(1);
    await t.pass.sweep();
    expect(t.pageCalls).toHaveLength(k + 1);
  });

  it("fetches only one page in a sweep even when the write after the fetch throws", async () => {
    const t = setup();
    const a = await t.link(1);
    const b = await t.link(2);
    vi.spyOn(t.copies, "saveCopy").mockRejectedValueOnce(new Error("EIO"));
    await t.pass.sweep();
    expect(t.pageCalls).toEqual(["https://ex.com/1"]);
    expect(t.status(a)).toBeNull();
    expect(t.status(b)).toBeNull();
  });

  it("resets the failure budget when a keep completes", async () => {
    let fail = true;
    const t = setup({
      page: (url) => (fail ? { kind: "http_error", status: 503 } : okPage(url)),
    });
    const id = await t.link(1);
    await t.sweeps(4);
    fail = false;
    vi.spyOn(t.copies, "saveCopy").mockResolvedValueOnce("no_room");
    await t.sweeps(1);
    expect(t.pageCalls).toHaveLength(5);
    fail = true;
    await t.sweeps(1);
    expect(t.pageCalls).toHaveLength(6);
    expect(t.status(id)).toBeNull();
  });
});
