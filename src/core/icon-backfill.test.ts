import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractOutcome, PageExtractor, PageMetadata } from "./extract.js";
import { FakeStore } from "./fake-store.js";
import { FAVICON_DISCOVERY_VERSION } from "./favicon-store.js";
import type { FetchOutcome, PageFetcher } from "./fetch.js";
import { createIconBackfill, iconsToRecord } from "./icon-backfill.js";
import { createImageIndexer, MAX_IMAGE_ATTEMPTS, RETRY_MAX_MS } from "./image-indexer.js";
import { png } from "./image-test-kit.js";
import type { LinkCheck } from "./link-check-store.js";
import type { SnapshotRecord } from "./snapshot-store.js";
import { at, newLink, record } from "./snapshot-store-contract.js";

const OWNER = "o";
const ICON = "https://ex.com/icon.png";
const ICON2 = "https://ex.com/icon2.png";
const PREVIEW = "https://ex.com/og.png";
const GITHUB = "https://github.com/Nostoi/aye-ai-ai-links";
/** GitHub's two usable-type icons, as the extraction ranks them: its 32 px PNG, then fluid-icon. */
const FAVICON = "https://github.githubassets.com/favicons/favicon.png";
const FAV = "https://ex.com/fav.png";
const FLUID = "https://github.com/fluidicon.png";
const meta = (over: Partial<PageMetadata> = {}): PageMetadata => ({
  title: "Fresh title",
  description: "Fresh description",
  imageUrl: null,
  iconUrls: [ICON, ICON2],
  faviconUrls: [],
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
    async legacy(n: number, over: Partial<SnapshotRecord> = {}) {
      const { link } = await store.insertIfAbsent(OWNER, newLink(n, at(0)));
      const lease = await store.leaseSnapshot(OWNER, link.id, at(1), at(100));
      await store.recordSnapshot(
        OWNER,
        link.id,
        lease?.claim ?? -1,
        record({ imageUrl: null, ...over }),
      );
      store.forgetIconCheck(OWNER, link.id);
      return link.id;
    },
    /** A link snapshotted before favicons: terminal, looked at for icons, with no favicon row. */
    async noFavicon(n: number, over: Partial<SnapshotRecord> = {}) {
      const { link } = await store.insertIfAbsent(OWNER, newLink(n, at(0)));
      const lease = await store.leaseSnapshot(OWNER, link.id, at(1), at(100));
      const r = record({ imageUrl: null, ...over });
      await store.recordSnapshot(OWNER, link.id, lease?.claim ?? -1, r);
      return link.id;
    },
    status: (id: string) => store.imageStatusOf(OWNER, id),
    pending: async () =>
      (await store.pendingImages(null, 100)).map((p) => [p.linkId, p.imageUrl, p.role]),
  };
}

describe("iconsToRecord", () => {
  const PAGE = "https://ex.com/1";
  it("records the page's icons when it names no preview", () => {
    expect(iconsToRecord(PAGE, meta())).toEqual([ICON, ICON2]);
  });
  it("records none when the page names a preview, or was not read", () => {
    expect(iconsToRecord(PAGE, meta({ imageUrl: PREVIEW }))).toEqual([]);
    expect(iconsToRecord(PAGE, null)).toEqual([]);
  });
  it("★ records a word-picture host's icons even when its page names a preview (#193)", () => {
    // [Asking only whether the page named a preview, so an older GitHub link records none.]
    expect(iconsToRecord(GITHUB, meta({ imageUrl: PREVIEW }))).toEqual([ICON, ICON2]);
  });
  it("★ reads the child's list through boundedIconUrls: strings only, at most two (N1)", () => {
    // [Passing the child's unvalidated list to a store that refuses more than two.]
    const bad = { ...meta(), iconUrls: [7, ICON, null, ICON2, "https://ex.com/3.png"] };
    expect(iconsToRecord(PAGE, bad as unknown as PageMetadata)).toEqual([ICON, ICON2]);
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
      [
        "not html",
        { kind: "not_html", finalUrl: "https://ex.com/1", contentType: "application/pdf" },
      ],
      ["too large", { kind: "too_large" }],
      ["a 404", { kind: "http_error", status: 404, finalUrl: "https://ex.com/gone" }],
      ["a 500", { kind: "http_error", status: 500, finalUrl: "https://ex.com/gone" }],
      ["a 408", { kind: "http_error", status: 408, finalUrl: "https://ex.com/gone" }],
      ["a 429", { kind: "http_error", status: 429, finalUrl: "https://ex.com/gone" }],
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
      const a = await t.legacy(1, { faviconUrls: [FAV] });
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
    const id = await t.legacy(1, { faviconUrls: [FAV] });
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

  it("survives its link being purged mid-fetch, and still handles the next link", async () => {
    let doomed = "";
    let doomedUrl = "";
    const t: ReturnType<typeof setup> = setup({
      page: async (url) => {
        if (url === doomedUrl) {
          await t.store.markDeleted(OWNER, doomed, at(0));
          await t.store.purgeDeleted(at(1));
        }
        return okPage(url);
      },
    });
    doomed = await t.legacy(1);
    doomedUrl = (await t.store.get(OWNER, doomed))?.url ?? "";
    const next = await t.legacy(2);
    expect(doomedUrl).not.toBe("");

    await expect(t.pass.sweep()).resolves.toBeUndefined();
    t.wait();
    await expect(t.pass.sweep()).resolves.toBeUndefined();

    expect(t.pageCalls.filter((u) => u === doomedUrl)).toHaveLength(1);
    expect(t.status(next)).not.toBeNull();
    expect(t.status(doomed)).toBeNull();
    expect(t.logged.length).toBeLessThanOrEqual(1);
  });

  describe("the word-picture check (#193)", () => {
    /** The fresh page: GitHub's card of words as the preview, and both its icons. */
    const githubPage = () => okExtract(meta({ imageUrl: PREVIEW, iconUrls: [FAVICON, FLUID] }));
    const PNG = { contentType: "image/png" as const, bytes: new Uint8Array(png(1200, 600)) };

    /** A link saved at `url` before #193, its preview fetched and its old icons recorded. */
    async function withPreview(
      t: ReturnType<typeof setup>,
      n: number,
      url: string,
      over: Partial<SnapshotRecord> = {},
    ) {
      const { link } = await t.store.insertIfAbsent(OWNER, {
        ...newLink(n, at(0)),
        url,
        urlKey: url.replace(/^https:\/\//, ""),
      });
      const lease = await t.store.leaseSnapshot(OWNER, link.id, at(1), at(100));
      const r = record({ imageUrl: PREVIEW, iconUrls: [FAVICON], ...over });
      expect(await t.store.recordSnapshot(OWNER, link.id, lease?.claim ?? -1, r)).toBe(true);
      expect(await t.store.writeImage(OWNER, link.id, PREVIEW, "preview", PNG)).toBe(true);
      return link.id;
    }

    it("★ reads the page afresh, so a stale 32 px candidate gives way to fluid-icon (finding 1)", async () => {
      // [Reusing the snapshot's old candidates: the favicon fails the floor, and the link has no picture.]
      const t = setup({ extract: githubPage });
      const id = await withPreview(t, 1, GITHUB);
      const before = (await t.store.get(OWNER, id))?.snapshot;
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([GITHUB]);
      expect((await t.store.get(OWNER, id))?.snapshot).toEqual({ ...before, imageUrl: null });
      expect(await t.store.getSnapshotText(OWNER, id)).toBe("body text");
      expect(await t.store.image(OWNER, id, "page")).toBeNull();

      const sizes: Record<string, Buffer> = { [FAVICON]: png(32, 32), [FLUID]: png(512, 512) };
      const indexer = createImageIndexer({
        store: t.store,
        fetcher: {
          fetch: async (url) => ({
            kind: "ok",
            contentType: "image/png",
            bytes: new Uint8Array(sizes[url] ?? png(1, 1)),
          }),
          close: async () => {},
        },
        now: () => at(2000),
      });
      await indexer.sweep();
      await indexer.sweep();
      await indexer.stop();
      expect((await t.store.imageVersions(OWNER, [id])).get(id)?.fit).toBe("contain");
      expect(await t.store.image(OWNER, id, "page")).toMatchObject({ role: "icon" });
      expect(await t.store.wordPictureCandidates(null, 100)).toEqual([]);
    });

    it("★ rewrites the favicon candidates from the page it read afresh, in the same write (#272)", async () => {
      // [Leaving the snapshot's old favicon pending, so a fetch of it lands after the page moved on.]
      const fresh = ["https://ex.com/fresh-32.png", "https://ex.com/fresh-16.png"];
      const t = setup({
        extract: () =>
          okExtract(meta({ imageUrl: PREVIEW, iconUrls: [FLUID], faviconUrls: fresh })),
      });
      const id = await withPreview(t, 1, GITHUB, { faviconUrls: [FAVICON] });
      expect(t.store.faviconRow(OWNER, id)).toMatchObject({ candidates: [FAVICON], generation: 1 });
      await t.pass.sweep();
      expect(t.store.faviconRow(OWNER, id)).toEqual({
        candidates: fresh,
        status: "pending",
        generation: 2,
        discovery: FAVICON_DISCOVERY_VERSION,
        stored: false,
      });
    });

    it("★ leaves the favicon as it was when the page could not be read (#272)", async () => {
      // [Rewriting it from a failed read, which ends a good favicon as none.]
      const t = setup({
        page: () => ({ kind: "http_error", status: 404, finalUrl: "https://ex.com/gone" }),
      });
      const id = await withPreview(t, 1, GITHUB, { faviconUrls: [FAVICON] });
      const before = t.store.faviconRow(OWNER, id);
      await t.pass.sweep();
      expect((await t.store.get(OWNER, id))?.snapshot?.imageUrl).toBeNull();
      expect(t.store.faviconRow(OWNER, id)).toEqual(before);
    });

    it.each(["extract_timeout", "extract_crashed", "extract_out_of_memory"] as const)(
      "★ swaps the preview of a %s snapshot, keeping its status and title (finding 2)",
      async (status) => {
        // [Swapping only ok snapshots, so these keep the card of words for good.]
        const t = setup({ extract: githubPage });
        const id = await withPreview(t, 1, GITHUB, {
          status,
          iconUrls: [],
          text: null,
          lastError: "extract:x",
        });
        await t.pass.sweep();
        const snap = (await t.store.get(OWNER, id))?.snapshot;
        expect(snap).toMatchObject({ status, title: "Page title", imageUrl: null });
        expect(await t.pending()).toEqual([[id, FAVICON, "icon"]]);
        expect(await t.store.dueSnapshots(at(10_000), 10)).toEqual([]);
      },
    );

    it("★ reconciles a link deleted during a sweep once its delete is undone, with no restart (finding 3)", async () => {
      // [A check that runs once at start: the restored link keeps its card of words.]
      const t = setup({ extract: githubPage });
      const id = await withPreview(t, 1, GITHUB);
      expect(await t.store.markDeleted(OWNER, id, at(50))).toBe(true);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([]);
      expect(await t.store.unmarkDeleted(OWNER, id, at(50))).toBe(true);
      expect(await t.store.image(OWNER, id, "page")).toMatchObject({ role: "preview" });
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([GITHUB]);
      expect(await t.store.image(OWNER, id, "page")).toBeNull();
      expect(await t.pending()).toEqual([[id, FAVICON, "icon"]]);
    });

    it("★ recovers from a store write that throws, in the same process (finding 4)", async () => {
      // [Giving up on the link after one failure.]
      const t = setup({ extract: githubPage });
      const id = await withPreview(t, 1, GITHUB, { faviconUrls: [FAVICON] });
      vi.spyOn(t.store, "recordWordPictureCheck").mockRejectedValueOnce(new Error("disk full"));
      await t.pass.sweep();
      expect(t.logged.some((l) => l.includes("a store call failed"))).toBe(true);
      expect(await t.store.image(OWNER, id, "page")).toMatchObject({ role: "preview" });
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([GITHUB]);
      t.wait();
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([GITHUB, GITHUB]);
      expect(await t.store.image(OWNER, id, "page")).toBeNull();
      expect(await t.pending()).toEqual([[id, FAVICON, "icon"]]);
    });

    it("★ never reads an ordinary page that names a preview, and leaves it as it was", async () => {
      // [Swapping every preview, not only a word-picture host's.]
      const t = setup({ extract: githubPage });
      const id = await withPreview(t, 1, "https://example.com/article", {
        faviconUrls: [FAVICON],
      });
      const before = await t.store.get(OWNER, id);
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([]);
      expect(await t.store.get(OWNER, id)).toEqual(before);
      expect(await t.store.image(OWNER, id, "page")).toMatchObject({ role: "preview" });
    });

    it("★ reads a word-picture link once, one page per sweep: the next sweep goes on to the icon candidates", async () => {
      const t = setup({ extract: githubPage });
      await withPreview(t, 1, GITHUB);
      await t.legacy(2);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([GITHUB]);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([GITHUB, "https://ex.com/2"]);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([GITHUB, "https://ex.com/2"]);
    });

    it.each<[string, FetchOutcome]>([
      ["a 503", { kind: "http_error", status: 503, finalUrl: "https://ex.com/gone" }],
      ["a 429", { kind: "http_error", status: 429, finalUrl: "https://ex.com/gone" }],
      ["a 408", { kind: "http_error", status: 408, finalUrl: "https://ex.com/gone" }],
      ["a timeout with the network up", { kind: "timeout" }],
      ["a network error with the network up", { kind: "network_error", code: "ECONNRESET" }],
    ])(
      "★ keeps the preview when the read fails with %s, and reads the page again later",
      async (_n, outcome) => {
        let fail = true;
        const t = setup({ page: (url) => (fail ? outcome : okPage(url)), extract: githubPage });
        const id = await withPreview(t, 1, GITHUB);
        const before = await t.store.get(OWNER, id);
        await t.pass.sweep();
        expect(await t.store.get(OWNER, id)).toEqual(before);
        expect(await t.store.image(OWNER, id, "page")).toMatchObject({ role: "preview" });
        expect(t.status(id)).toBe("ok");
        fail = false;
        t.wait();
        await t.pass.sweep();
        expect(t.pageCalls).toEqual([GITHUB, GITHUB]);
        expect(await t.pending()).toEqual([[id, FAVICON, "icon"]]);
      },
    );

    const beforeMetadata: [string, ExtractOutcome][] = [
      ["a timeout", { kind: "timeout", metadata: null }],
      ["a crash", { kind: "crashed", metadata: null, detail: "exit code 1" }],
      ["out of memory", { kind: "out_of_memory", metadata: null }],
    ];

    it.each(beforeMetadata)(
      "★ keeps the preview when the extraction ends in %s before metadata, and reads the page again later",
      async (_n, outcome) => {
        let fail = true;
        const t = setup({ extract: () => (fail ? outcome : githubPage()) });
        const id = await withPreview(t, 1, GITHUB);
        const before = await t.store.get(OWNER, id);
        await t.pass.sweep();
        expect(await t.store.get(OWNER, id)).toEqual(before);
        expect(await t.store.image(OWNER, id, "page")).toMatchObject({ role: "preview" });
        expect(t.status(id)).toBe("ok");
        fail = false;
        t.wait();
        await t.pass.sweep();
        expect(t.pageCalls).toEqual([GITHUB, GITHUB]);
        expect(await t.pending()).toEqual([[id, FAVICON, "icon"]]);
      },
    );

    it.each(beforeMetadata)(
      "an icon-check link whose extraction ends in %s before metadata still records none at once",
      async (_n, outcome) => {
        const t = setup({ extract: () => outcome });
        const id = await t.legacy(1);
        await t.pass.sweep();
        expect(t.status(id)).toBe("none");
        expect(t.pageCalls).toEqual(["https://ex.com/1"]);
      },
    );

    it.each<[string, FetchOutcome]>([
      ["a 404", { kind: "http_error", status: 404, finalUrl: "https://ex.com/gone" }],
      ["refused", { kind: "refused", reason: "address" }],
    ])(
      "★ ends at initials when the page read fails with %s, never at the old preview",
      async (_n, outcome) => {
        // [Leaving the preview when the fresh read fails.]
        const t = setup({ page: () => outcome });
        const id = await withPreview(t, 1, GITHUB);
        await t.pass.sweep();
        expect(t.status(id)).toBe("none");
        expect(await t.store.imageVersions(OWNER, [id])).toEqual(new Map());
        expect((await t.store.get(OWNER, id))?.snapshot?.imageUrl).toBeNull();
      },
    );

    it("★ reads a word-picture link even while it is flagged gone", async () => {
      // [Copying the icon candidates' dead-flag rule, so a dead GitHub link keeps its preview.]
      const t = setup({
        page: () => ({ kind: "http_error", status: 404, finalUrl: "https://ex.com/gone" }),
      });
      const id = await withPreview(t, 1, GITHUB);
      await t.store.updateCheckIf(OWNER, id, null, gone);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([GITHUB]);
      expect(t.status(id)).toBe("none");
    });
  });

  describe("the favicon check (#272)", () => {
    const GONE = "https://destination.example/blocked";
    const ROOT = ["https://ex.com/apple-touch-icon.png", "https://ex.com/favicon.ico"];
    const GONE_ROOT = [
      "https://destination.example/apple-touch-icon.png",
      "https://destination.example/favicon.ico",
    ];
    const withFavicon = () => okExtract(meta({ faviconUrls: [FAV] }));
    const rowOf = (t: ReturnType<typeof setup>, id: string) => t.store.faviconRow(OWNER, id);
    const http = (status: number, finalUrl = GONE): FetchOutcome => ({
      kind: "http_error",
      status,
      finalUrl,
    });

    it("★ gives a link snapshotted before favicons its page's candidates, from one page read", async () => {
      // [No third kind: such a link never gets a favicon row from the snapshot path.]
      const t = setup({ extract: withFavicon });
      const id = await t.noFavicon(1);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/1"]);
      expect(rowOf(t, id)).toEqual({
        candidates: [FAV],
        status: "pending",
        generation: 1,
        discovery: FAVICON_DISCOVERY_VERSION,
        stored: false,
      });
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(1);
    });

    it("★ hands over the favicon candidates of a successful icon-check read: no second read, even if the page later fails", async () => {
      // [Discarding them in the icon check, so a second read finds a 404 and records none.]
      const t = setup({ extract: withFavicon });
      const id = await t.legacy(1);
      await t.pass.sweep();
      expect(rowOf(t, id)).toMatchObject({ candidates: [FAV], status: "pending", generation: 1 });
      expect(t.status(id)).toBe("pending");
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/1"]);
    });

    it("★ leaves an icon-check link with no favicon row when its page was not read, and the favicon check then settles it", async () => {
      // [Writing an empty list from the icon check, which would end the favicon search without a second read.]
      const t = setup({ page: () => http(404, "https://ex.com/gone") });
      const id = await t.legacy(1);
      await t.pass.sweep();
      expect(t.status(id)).toBe("none");
      expect(rowOf(t, id)).toBeNull();
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(2);
      expect(rowOf(t, id)).toMatchObject({ candidates: ROOT, status: "pending" });
    });

    it.each<[string, FetchOutcome, string[]]>([
      [
        "not html",
        {
          kind: "not_html",
          finalUrl: "https://files.example/a.pdf",
          contentType: "application/pdf",
        },
        ["https://files.example/apple-touch-icon.png", "https://files.example/favicon.ico"],
      ],
      ["a 404", http(404), GONE_ROOT],
      ["a 403", http(403), GONE_ROOT],
      ["a 410", http(410), GONE_ROOT],
      ["refused", { kind: "refused", reason: "address" }, []],
      ["too large", { kind: "too_large" }, []],
    ])(
      "settles a fetch that ends %s at once, from the address that answered",
      async (_n, outcome, want) => {
        const t = setup({ page: () => outcome });
        const id = await t.noFavicon(1);
        await t.pass.sweep();
        expect(rowOf(t, id)).toMatchObject({
          candidates: want,
          status: want.length > 0 ? "pending" : "none",
        });
        expect(t.extractOptions).toEqual([]);
        await t.pass.sweep();
        expect(t.pageCalls).toHaveLength(1);
      },
    );

    it.each<[string, ExtractOutcome]>([
      ["a timeout", { kind: "timeout", metadata: null }],
      ["a crash", { kind: "crashed", metadata: null, detail: "exit code 1" }],
      ["out of memory", { kind: "out_of_memory", metadata: null }],
    ])(
      "★ settles an extraction that ends in %s before metadata as none, once, even after a restart",
      async (_n, outcome) => {
        // [Backing off a content failure, which reads the same crashing page again and again.]
        const t = setup({ extract: () => outcome });
        const id = await t.noFavicon(1);
        await t.pass.sweep();
        expect(rowOf(t, id)).toMatchObject({ candidates: [], status: "none" });
        await t.pass.stop();
        await t.make().sweep();
        expect(t.pageCalls).toHaveLength(1);
      },
    );

    it("keeps the candidates of an extraction that ends badly after its metadata", async () => {
      const t = setup({
        extract: () => ({ kind: "timeout", metadata: meta({ faviconUrls: [FAV] }) }),
      });
      const id = await t.noFavicon(1);
      await t.pass.sweep();
      expect(rowOf(t, id)).toMatchObject({ candidates: [FAV], status: "pending" });
    });

    it.each<[string, Parameters<typeof setup>[0]]>([
      ["a 503", { page: () => http(503) }],
      ["a 429", { page: () => http(429) }],
      ["a timeout with the network up", { page: () => ({ kind: "timeout" }) }],
      [
        "a network error with the network up",
        { page: () => ({ kind: "network_error", code: "ECONNRESET" }) },
      ],
      ["a fetch aborted without stop()", { page: () => ({ kind: "aborted" }) }],
      ["a child that cannot start", { extract: () => ({ kind: "spawn_failed", detail: "x" }) }],
      ["an extraction aborted without stop()", { extract: () => ({ kind: "aborted" }) }],
    ])("backs off after %s, writing nothing, and reads the page again later", async (_n, o) => {
      const t = setup(o);
      const id = await t.noFavicon(1);
      await t.pass.sweep();
      expect(rowOf(t, id)).toBeNull();
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(1);
      t.wait();
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(2);
    });

    it("★ settles a link whose destination keeps answering 503 with the destination's root guesses on its last attempt", async () => {
      // [Parking the link unrecorded once its attempts run out, or writing an empty list.]
      const t = setup({ page: () => http(503) });
      const id = await t.noFavicon(1);
      for (let i = 0; i < MAX_IMAGE_ATTEMPTS - 1; i++) {
        await t.pass.sweep();
        expect(rowOf(t, id)).toBeNull();
        t.wait();
      }
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(MAX_IMAGE_ATTEMPTS);
      expect(rowOf(t, id)).toMatchObject({ candidates: GONE_ROOT, status: "pending" });
      t.wait();
      await t.pass.sweep();
      expect(t.pageCalls).toHaveLength(MAX_IMAGE_ATTEMPTS);
    });

    it.each<[string, Parameters<typeof setup>[0]]>([
      ["a timeout", { page: () => ({ kind: "timeout" }) }],
      ["a child that cannot start", { extract: () => ({ kind: "spawn_failed", detail: "x" }) }],
    ])("settles a link whose attempts run out on %s as none", async (_n, o) => {
      const t = setup(o);
      const id = await t.noFavicon(1);
      for (let i = 0; i < MAX_IMAGE_ATTEMPTS; i++) {
        await t.pass.sweep();
        t.wait();
      }
      expect(t.pageCalls).toHaveLength(MAX_IMAGE_ATTEMPTS);
      expect(rowOf(t, id)).toMatchObject({ candidates: [], status: "none" });
    });

    it("★ never counts a network that is down, and writes nothing while it is", async () => {
      // [Counting an offline attempt, so the last-attempt write fires with no verdict from the site.]
      let up = false;
      const t = setup({
        page: (url) => (up ? okPage(url) : { kind: "network_error", code: "ENOTFOUND" }),
        extract: withFavicon,
        canResolve: () => up,
      });
      const id = await t.noFavicon(1);
      for (let i = 0; i < MAX_IMAGE_ATTEMPTS + 2; i++) {
        await t.pass.sweep();
        t.wait();
      }
      expect(rowOf(t, id)).toBeNull();
      up = true;
      await t.pass.sweep();
      expect(rowOf(t, id)).toMatchObject({ candidates: [FAV], status: "pending" });
      expect(t.logged).toEqual([]);
    });

    it("★ keeps its budget apart from the other kinds: a link the word-picture check gave up on still settles", async () => {
      // [Failures keyed by owner and link, so the favicon check inherits the word-picture backoff.]
      const t = setup({ extract: () => ({ kind: "crashed", metadata: null, detail: "x" }) });
      const { link } = await t.store.insertIfAbsent(OWNER, {
        ...newLink(1, at(0)),
        url: GITHUB,
        urlKey: "github.com/Nostoi/aye-ai-ai-links",
      });
      const lease = await t.store.leaseSnapshot(OWNER, link.id, at(1), at(100));
      const r = record({ imageUrl: PREVIEW, iconUrls: [FAVICON] });
      expect(await t.store.recordSnapshot(OWNER, link.id, lease?.claim ?? -1, r)).toBe(true);
      await t.pass.sweep();
      expect(rowOf(t, link.id)).toBeNull();
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([GITHUB, GITHUB]);
      expect(rowOf(t, link.id)).toMatchObject({ candidates: [], status: "none" });
    });

    it("reads a none row below the current discovery version again, and rewrites it", async () => {
      const t = setup({ extract: withFavicon });
      const id = await t.noFavicon(1, { faviconUrls: [] });
      t.store.seedFavicon(OWNER, id, { status: "none", discovery: 1 });
      await t.pass.sweep();
      expect(rowOf(t, id)).toMatchObject({ candidates: [FAV], status: "pending", generation: 2 });
    });

    it.each<["ok" | "pending" | "none", number]>([
      ["ok", 1],
      ["pending", 1],
      ["none", FAVICON_DISCOVERY_VERSION],
    ])("★ never reads a link whose favicon row is %s at version %i", async (status, discovery) => {
      // [A re-read of a working favicon, which could lose it.]
      const t = setup({ extract: withFavicon });
      const id = await t.noFavicon(1, { faviconUrls: [FAV] });
      t.store.seedFavicon(OWNER, id, { status, discovery });
      const before = rowOf(t, id);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual([]);
      expect(rowOf(t, id)).toEqual(before);
    });

    it("★ writes nothing for a link deleted during the read, and reads it again once the delete is undone", async () => {
      // [Writing to a hidden link, or forgetting it for good.]
      let doomed = "";
      let deleted = false;
      const t: ReturnType<typeof setup> = setup({
        page: async (url) => {
          if (!deleted) await t.store.markDeleted(OWNER, doomed, at(50));
          deleted = true;
          return okPage(url);
        },
        extract: withFavicon,
      });
      doomed = await t.noFavicon(1);
      await t.pass.sweep();
      expect(rowOf(t, doomed)).toBeNull();
      expect(await t.store.unmarkDeleted(OWNER, doomed, at(50))).toBe(true);
      t.wait();
      await t.pass.sweep();
      expect(rowOf(t, doomed)).toMatchObject({ candidates: [FAV], status: "pending" });
    });

    it("★ leaves a row that appeared during the read alone", async () => {
      // [A write that does not compare the claim: it would rewrite the newer row.]
      const other = "https://ex.com/other.png";
      let id = "";
      const t: ReturnType<typeof setup> = setup({
        page: async (url) => {
          expect(await t.store.recordFaviconCheck(OWNER, id, null, [other])).toBe(true);
          return okPage(url);
        },
        extract: withFavicon,
      });
      id = await t.noFavicon(1);
      await t.pass.sweep();
      expect(rowOf(t, id)).toMatchObject({ candidates: [other], generation: 1 });
      expect(t.logged.some((l) => l.includes("the store refused the check"))).toBe(true);
    });

    it("looks at the favicon after the icon kinds: a legacy link first, then this one", async () => {
      const t = setup({ extract: withFavicon });
      const bare = await t.noFavicon(1);
      await t.legacy(2);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/2"]);
      await t.pass.sweep();
      expect(t.pageCalls).toEqual(["https://ex.com/2", "https://ex.com/1"]);
      expect(rowOf(t, bare)).toMatchObject({ candidates: [FAV] });
    });
  });
});
