import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopyPass } from "./copy-pass.js";
import { createCopyReader, createReadGate, type ReadGate } from "./copy-reading.js";
import type { ExtractOutcome, PageExtractor } from "./extract.js";
import { FakeSavedCopies } from "./fake-saved-copies.js";
import { FakeStore } from "./fake-store.js";
import type { FetchOutcome, ImageFetcher, ImageOutcome, PageFetcher } from "./fetch.js";
import { RETRY_BASE_MS, RETRY_MAX_MS } from "./image-indexer.js";
import { createCopyKeeper } from "./keep-copy.js";
import type { LinkCheck } from "./link-check-store.js";
import {
  type CopyDraft,
  copyLimits,
  type FolderCheck,
  imageRef,
  MAX_COPY_BYTES,
} from "./saved-copy.js";
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
const MiB = 1024 * 1024;
const okImage = (contentType: "image/png" | "image/jpeg" = "image/png"): ImageOutcome => ({
  kind: "ok",
  contentType,
  bytes: new Uint8Array([1, 2, 3]),
});
const unreported = { folders: 0, temp: 0, images: 0, unknown: [] as string[] };

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
    image?: Answer<ImageOutcome>;
    sweepEveryMs?: number;
    canResolve?: (signal?: AbortSignal) => Promise<boolean> | boolean;
    extract?: (options: { copy?: boolean } | undefined) => Promise<ExtractOutcome> | ExtractOutcome;
    store?: FakeStore;
    copies?: FakeSavedCopies;
    gate?: ReadGate;
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
  const imageCalls: string[] = [];
  const images: ImageFetcher = {
    fetch: async (url, signal) => {
      imageCalls.push(url);
      return (o.image ?? (() => ({ kind: "aborted" as const })))(url, signal);
    },
    close: async () => {},
  };
  let clock = at(1000).getTime();
  const logged: string[] = [];
  const canResolveCalls: number[] = [];
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
    sweepEveryMs: o.sweepEveryMs,
    gate: o.gate ?? createReadGate(),
    canResolve: async (signal) => {
      canResolveCalls.push(1);
      return (o.canResolve ?? (() => true))(signal);
    },
  });
  running.push(pass);
  return {
    store,
    copies,
    pass,
    pageCalls,
    imageCalls,
    canResolveCalls,
    extractOptions,
    logged,
    now,
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
    /** Saves a copy of a link with these images, none fetched yet. */
    async copyWith(n: number, imageUrls: string[]) {
      const { link } = await store.insertIfAbsent(OWNER, newLink(n, at(0)));
      const markdown = imageUrls
        .map((_, i) => `![a${i + 1}](${imageRef(i + 1, NONCE)})`)
        .join("\n");
      const copy: CopyDraft = { markdown, imageUrls, nonce: NONCE };
      await copies.saveCopy(OWNER, link.id, copy, copyLimits(10 * MAX_COPY_BYTES), at(2));
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

/** A copy with an image to fetch and a copy waiting to be finished: what the later phases act on. */
async function laterWork(t: ReturnType<typeof setup>) {
  const pendingId = await t.copyWith(10, ["https://img/p.png"]);
  const settledId = await t.copyWith(11, ["https://img/s.png"]);
  await t.copies.endCopyImage(OWNER, settledId, 1, "https://img/s.png", "none");
  return {
    pendingId,
    settledId,
    finish: vi.spyOn(t.copies, "finishCopy"),
    orphans: vi.spyOn(t.copies, "sweep"),
  };
}

describe("copy pass fix round 1", () => {
  it.each(["usedBytes", "backfillCandidates"] as const)(
    "a throw from %s while the folder breaks ends the sweep before the later phases",
    async (method) => {
      const t = setup();
      await t.link(1);
      const later = await laterWork(t);
      vi.spyOn(t.copies, method).mockImplementationOnce(async () => {
        t.copies.fail("unwritable");
        throw new Error("EIO");
      });
      await t.pass.sweep();
      expect(t.logged.filter((m) => m.includes("paused"))).toHaveLength(1);
      expect(t.imageCalls).toHaveLength(0);
      expect(later.finish).not.toHaveBeenCalled();
      expect(later.orphans).not.toHaveBeenCalled();
      await t.pass.sweep();
      expect(t.logged.filter((m) => m.includes("paused"))).toHaveLength(1);
    },
  );

  it("a throw from usedBytes with the folder still ready ends only the backfill", async () => {
    const t = setup({ image: () => okImage() });
    await t.link(1);
    const later = await laterWork(t);
    vi.spyOn(t.copies, "usedBytes").mockRejectedValueOnce(new Error("busy"));
    await t.pass.sweep();
    expect(t.logged).toContain("copy pass backfill failed");
    expect(t.logged.some((m) => m.includes("paused"))).toBe(false);
    expect(t.imageCalls).toEqual(["https://img/p.png"]);
    expect(later.finish).toHaveBeenCalled();
    expect(later.orphans).toHaveBeenCalledTimes(1);
  });

  it("a checkFolder that throws in the re-check ends the sweep and changes no logged state", async () => {
    const t = setup();
    await t.link(1);
    const later = await laterWork(t);
    vi.spyOn(t.copies, "usedBytes").mockRejectedValueOnce(new Error("busy"));
    const check = vi.spyOn(t.copies, "checkFolder");
    check.mockResolvedValueOnce(ready);
    check.mockRejectedValueOnce(new Error("gone"));
    await t.pass.sweep();
    expect(t.imageCalls).toHaveLength(0);
    expect(later.finish).not.toHaveBeenCalled();
    expect(later.orphans).not.toHaveBeenCalled();
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

const IMG = (n: number) => `https://img/${n}`;
const ID = (id: string) => JSON.stringify([OWNER, id]);

/** A copy whose images have all ended, so it waits to be finished. */
async function settled(t: ReturnType<typeof setup>, n: number) {
  const id = await t.copyWith(n, [IMG(n)]);
  await t.copies.endCopyImage(OWNER, id, 1, IMG(n), "none");
  return id;
}

async function isFinished(t: ReturnType<typeof setup>, id: string): Promise<boolean> {
  const copy = await t.copies.readCopy(OWNER, id);
  return typeof copy === "object" && copy !== null && copy.finished;
}

const pendingImages = (t: ReturnType<typeof setup>) => t.copies.pendingCopyImages(null, 10);

describe("copy pass images", () => {
  it("saves what it can, ends a 404, and finishes the copy with no nonce left", async () => {
    const t = setup({
      image: (url) =>
        url === IMG(1)
          ? okImage("image/png")
          : url === IMG(2)
            ? okImage("image/jpeg")
            : { kind: "http_error", status: 404 },
    });
    const id = await t.copyWith(1, [IMG(1), IMG(2), IMG(3)]);
    await t.pass.sweep();
    const copy = await t.copies.readCopy(OWNER, id);
    expect(copy).toMatchObject({
      finished: true,
      markdown: "![a1](images/01.png)\n![a2](images/02.jpg)\na3",
    });
    expect([...(copy as { images: Map<number, unknown> }).images.keys()]).toEqual([1, 2]);
    expect(await pendingImages(t)).toEqual([]);
  });

  it("tries a 503 again, ends none on the fifth failure, and fetches no sixth time", async () => {
    const t = setup({ image: () => ({ kind: "http_error", status: 503 }) });
    const id = await t.copyWith(1, [IMG(1)]);
    await t.sweeps(4);
    expect(await pendingImages(t)).toHaveLength(1);
    await t.sweeps(1);
    expect(await pendingImages(t)).toEqual([]);
    await t.sweeps(2);
    expect(t.imageCalls).toHaveLength(5);
    expect(await isFinished(t, id)).toBe(true);
  });

  it("counts a thrown saveCopyImage as an attempt, ending none on the fifth", async () => {
    const t = setup({ image: () => okImage() });
    vi.spyOn(t.copies, "saveCopyImage").mockRejectedValue(new Error("EIO"));
    await t.copyWith(1, [IMG(1)]);
    await t.sweeps(4);
    expect(await pendingImages(t)).toHaveLength(1);
    await t.sweeps(1);
    expect(await pendingImages(t)).toEqual([]);
    await t.sweeps(2);
    expect(t.imageCalls).toHaveLength(5);
  });

  it("fetches exactly five times when the final endCopyImage keeps throwing", async () => {
    const t = setup({ image: () => ({ kind: "http_error", status: 503 }) });
    await t.copyWith(1, [IMG(1)]);
    await t.sweeps(4);
    const end = vi.spyOn(t.copies, "endCopyImage");
    end.mockRejectedValueOnce(new Error("busy"));
    end.mockRejectedValueOnce(new Error("busy"));
    await t.sweeps(3);
    expect(t.imageCalls).toHaveLength(5);
    expect(await pendingImages(t)).toEqual([]);
    expect(end).toHaveBeenCalledTimes(3);
  });

  it("does not stall the phase when a settle write throws with the folder ready", async () => {
    const t = setup({
      image: (url) => (url === IMG(1) ? { kind: "http_error", status: 503 } : okImage()),
    });
    const a = await t.copyWith(1, [IMG(1)]);
    await t.sweeps(4);
    vi.spyOn(t.copies, "endCopyImage").mockRejectedValue(new Error("busy"));
    await t.sweeps(1);
    const b = await t.copyWith(2, [IMG(2)]);
    await t.sweeps(1);
    expect(await pendingImages(t)).toEqual([{ owner: OWNER, linkId: a, n: 1, url: IMG(1) }]);
    expect(await isFinished(t, b)).toBe(true);
  });

  it("leaves an image pending and counts nothing when saveCopyImage answers unavailable", async () => {
    const t = setup({ image: () => okImage() });
    vi.spyOn(t.copies, "saveCopyImage").mockResolvedValue("unavailable");
    await t.copyWith(1, [IMG(1)]);
    await t.sweeps(6);
    expect(t.imageCalls).toHaveLength(6);
    expect(await pendingImages(t)).toHaveLength(1);
    expect(t.logged.some((m) => m.includes("attempt"))).toBe(false);
  });

  it("fetches no image at limit 0, but finishes a copy whose images already settled", async () => {
    const t = setup({ limitBytes: 0, image: () => okImage() });
    const pending = await t.copyWith(1, [IMG(1)]);
    const done = await settled(t, 2);
    await t.pass.sweep();
    expect(t.imageCalls).toHaveLength(0);
    expect(await isFinished(t, done)).toBe(true);
    expect(await isFinished(t, pending)).toBe(false);
  });

  it("ends the sweep paused, counting nothing, when a write throws as the folder breaks", async () => {
    const t = setup({ image: () => okImage() });
    await t.copyWith(1, [IMG(1), IMG(2)]);
    await settled(t, 3);
    const finish = vi.spyOn(t.copies, "finishCopy");
    const orphans = vi.spyOn(t.copies, "sweep");
    vi.spyOn(t.copies, "saveCopyImage").mockImplementationOnce(async () => {
      t.copies.fail("unwritable");
      throw new Error("EACCES");
    });
    await t.pass.sweep();
    expect(t.imageCalls).toEqual([IMG(1)]);
    expect(finish).not.toHaveBeenCalled();
    expect(orphans).not.toHaveBeenCalled();
    expect(t.logged.filter((m) => m.includes("paused"))).toHaveLength(1);
    expect(t.logged.some((m) => m.includes("attempt"))).toBe(false);
  });

  it("writes nothing for an image answered after stop", async () => {
    let stopping: Promise<void> | undefined;
    const t = setup({
      image: () => {
        stopping = t.pass.stop();
        return okImage();
      },
    });
    const save = vi.spyOn(t.copies, "saveCopyImage");
    await t.copyWith(1, [IMG(1)]);
    await t.pass.sweep();
    await stopping;
    expect(save).not.toHaveBeenCalled();
    expect(await pendingImages(t)).toHaveLength(1);
  });

  it("counts nothing for a 503 answered after stop", async () => {
    let stopping: Promise<void> | undefined;
    const t = setup({
      image: () => {
        stopping = t.pass.stop();
        return { kind: "http_error", status: 503 };
      },
    });
    await t.copyWith(1, [IMG(1)]);
    await t.pass.sweep();
    await stopping;
    expect(t.logged.some((m) => m.includes("attempt"))).toBe(false);
  });

  it("aborts a pending image fetch on stop, leaving the image pending", async () => {
    const t = setup({
      image: (_url, signal) =>
        new Promise<ImageOutcome>((resolve) => {
          signal?.addEventListener("abort", () => resolve({ kind: "aborted" }));
        }),
    });
    await t.copyWith(1, [IMG(1)]);
    const sweeping = t.pass.sweep();
    await vi.waitFor(() => expect(t.imageCalls).toHaveLength(1));
    await t.pass.stop();
    await sweeping;
    expect(await pendingImages(t)).toHaveLength(1);
  });

  it.each([
    [1, RETRY_BASE_MS],
    [2, RETRY_BASE_MS * 2],
    [3, RETRY_BASE_MS * 4],
  ])("waits RETRY_BASE_MS * 2^(k-1) after image attempt %i", async (k, gap) => {
    const t = setup({ image: () => ({ kind: "http_error", status: 503 }) });
    await t.copyWith(1, [IMG(1)]);
    await t.pass.sweep();
    for (let j = 1; j < k; j++) {
      t.advance(RETRY_BASE_MS * 2 ** (j - 1));
      await t.pass.sweep();
    }
    expect(t.imageCalls).toHaveLength(k);
    t.advance(gap - 1);
    await t.pass.sweep();
    expect(t.imageCalls).toHaveLength(k);
    t.advance(1);
    await t.pass.sweep();
    expect(t.imageCalls).toHaveLength(k + 1);
  });
});

describe("copy pass finishing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a finishCopy that throws once over three sweeps, retries it, and finishes the others", async () => {
    const t = setup();
    const a = await settled(t, 1);
    const b = await settled(t, 2);
    const real = t.copies.finishCopy.bind(t.copies);
    const finish = vi.spyOn(t.copies, "finishCopy").mockImplementation(async (owner, id, f, at) => {
      if (id === a) throw new Error("EIO");
      return real(owner, id, f, at);
    });
    await t.sweeps(3);
    expect(finish.mock.calls.filter((c) => c[1] === a)).toHaveLength(3);
    expect(t.logged.filter((m) => m.includes("finishing failed"))).toEqual([
      `copy ${ID(a)}: finishing failed`,
    ]);
    expect(await isFinished(t, b)).toBe(true);
  });

  it.each([
    [1, RETRY_BASE_MS],
    [2, RETRY_BASE_MS * 2],
    [3, RETRY_BASE_MS * 4],
  ])("waits RETRY_BASE_MS * 2^(k-1) after finishing failure %i", async (k, gap) => {
    const t = setup();
    await settled(t, 1);
    const finish = vi.spyOn(t.copies, "finishCopy").mockRejectedValue(new Error("EIO"));
    await t.pass.sweep();
    for (let j = 1; j < k; j++) {
      t.advance(RETRY_BASE_MS * 2 ** (j - 1));
      await t.pass.sweep();
    }
    expect(finish).toHaveBeenCalledTimes(k);
    t.advance(gap - 1);
    await t.pass.sweep();
    expect(finish).toHaveBeenCalledTimes(k);
    t.advance(1);
    await t.pass.sweep();
    expect(finish).toHaveBeenCalledTimes(k + 1);
  });

  it("starts no second finish while one that never settles holds the gate, and stop does not wait for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup();
    const a = await settled(t, 1);
    const b = await settled(t, 2);
    const real = t.copies.finishCopy.bind(t.copies);
    let late!: (error: Error) => void;
    let hung = false;
    const finish = vi.spyOn(t.copies, "finishCopy").mockImplementation((owner, id, f, at) => {
      if (id !== a || hung) return real(owner, id, f, at);
      hung = true;
      return new Promise<boolean>((_resolve, reject) => {
        late = reject;
      });
    });
    const sweeping = t.pass.sweep();
    await vi.advanceTimersByTimeAsync(20_000);
    await sweeping;
    expect(finish.mock.calls.map((c) => c[1])).toEqual([a]);
    expect(t.logged).toContain(`copy ${ID(a)}: finishing timed out`);
    expect(t.logged).toContain(`copy ${ID(b)}: finishing timed out`);
    late(new Error("closed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.logged).toContain(`copy ${ID(a)}: the abandoned finish failed`);
    t.wait();
    await t.pass.sweep();
    expect(await isFinished(t, a)).toBe(true);
    expect(await isFinished(t, b)).toBe(true);
    await t.pass.stop();
  });

  it("shares its gate with the copy reader: a stuck finish leaves a view unread and starts no second finish", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = createReadGate();
    const t = setup({ gate });
    await settled(t, 1);
    const viewed = await t.copyWith(5, []);
    const finish = vi
      .spyOn(t.copies, "finishCopy")
      .mockImplementation(() => new Promise<boolean>(() => {}));
    const read = vi.spyOn(t.copies, "readCopy");
    const reader = createCopyReader({ store: t.store, copies: t.copies, gate, log: () => {} });
    const sweeping = t.pass.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(finish).toHaveBeenCalledTimes(1);
    let answer: unknown;
    void reader.view(OWNER, viewed).then((v) => (answer = v?.copy));
    await vi.advanceTimersByTimeAsync(9_999);
    await sweeping;
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toBe("unreadable");
    expect(read).not.toHaveBeenCalled();
    t.wait();
    const again = t.pass.sweep();
    await vi.advanceTimersByTimeAsync(10_000);
    await again;
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("clears the timer when the call wins", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup();
    const a = await settled(t, 1);
    await t.pass.sweep();
    expect(await isFinished(t, a)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets stop resolve while a finishCopy is still pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup();
    await settled(t, 1);
    const finish = vi
      .spyOn(t.copies, "finishCopy")
      .mockImplementation(() => new Promise<boolean>(() => {}));
    const sweeping = t.pass.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(finish).toHaveBeenCalled();
    await t.pass.stop();
    await sweeping;
    expect(t.logged.some((m) => m.includes("timed out"))).toBe(false);
  });

  it("logs nothing for a copy finished between the list and the call", async () => {
    const t = setup();
    await settled(t, 1);
    const finish = vi.spyOn(t.copies, "finishCopy").mockResolvedValue(false);
    await t.pass.sweep();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(t.logged.filter((m) => m.includes("finish"))).toEqual([]);
  });

  it("backs off a copy that finishCopy keeps answering false for, as when its copy.md is gone", async () => {
    const t = setup();
    await settled(t, 1);
    const finish = vi.spyOn(t.copies, "finishCopy").mockResolvedValue(false);
    await t.pass.sweep();
    t.advance(RETRY_BASE_MS - 1);
    await t.pass.sweep();
    expect(finish).toHaveBeenCalledTimes(1);
    t.advance(1);
    await t.pass.sweep();
    expect(finish).toHaveBeenCalledTimes(2);
    expect(t.logged.filter((m) => m.includes("finish"))).toEqual([]);
  });
});

describe("copy pass orphan sweep", () => {
  it("runs on the first sweep, not 15 s later, and again once sweepEveryMs has passed", async () => {
    const t = setup({ sweepEveryMs: 60_000 });
    const orphans = vi.spyOn(t.copies, "sweep");
    await t.pass.sweep();
    expect(orphans).toHaveBeenCalledTimes(1);
    expect(orphans).toHaveBeenCalledWith(60 * 60_000, t.now());
    t.advance(15_000);
    await t.pass.sweep();
    expect(orphans).toHaveBeenCalledTimes(1);
    t.advance(44_999);
    await t.pass.sweep();
    expect(orphans).toHaveBeenCalledTimes(1);
    t.advance(1);
    await t.pass.sweep();
    expect(orphans).toHaveBeenCalledTimes(2);
  });

  it("is not called while paused", async () => {
    const t = setup();
    const orphans = vi.spyOn(t.copies, "sweep");
    t.copies.fail("unwritable");
    await t.pass.sweep();
    expect(orphans).not.toHaveBeenCalled();
  });

  it("logs the counts it removed, and nothing when all are zero", async () => {
    const t = setup({ sweepEveryMs: 1 });
    const orphans = vi.spyOn(t.copies, "sweep");
    orphans.mockResolvedValueOnce(unreported);
    await t.pass.sweep();
    expect(t.logged.filter((m) => m.includes("[saved copies]"))).toEqual([]);
    t.advance(1);
    orphans.mockResolvedValueOnce({ ...unreported, folders: 2, temp: 3, images: 4 });
    await t.pass.sweep();
    expect(t.logged).toContain(
      "[saved copies] removed 2 stray folders, 3 temporary files and 4 stray images",
    );
  });

  it("logs an unknown name reported by two sweeps once, and a new one when it appears", async () => {
    const t = setup({ sweepEveryMs: 1 });
    const orphans = vi.spyOn(t.copies, "sweep");
    orphans.mockResolvedValueOnce({ ...unreported, unknown: ["x.bin"] });
    await t.pass.sweep();
    t.advance(1);
    orphans.mockResolvedValueOnce({ ...unreported, unknown: ["x.bin", "y.bin"] });
    await t.pass.sweep();
    expect(t.logged.filter((m) => m.includes("x.bin"))).toHaveLength(1);
    expect(t.logged.filter((m) => m.includes("y.bin"))).toHaveLength(1);
  });
});

describe("copy pass usage", () => {
  const limit = 200 * MiB;
  const used = (t: ReturnType<typeof setup>, bytes: number) =>
    vi.spyOn(t.copies, "usedBytes").mockResolvedValue(bytes);
  const lines = (t: ReturnType<typeof setup>) => t.logged.filter((m) => m.startsWith("[saved"));
  const FULL =
    "[saved copies] are full, so new links aren't getting one. Raise AYE_SAVED_COPY_LIMIT_GB or remove some copies.";

  it("logs each crossing once", async () => {
    const t = setup({ limitBytes: limit });
    const spy = used(t, 165 * MiB);
    await t.pass.sweep();
    expect(lines(t)).toEqual(["[saved copies] use 0.2 of 0.2 GiB"]);
    await t.pass.sweep();
    spy.mockResolvedValue(170 * MiB);
    await t.pass.sweep();
    expect(lines(t)).toHaveLength(1);
    spy.mockResolvedValue(185 * MiB);
    await t.pass.sweep();
    await t.pass.sweep();
    expect(lines(t)).toEqual(["[saved copies] use 0.2 of 0.2 GiB", FULL]);
    spy.mockResolvedValue(10 * MiB);
    await t.pass.sweep();
    await t.pass.sweep();
    expect(lines(t)).toEqual([
      "[saved copies] use 0.2 of 0.2 GiB",
      FULL,
      "[saved copies] back below 80% of the limit",
    ]);
  });

  it("rounds to one decimal place of a GiB", async () => {
    const t = setup({ limitBytes: 10 * 1024 * MiB });
    used(t, 8.5 * 1024 * MiB);
    await t.pass.sweep();
    expect(lines(t)).toEqual(["[saved copies] use 8.5 of 10.0 GiB"]);
  });

  it("says nothing while use stays low", async () => {
    const t = setup({ limitBytes: limit });
    used(t, 10 * MiB);
    await t.pass.sweep();
    expect(lines(t)).toEqual([]);
  });

  it("skips the phase at limit 0", async () => {
    const t = setup({ limitBytes: 0 });
    const spy = used(t, 10 * MiB);
    await t.pass.sweep();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("copy pass timeout backoff, stop and unavailable paths", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** An image fetch that waits for the abort. */
  const hangingImage = (_url: string, signal?: AbortSignal) =>
    new Promise<ImageOutcome>((resolve) => {
      signal?.addEventListener("abort", () => resolve({ kind: "aborted" }));
    });

  it("does not call a timed-out finishCopy again before its backoff has passed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup();
    await settled(t, 1);
    const finish = vi
      .spyOn(t.copies, "finishCopy")
      .mockImplementation(() => new Promise<boolean>(() => {}));
    const first = t.pass.sweep();
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    t.advance(15_000);
    const second = t.pass.sweep();
    await vi.advanceTimersByTimeAsync(10_000);
    await second;
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("fetches no image after stop during the backfill", async () => {
    let stopping: Promise<void> | undefined;
    const t = setup({
      page: () => {
        stopping = t.pass.stop();
        return { kind: "http_error", status: 503 };
      },
      image: () => okImage(),
    });
    await t.link(1);
    await t.copyWith(10, [IMG(10)]);
    const pending = vi.spyOn(t.copies, "pendingCopyImages");
    await t.pass.sweep();
    await stopping;
    expect(pending).not.toHaveBeenCalled();
    expect(t.imageCalls).toHaveLength(0);
  });

  it("finishes nothing after stop during an image fetch", async () => {
    const t = setup({ image: hangingImage });
    await t.copyWith(1, [IMG(1)]);
    await settled(t, 2);
    const finish = vi.spyOn(t.copies, "finishCopy");
    const unfinished = vi.spyOn(t.copies, "unfinishedCopies");
    const sweeping = t.pass.sweep();
    await vi.waitFor(() => expect(t.imageCalls).toHaveLength(1));
    await t.pass.stop();
    await sweeping;
    expect(unfinished).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("fetches no second image after stop during the first", async () => {
    const t = setup({ image: hangingImage });
    await t.copyWith(1, [IMG(1), IMG(2)]);
    const sweeping = t.pass.sweep();
    await vi.waitFor(() => expect(t.imageCalls).toHaveLength(1));
    await t.pass.stop();
    await sweeping;
    expect(t.imageCalls).toHaveLength(1);
  });

  it("finishes no second copy after stop during the first", async () => {
    const t = setup();
    const a = await settled(t, 1);
    const b = await settled(t, 2);
    const real = t.copies.finishCopy.bind(t.copies);
    let stopping: Promise<void> | undefined;
    const finish = vi.spyOn(t.copies, "finishCopy").mockImplementation((owner, id, f, at) => {
      const done = real(owner, id, f, at);
      // Stop once the call has settled but before the sweep sees it, so the call wins the race.
      if (id === a) void done.then(() => (stopping = t.pass.stop()));
      return done;
    });
    await t.pass.sweep();
    await stopping;
    expect(finish.mock.calls.map((c) => c[1])).toEqual([a]);
    expect(await isFinished(t, b)).toBe(false);
  });

  it("makes no orphan sweep after stop during finishing", async () => {
    const t = setup();
    await settled(t, 1);
    const finish = vi
      .spyOn(t.copies, "finishCopy")
      .mockImplementation(() => new Promise<boolean>(() => {}));
    const orphans = vi.spyOn(t.copies, "sweep");
    const sweeping = t.pass.sweep();
    await vi.waitFor(() => expect(finish).toHaveBeenCalled());
    await t.pass.stop();
    await sweeping;
    expect(orphans).not.toHaveBeenCalled();
  });

  it("reads no usage after stop during the orphan sweep", async () => {
    const t = setup();
    const used = vi.spyOn(t.copies, "usedBytes");
    let stopping: Promise<void> | undefined;
    vi.spyOn(t.copies, "sweep").mockImplementation(async () => {
      stopping = t.pass.stop();
      return unreported;
    });
    await t.pass.sweep();
    await stopping;
    expect(used).toHaveBeenCalledTimes(1);
  });

  it("ends the sweep when saveCopyImage answers unavailable", async () => {
    const t = setup({ image: () => okImage() });
    await t.copyWith(1, [IMG(1), IMG(2)]);
    await settled(t, 3);
    vi.spyOn(t.copies, "saveCopyImage").mockResolvedValue("unavailable");
    const finish = vi.spyOn(t.copies, "finishCopy");
    const orphans = vi.spyOn(t.copies, "sweep");
    await t.pass.sweep();
    expect(t.imageCalls).toEqual([IMG(1)]);
    expect(finish).not.toHaveBeenCalled();
    expect(orphans).not.toHaveBeenCalled();
  });

  it("fetches no image when the backfill finds the folder unavailable", async () => {
    const t = setup({ image: () => okImage() });
    await t.link(1);
    await t.copyWith(10, [IMG(10)]);
    vi.spyOn(t.copies, "saveCopy").mockResolvedValue("unavailable");
    await t.pass.sweep();
    expect(t.pageCalls).toHaveLength(1);
    expect(t.imageCalls).toHaveLength(0);
  });

  it("logs high at exactly 80% of the limit", async () => {
    const t = setup({ limitBytes: 200 * MiB });
    vi.spyOn(t.copies, "usedBytes").mockResolvedValue(160 * MiB);
    await t.pass.sweep();
    expect(t.logged.filter((m) => m.startsWith("[saved"))).toEqual([
      "[saved copies] use 0.2 of 0.2 GiB",
    ]);
  });

  it("is not full with exactly MAX_COPY_BYTES free", async () => {
    const t = setup({ limitBytes: 200 * MiB });
    vi.spyOn(t.copies, "usedBytes").mockResolvedValue(200 * MiB - MAX_COPY_BYTES);
    await t.pass.sweep();
    expect(t.logged.filter((m) => m.startsWith("[saved"))).toEqual([
      "[saved copies] use 0.2 of 0.2 GiB",
    ]);
  });
});

describe("copy pass network outage", () => {
  const down: FetchOutcome = { kind: "network_error", code: "ECONNREFUSED" };
  const slow: FetchOutcome = { kind: "timeout" };
  const urlOf = (n: number) => `https://ex.com/${n}`;

  it("spends no budget while the canary says the network is down", async () => {
    let answer: "down" | "up" = "down";
    const t = setup({
      page: (url) => (answer === "down" ? down : okPage(url)),
      canResolve: () => answer === "up",
    });
    const ids = [await t.link(1), await t.link(2), await t.link(3)];
    await t.sweeps(40);
    expect(ids.map(t.status)).toEqual([null, null, null]);
    answer = "up";
    await t.sweeps(3);
    expect(ids.map(t.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("settles a dead host as failed on its fifth fetch while the network is up", async () => {
    const t = setup({ page: () => slow, canResolve: () => true });
    const id = await t.link(1);
    await t.sweeps(4);
    expect(t.status(id)).toBeNull();
    await t.sweeps(1);
    expect(t.status(id)).toBe("failed");
    await t.sweeps(3);
    expect(t.pageCalls).toHaveLength(5);
  });

  it("saves a healthy link behind four dead hosts at the real 15 s cadence", async () => {
    const t = setup({
      page: (url) => (url === urlOf(5) ? okPage(url) : slow),
      canResolve: () => true,
    });
    const dead = [await t.link(1), await t.link(2), await t.link(3), await t.link(4)];
    const healthy = await t.link(5);
    for (let i = 0; i < 2000; i++) {
      t.advance(15_000);
      await t.pass.sweep();
    }
    expect(t.status(healthy)).toBe("ok");
    expect(dead.map(t.status)).toEqual(["failed", "failed", "failed", "failed"]);
  });

  it("keeps a picture pending while the network is down, then ends it after five counted failures", async () => {
    let up = false;
    const t = setup({ image: () => slow, canResolve: () => up });
    const id = await t.copyWith(1, [IMG(1)]);
    await t.sweeps(40);
    expect(await pendingImages(t)).toHaveLength(1);
    up = true;
    await t.sweeps(4);
    expect(await pendingImages(t)).toHaveLength(1);
    await t.sweeps(1);
    expect(await pendingImages(t)).toEqual([]);
    expect(await isFinished(t, id)).toBe(true);
  });

  it.each([
    ["a 503", { page: (): FetchOutcome => ({ kind: "http_error", status: 503 }) }],
    ["a 404", { page: (): FetchOutcome => ({ kind: "http_error", status: 404 }) }],
    ["a page that is ok", {}],
    ["a refusal", { page: (): FetchOutcome => ({ kind: "refused", reason: "address" }) }],
    [
      "a crashed extraction",
      { extract: () => ({ kind: "crashed", metadata: null, detail: "x" }) as ExtractOutcome },
    ],
  ])("never asks the canary after %s", async (_name, options) => {
    const t = setup(options);
    await t.link(1);
    await t.sweeps(3);
    expect(t.pageCalls.length).toBeGreaterThan(0);
    expect(t.canResolveCalls).toHaveLength(0);
  });

  it("never asks the canary after an image 503", async () => {
    const t = setup({ image: () => ({ kind: "http_error", status: 503 }) });
    await t.copyWith(1, [IMG(1)]);
    await t.sweeps(3);
    expect(t.imageCalls.length).toBeGreaterThan(0);
    expect(t.canResolveCalls).toHaveLength(0);
  });

  it.each([true, false])(
    "counts and writes nothing when stop lands while the canary answers %s",
    async (answer) => {
      const t = setup({
        page: () => down,
        canResolve: (signal) =>
          new Promise<boolean>((resolve) => {
            signal?.addEventListener("abort", () => resolve(answer), { once: true });
          }),
      });
      const id = await t.link(1);
      const swept = t.pass.sweep();
      await vi.waitFor(() => expect(t.canResolveCalls).toHaveLength(1));
      await t.pass.stop();
      await swept;
      expect(t.status(id)).toBeNull();
      expect(t.logged.filter((m) => m.includes("(attempt"))).toEqual([]);
      await t.sweeps(5);
      expect(t.pageCalls).toHaveLength(1);
    },
  );

  it("makes an uncounted failure wait out the base backoff", async () => {
    const t = setup({ page: () => down, canResolve: () => false });
    await t.link(1);
    await t.pass.sweep();
    expect(t.pageCalls).toHaveLength(1);
    t.advance(RETRY_BASE_MS - 1);
    await t.pass.sweep();
    expect(t.pageCalls).toHaveLength(1);
    t.advance(1);
    await t.pass.sweep();
    expect(t.pageCalls).toHaveLength(2);
  });
});
