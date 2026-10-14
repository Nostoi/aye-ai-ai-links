import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStore } from "./fake-store.js";
import type { ImageFetcher, ImageOutcome } from "./fetch.js";
import {
  createImageIndexer,
  type ImageIndexer,
  MAX_IMAGE_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
} from "./image-indexer.js";
import { at, newLink, record } from "./snapshot-store-contract.js";

const OWNER = "o";
const PNG: ImageOutcome = {
  kind: "ok",
  contentType: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

/** A link whose snapshot was recorded with `imageUrl`, so its image is pending. */
async function linkWithImage(store: FakeStore, n: number, imageUrl = `https://ex.com/${n}.png`) {
  const { link } = await store.insertIfAbsent(OWNER, newLink(n, at(0)));
  const lease = await store.leaseSnapshot(OWNER, link.id, at(1), at(100));
  await store.recordSnapshot(OWNER, link.id, lease?.claim ?? -1, record({ imageUrl }));
  return link.id;
}

/** A fetcher answering each call with `answer`; `calls` lists the URLs asked for. */
function fakeFetcher(answer: (url: string, signal?: AbortSignal) => Promise<ImageOutcome>) {
  const calls: string[] = [];
  const fetcher: ImageFetcher = {
    fetch: (url, signal) => {
      calls.push(url);
      return answer(url, signal);
    },
    close: async () => {},
  };
  return { fetcher, calls };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const running: ImageIndexer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.stop()));
});

function setup(
  answer: (url: string, signal?: AbortSignal) => Promise<ImageOutcome>,
  { pageSize }: { pageSize?: number } = {},
) {
  const store = new FakeStore();
  const { fetcher, calls } = fakeFetcher(answer);
  let clock = at(1000).getTime();
  const logged: string[] = [];
  const indexer = createImageIndexer({
    store,
    fetcher,
    now: () => new Date(clock),
    log: (message) => logged.push(message),
    ...(pageSize && { pageSize }),
  });
  running.push(indexer);
  const pending = async () => (await store.pendingImages(null, 100)).map((p) => p.linkId);
  return {
    store,
    indexer,
    calls,
    logged,
    pending,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("the image pass", () => {
  it("stores a pending image and never fetches it again", async () => {
    const t = setup(async () => PNG);
    const id = await linkWithImage(t.store, 1);
    await t.indexer.sweep();
    await t.indexer.sweep();
    expect(t.calls).toEqual(["https://ex.com/1.png"]);
    expect(await t.store.image(OWNER, id)).toMatchObject({
      contentType: "image/png",
      bytes: (PNG as { bytes: Uint8Array }).bytes,
    });
    expect(await t.pending()).toEqual([]);
  });

  it.each([
    ["a non-image", "none", { kind: "not_image", contentType: "text/html" }],
    ["a body too large", "none", { kind: "too_large" }],
    ["a 404", "none", { kind: "http_error", status: 404 }],
    ["a refused address", "refused", { kind: "refused", reason: "address" }],
    ["a refused redirect", "refused", { kind: "refused", reason: "too_many_redirects" }],
  ] as [string, string, ImageOutcome][])(
    "ends %s as %s at once, storing nothing and never fetching it again",
    async (_, end, outcome) => {
      const t = setup(async () => outcome);
      const ended = vi.spyOn(t.store, "endImage");
      const id = await linkWithImage(t.store, 1);
      await t.indexer.sweep();
      t.advance(RETRY_MAX_MS * 10);
      await t.indexer.sweep();
      expect(t.calls).toHaveLength(1);
      expect(ended).toHaveBeenCalledWith(OWNER, id, "https://ex.com/1.png", end);
      expect(await t.store.image(OWNER, id)).toBeNull();
      expect(await t.pending()).toEqual([]);
    },
  );

  it.each([
    ["a 503", { kind: "http_error", status: 503 }],
    ["a 429", { kind: "http_error", status: 429 }],
    ["a 408", { kind: "http_error", status: 408 }],
    ["a network error", { kind: "network_error", code: "ECONNRESET" }],
    ["a timeout", { kind: "timeout" }],
  ] as [string, ImageOutcome][])(
    "keeps %s pending and tries again after the backoff, not before",
    async (_, outcome) => {
      const t = setup(async () => outcome);
      const id = await linkWithImage(t.store, 1);
      await t.indexer.sweep();
      expect(await t.pending()).toEqual([id]);
      t.advance(RETRY_BASE_MS - 1);
      await t.indexer.sweep();
      expect(t.calls).toHaveLength(1);
      t.advance(1);
      await t.indexer.sweep();
      expect(t.calls).toHaveLength(2);
      expect(await t.pending()).toEqual([id]);
    },
  );

  it(`doubles the backoff per failure up to an hour, and ends as none after ${MAX_IMAGE_ATTEMPTS} failed attempts`, async () => {
    const t = setup(async () => ({ kind: "http_error", status: 503 }));
    const ended = vi.spyOn(t.store, "endImage");
    const id = await linkWithImage(t.store, 1);
    const waits: number[] = [];
    await t.indexer.sweep();
    for (let round = 1; round < MAX_IMAGE_ATTEMPTS; round++) {
      let waited = 0;
      const before = t.calls.length;
      while (t.calls.length === before && waited <= 2 * RETRY_MAX_MS) {
        t.advance(RETRY_BASE_MS);
        waited += RETRY_BASE_MS;
        await t.indexer.sweep();
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1, 2, 4, 8].map((k) => Math.min(k * RETRY_BASE_MS, RETRY_MAX_MS)));
    expect(ended).toHaveBeenCalledWith(OWNER, id, "https://ex.com/1.png", "none");
    expect(await t.pending()).toEqual([]);
  });

  it("succeeds after a transient failure once the backoff has passed", async () => {
    let fail = true;
    const t = setup(async () => (fail ? { kind: "timeout" } : PNG));
    const id = await linkWithImage(t.store, 1);
    await t.indexer.sweep();
    fail = false;
    t.advance(RETRY_BASE_MS);
    await t.indexer.sweep();
    expect(await t.store.image(OWNER, id)).not.toBeNull();
  });

  it("makes one fetch call for one pending image when two passes run at once", async () => {
    const release = gate();
    const t = setup(async () => {
      await release.opened;
      return PNG;
    });
    await linkWithImage(t.store, 1);
    const both = Promise.all([t.indexer.sweep(), t.indexer.sweep()]);
    release.open();
    await both;
    expect(t.calls).toHaveLength(1);
  });

  it("fetches one image at a time, in link order, across pages", async () => {
    let inFlight = 0;
    let most = 0;
    const t = setup(
      async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return PNG;
      },
      { pageSize: 2 },
    );
    for (let n = 1; n <= 5; n++) await linkWithImage(t.store, n);
    await t.indexer.sweep();
    expect(t.calls).toEqual([1, 2, 3, 4, 5].map((n) => `https://ex.com/${n}.png`));
    expect(most).toBe(1);
    expect(await t.pending()).toEqual([]);
  });

  it("on stop, aborts the fetch in flight, waits for it, and leaves the image pending", async () => {
    const events: string[] = [];
    const t = setup(
      (_url, signal) =>
        new Promise<ImageOutcome>((resolve) => {
          events.push("fetching");
          signal?.addEventListener("abort", () =>
            setTimeout(() => {
              events.push("aborted");
              resolve({ kind: "aborted" });
            }, 20),
          );
        }),
    );
    const ended = vi.spyOn(t.store, "endImage");
    const wrote = vi.spyOn(t.store, "writeImage");
    const id = await linkWithImage(t.store, 1);
    t.indexer.start();
    for (let i = 0; i < 100 && !events.includes("fetching"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await t.indexer.stop();
    events.push("stopped");
    await t.indexer.stop();
    expect(events).toEqual(["fetching", "aborted", "stopped"]);
    expect(ended).not.toHaveBeenCalled();
    expect(wrote).not.toHaveBeenCalled();
    expect(await t.pending()).toEqual([id]);
  });

  it("after quiesce, finishes and writes the fetch in flight but starts no other", async () => {
    const release = gate();
    const t = setup(async () => {
      await release.opened;
      return PNG;
    });
    const first = await linkWithImage(t.store, 1);
    const second = await linkWithImage(t.store, 2);
    const sweeping = t.indexer.sweep();
    await new Promise((r) => setTimeout(r, 5));
    t.indexer.quiesce();
    release.open();
    await sweeping;
    expect(t.calls).toEqual(["https://ex.com/1.png"]);
    expect(await t.store.image(OWNER, first)).not.toBeNull();
    expect(await t.pending()).toEqual([second]);
  });

  it("logs a store error, ends that sweep, and still runs the next", async () => {
    const t = setup(async () => PNG);
    const id = await linkWithImage(t.store, 1);
    const write = vi.spyOn(t.store, "writeImage").mockRejectedValueOnce(new Error("disk full"));
    await t.indexer.sweep();
    expect(t.logged.some((m) => /image pass sweep failed/.test(m))).toBe(true);
    await t.indexer.sweep();
    expect(write).toHaveBeenCalledTimes(2);
    expect(await t.store.image(OWNER, id)).not.toBeNull();
  });
});
