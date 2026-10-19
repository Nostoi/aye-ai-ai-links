import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractOutcome, PageExtractor, PageMetadata } from "./extract.js";
import { FakeStore } from "./fake-store.js";
import type { FetchOutcome, PageFetcher } from "./fetch.js";
import { createIconBackfill, iconsToRecord } from "./icon-backfill.js";
import { MAX_IMAGE_ATTEMPTS, RETRY_MAX_MS } from "./image-indexer.js";
import type { LinkCheck } from "./link-check-store.js";
import { at, newLink, record } from "./snapshot-store-contract.js";

const OWNER = "o";
const ICON = "https://ex.com/icon.png";
const ICON2 = "https://ex.com/icon2.png";
const PREVIEW = "https://ex.com/og.png";
const meta = (over: Partial<PageMetadata> = {}): PageMetadata => ({
  title: "Fresh title",
  description: "Fresh description",
  imageUrl: null,
  iconUrls: [ICON, ICON2],
  ...over,
});
const okExtract = (m: PageMetadata = meta()): ExtractOutcome => ({
  kind: "ok",
  metadata: m,
  text: "fresh",
});
const okPage = (url: string): FetchOutcome => ({
  kind: "ok",
  finalUrl: url,
  contentType: "text/html",
  html: "<html></html>",
});
const gone: LinkCheck = {
  checkedAt: at(100),
  result: "dead",
  detail: "http:404",
  firstDeadAt: at(90),
  flaggedAt: at(100),
  stillWorksAt: null,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Answer<T> = (url: string, signal?: AbortSignal) => Promise<T> | T;

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()));
  vi.restoreAllMocks();
});

function setup(
  o: {
    page?: Answer<FetchOutcome>;
    extract?: (signal?: AbortSignal) => Promise<ExtractOutcome> | ExtractOutcome;
    canResolve?: () => boolean;
    pollMs?: number;
    pageSize?: number;
  } = {},
) {
  const store = new FakeStore();
  const pageCalls: string[] = [];
  const extractOptions: unknown[] = [];
  const pages: PageFetcher = {
    fetch: async (url, signal) => {
      pageCalls.push(url);
      return (o.page ?? okPage)(url, signal);
    },
    close: async () => {},
  };
  const extractor: PageExtractor = {
    extract: async (_html, _url, signal, options) => {
      extractOptions.push(options);
      return (o.extract ?? (() => okExtract()))(signal);
    },
    close: async () => {},
  };
  let clock = at(1000).getTime();
  const logged: string[] = [];
  const now = () => new Date(clock);
  /** A pass over the same store and pipeline, as after a restart. */
  const make = () => {
    const pass = createIconBackfill({
      store,
      pages,
      extractor,
      now,
      log: (message) => logged.push(message),
      canResolve: async () => (o.canResolve ?? (() => true))(),
      ...(o.pollMs !== undefined && { pollMs: o.pollMs }),
      ...(o.pageSize !== undefined && { pageSize: o.pageSize }),
    });
    running.push(pass);
    return pass;
  };
  const pass = make();
  return {
    store,
    pass,
    make,
    pageCalls,
    extractOptions,
    logged,
    /** Passes the longest backoff. */
    wait: () => {
      clock += RETRY_MAX_MS;
    },
    /** A link snapshotted before icons were looked for: ok, no preview, image status NULL. */
    async legacy(n: number) {
      const { link } = await store.insertIfAbsent(OWNER, newLink(n, at(0)));
      const lease = await store.leaseSnapshot(OWNER, link.id, at(1), at(100));
      await store.recordSnapshot(OWNER, link.id, lease?.claim ?? -1, record({ imageUrl: null }));
      store.forgetIconCheck(OWNER, link.id);
      return link.id;
    },
    status: (id: string) => store.imageStatusOf(OWNER, id),
    pending: async () =>
      (await store.pendingImages(null, 100)).map((p) => [p.linkId, p.imageUrl, p.role]),
  };
}

describe("iconsToRecord", () => {
  it("records the page's icons when it names no preview", () => {
    expect(iconsToRecord(meta())).toEqual([ICON, ICON2]);
  });
  it("records none when the page names a preview, or was not read", () => {
    expect(iconsToRecord(meta({ imageUrl: PREVIEW }))).toEqual([]);
    expect(iconsToRecord(null)).toEqual([]);
  });
  it("★ reads the child's list through boundedIconUrls: strings only, at most two (N1)", () => {
    // [Passing the child's unvalidated list to a store that refuses more than two.]
    const bad = { ...meta(), iconUrls: [7, ICON, null, ICON2, "https://ex.com/3.png"] };
    expect(iconsToRecord(bad as unknown as PageMetadata)).toEqual([ICON, ICON2]);
  });
});

describe("icon backfill", () => {
  it("records a legacy link's icons, so the first becomes pending as an icon, asking for no copy", async () => {
    const t = setup();
    const id = await t.legacy(1);
    await t.pass.sweep();
    expect(t.pageCalls).toEqual(["https://ex.com/1"]);
    expect(t.status(id)).toBe("pending");
    expect(await t.pending()).toEqual([[id, ICON, "icon"]]);
    expect(t.extractOptions).toEqual([undefined]);
  });

  it("★ leaves the snapshot's title, description, text and status as they were", async () => {
    // [Re-running the snapshot, or writing the fresh metadata.]
    const t = setup();
    const id = await t.legacy(1);
    await t.pass.sweep();
    expect((await t.store.get(OWNER, id))?.snapshot).toMatchObject({
      status: "ok",
      title: "Page title",
      description: "Page description",
      imageUrl: null,
    });
    expect(await t.store.getSnapshotText(OWNER, id)).toBe("body text");
    expect(t.pageCalls).toHaveLength(1);
  });

  it("★ records none when the fresh page names a usable preview, writing no icon or preview", async () => {
    // [Ignoring the preview.]
    const t = setup({ extract: () => okExtract(meta({ imageUrl: PREVIEW })) });
    const id = await t.legacy(1);
    await t.pass.sweep();
    expect(t.status(id)).toBe("none");
    expect(await t.pending()).toEqual([]);
    expect((await t.store.get(OWNER, id))?.snapshot?.imageUrl).toBeNull();
  });

  it("★ bounds a malformed list from the child before writing (N1)", async () => {
    // [Writing the raw list: the store refuses three, and the link is never recorded.]
    const bad = { ...meta(), iconUrls: [ICON, 5, ICON2, "https://ex.com/3.png"] };
    const t = setup({ extract: () => okExtract(bad as unknown as PageMetadata) });
    const id = await t.legacy(1);
    await t.pass.sweep();
    expect(await t.pending()).toEqual([[id, ICON, "icon"]]);
  });

  it("fetches one page per sweep, in id order", async () => {
    const t = setup();
    await t.legacy(1);
    await t.legacy(2);
    await t.pass.sweep();
    expect(t.pageCalls).toEqual(["https://ex.com/1"]);
    await t.pass.sweep();
    expect(t.pageCalls).toEqual(["https://ex.com/1", "https://ex.com/2"]);
  });

  it("★ never fetches a recorded link again, even from a new pass after a restart", async () => {
    // [Progress kept only in memory.]
    const t = setup();
    await t.legacy(1);
    await t.legacy(2);
    await t.pass.sweep();
    await t.pass.stop();
    await t.make().sweep();
    expect(t.pageCalls).toEqual(["https://ex.com/1", "https://ex.com/2"]);
  });

  describe("outcomes", () => {
    it.each<[string, FetchOutcome]>([
      ["refused", { kind: "refused", reason: "address" }],
      ["not html", { kind: "not_html", contentType: "application/pdf" }],
      ["too large", { kind: "too_large" }],
      ["a 404", { kind: "http_error", status: 404 }],
      ["a 500", { kind: "http_error", status: 500 }],
      ["a 408", { kind: "http_error", status: 408 }],
      ["a 429", { kind: "http_error", status: 429 }],
      ["a timeout with the network up", { kind: "timeout" }],
      ["a network error with the network up", { kind: "network_error", code: "ECONNRESET" }],
    ])("records none for a fetch that ends %s: tried once", async (_name, outcome) => {
      const t = setup({ page: () => outcome });
      const id = await t.legacy(1);
      await t.pass.sweep();
      expect(t.status(id)).toBe("none");
      expect(t.extractOptions).toEqual([]);
    });

    it.each<[string, ExtractOutcome, string]>([
      ["a timeout with metadata", { kind: "timeout", metadata: meta() }, "pending"],
      ["out of memory with metadata", { kind: "out_of_memory", metadata: meta() }, "pending"],
      [
        "a crash with metadata",
        { kind: "crashed", metadata: meta(), detail: "exit code 1" },
        "pending",
      ],
      ["a timeout before metadata", { kind: "timeout", metadata: null }, "none"],
      ["out of memory before metadata", { kind: "out_of_memory", metadata: null }, "none"],
      [
        "a crash before metadata",
        { kind: "crashed", metadata: null, detail: "exit code 1" },
        "none",
      ],
    ])("records from an extraction that ends in %s", async (_name, outcome, want) => {
      const t = setup({ extract: () => outcome });
      const id = await t.legacy(1);
      await t.pass.sweep();
      expect(t.status(id)).toBe(want);
    });

    it("★ records nothing for a network error while the network is down, and moves to the next link", async () => {
      // [Stamping every failure, or a cursor that skips the link for good.]
      let up = false;
      let fail = true;
      const t = setup({
        page: (url) => (fail ? { kind: "network_error", code: "ENOTFOUND" } : okPage(url)),
        canResolve: () => up,
      });
      const a = await t.legacy(1);
      await t.legacy(2);
      await t.pass.sweep();
      expect(t.status(a)).toBeNull();
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/1", "https://ex.com/2"]);
      up = true;
      fail = false;
      t.wait();
      await t.pass.sweep();
      expect(t.pageCalls.at(-1)).toBe("https://ex.com/1");
      expect(t.status(a)).toBe("pending");
    });

    it("★ records nothing for a timeout while the network is down", async () => {
      // [Treating only a network error as a sign the network is down.]
      const t = setup({ page: () => ({ kind: "timeout" }), canResolve: () => false });
      const a = await t.legacy(1);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/1"]);
      expect(t.status(a)).toBeNull();
    });

    it("★ never counts a network that is down as a failure, however many sweeps (R5)", async () => {
      // [Routing 'offline' through the failure path: it logs, and gives up at the cap.]
      let up = false;
      const t = setup({
        page: (url) => (up ? okPage(url) : { kind: "network_error", code: "ENOTFOUND" }),
        canResolve: () => up,
      });
      const a = await t.legacy(1);
      for (let i = 0; i < MAX_IMAGE_ATTEMPTS + 2; i++) {
        await t.pass.sweep();
        t.wait();
      }
      expect(t.pageCalls).toHaveLength(MAX_IMAGE_ATTEMPTS + 2);
      up = true;
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(MAX_IMAGE_ATTEMPTS + 3);
      expect(t.status(a)).toBe("pending");
      expect(t.logged).toEqual([]);
    });

    it("★ reaches the next page of candidates when the first page's link is waiting out a failure", async () => {
      // [Reading only the first page of candidates.]
      const t = setup({
        pageSize: 1,
        page: (url) => (url === "https://ex.com/1" ? { kind: "aborted" } : okPage(url)),
      });
      await t.legacy(1);
      const b = await t.legacy(2);
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/1", "https://ex.com/2"]);
      expect(t.status(b)).toBe("pending");
    });

    it("★ records nothing when the child cannot start, and moves to the next link", async () => {
      // [Recording none for a machine fault, or refetching the same page every sweep.]
      const t = setup({ extract: () => ({ kind: "spawn_failed", detail: "exit code 1" }) });
      const a = await t.legacy(1);
      await t.legacy(2);
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/1", "https://ex.com/2"]);
      expect(t.status(a)).toBeNull();
    });

    it("★ stops trying a link whose child never starts after MAX_IMAGE_ATTEMPTS, writing nothing, until a restart (R3)", async () => {
      // [Retrying forever, or writing 'none' once the budget is spent.]
      const t = setup({ extract: () => ({ kind: "spawn_failed", detail: "exit code 1" }) });
      const a = await t.legacy(1);
      for (let i = 0; i < MAX_IMAGE_ATTEMPTS + 3; i++) {
        await t.pass.sweep();
        t.wait();
      }
      expect(t.pageCalls).toHaveLength(MAX_IMAGE_ATTEMPTS);
      expect(t.status(a)).toBeNull();
      expect(t.logged.filter((l) => l.includes("spawn_failed"))).toHaveLength(MAX_IMAGE_ATTEMPTS);
      await t.pass.stop();
      await t.make().sweep();
      expect(t.pageCalls).toHaveLength(MAX_IMAGE_ATTEMPTS + 1);
    });

    it("★ moves to the next link when the store write throws (R4)", async () => {
      // [An attempt that writes nothing and sets no backoff, so link 1 is fetched every sweep.]
      const t = setup();
      await t.legacy(1);
      const b = await t.legacy(2);
      vi.spyOn(t.store, "recordIconCheck").mockRejectedValueOnce(new Error("disk full"));
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/1", "https://ex.com/2"]);
      expect(t.status(b)).toBe("pending");
      expect(t.logged.some((l) => l.includes("a store call failed"))).toBe(true);
    });

    it("★ moves to the next link when the store refuses the write (R4)", async () => {
      // [Treating a refused write as done while the link is still a candidate.]
      const t = setup();
      await t.legacy(1);
      await t.legacy(2);
      vi.spyOn(t.store, "recordIconCheck").mockResolvedValueOnce(false);
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/1", "https://ex.com/2"]);
    });

    it.each<[string, Parameters<typeof setup>[0]]>([
      ["fetch", { page: () => ({ kind: "aborted" }) }],
      ["extraction", { extract: () => ({ kind: "aborted" }) }],
    ])(
      "★ counts a %s aborted without stop() as a failure and moves on (R4, R3)",
      async (_name, o) => {
        // [Treating every 'aborted' as stop(): no write, no backoff, the same page every sweep.]
        const t = setup(o);
        const a = await t.legacy(1);
        await t.legacy(2);
        await t.pass.sweep();
        await t.pass.sweep();
        expect(t.pageCalls).toEqual(["https://ex.com/1", "https://ex.com/2"]);
        expect(t.status(a)).toBeNull();
      },
    );
  });

  it("★ looks at a link whose dead flag clears while the pass runs, with no restart", async () => {
    // [Stopping the timer after a sweep that found nothing to do.]
    const t = setup({ pollMs: 5 });
    const id = await t.legacy(1);
    await t.store.updateCheckIf(OWNER, id, null, gone);
    t.pass.start();
    await sleep(40);
    expect(t.pageCalls).toEqual([]);
    await t.store.updateCheckIf(OWNER, id, gone, {
      ...gone,
      result: "alive",
      detail: null,
      firstDeadAt: null,
      flaggedAt: null,
    });
    await vi.waitFor(() => expect(t.status(id)).toBe("pending"), { timeout: 1000 });
    expect(t.pageCalls).toEqual(["https://ex.com/1"]);
  });

  it("stop() during the page fetch records nothing", async () => {
    let asked = false;
    const t = setup({
      page: (_url, signal) =>
        new Promise<FetchOutcome>((resolve) => {
          asked = true;
          signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
        }),
    });
    const id = await t.legacy(1);
    const sweep = t.pass.sweep();
    await vi.waitFor(() => expect(asked).toBe(true));
    await t.pass.stop();
    await sweep;
    expect(t.status(id)).toBeNull();
    expect(t.extractOptions).toEqual([]);
    expect(t.logged).toEqual([]);
  });

  it("stop() during the extraction records nothing", async () => {
    let asked = false;
    const t = setup({
      extract: (signal) =>
        new Promise<ExtractOutcome>((resolve) => {
          asked = true;
          signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
        }),
    });
    const id = await t.legacy(1);
    const sweep = t.pass.sweep();
    await vi.waitFor(() => expect(asked).toBe(true));
    await t.pass.stop();
    await sweep;
    expect(t.status(id)).toBeNull();
    expect(t.logged).toEqual([]);
  });
});
