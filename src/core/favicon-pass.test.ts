import { afterEach, describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { createFaviconPass, type FaviconPass } from "./favicon-pass.js";
import { FAVICON_DISCOVERY_VERSION } from "./favicon-store.js";
import type { ImageFetcher, ImageOutcome } from "./fetch.js";
import { createImageIndexer, MAX_IMAGE_ATTEMPTS, RETRY_MAX_MS } from "./image-indexer.js";
import { png } from "./image-test-kit.js";
import { at, newLink, record } from "./snapshot-store-contract.js";

const OWNER = "o";
const F1 = "https://ex.com/f1.png";
const F2 = "https://ex.com/f2.png";
const F3 = "https://ex.com/f3.png";
const F4 = "https://ex.com/f4.png";
const IMG = "https://ex.com/og.png";
const okPng = (bytes: Buffer): ImageOutcome => ({
  kind: "ok",
  contentType: "image/png",
  bytes: new Uint8Array(bytes),
});
const NOT_FOUND: ImageOutcome = { kind: "http_error", status: 404 };

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()));
});

function setup(answer: (url: string, signal?: AbortSignal) => Promise<ImageOutcome>) {
  const store = new FakeStore();
  const calls: string[] = [];
  const fetcher: ImageFetcher = {
    fetch: (url, signal) => {
      calls.push(url);
      return answer(url, signal);
    },
    close: async () => {},
  };
  let clock = at(1000).getTime();
  const now = () => new Date(clock);
  const pass: FaviconPass = createFaviconPass({ store, fetcher, now, log: () => {} });
  running.push(pass);
  let n = 0;
  return {
    store,
    fetcher,
    pass,
    calls,
    now,
    wait: () => {
      clock += RETRY_MAX_MS;
    },
    /** A link whose page was read with these favicon candidates (and icons, and preview). */
    async page(faviconUrls: string[], over: Parameters<typeof record>[0] = {}) {
      const { link } = await store.insertIfAbsent(OWNER, newLink(++n, at(0)));
      const lease = await store.leaseSnapshot(OWNER, link.id, at(1), at(100));
      const r = record({ imageUrl: null, faviconUrls, ...over });
      expect(await store.recordSnapshot(OWNER, link.id, lease?.claim ?? -1, r)).toBe(true);
      return link.id;
    },
  };
}

describe("favicon pass", () => {
  it("★ stores a 32 px favicon after the large-picture pass refused it and moved on (challenge 1)", async () => {
    // [Reading favicon candidates from snapshots.icon_*, which the large-picture pass rewrites
    // when the 32 px icon fails its 64 px floor, leaving only the 404.]
    const t = setup(async (url) => (url === F1 ? okPng(png(32, 32)) : NOT_FOUND));
    const id = await t.page([F1, F2], { iconUrls: [F1, F2] });
    const images = createImageIndexer({ store: t.store, fetcher: t.fetcher, now: t.now });
    running.push(images);
    await images.sweep();
    await images.sweep();
    expect(await t.store.pendingImages(null, 100)).toEqual([]);
    expect(await t.store.imageVersions(OWNER, [id])).toEqual(new Map());

    await t.pass.sweep();
    expect((await t.store.favicon(OWNER, id))?.bytes).toEqual(new Uint8Array(png(32, 32)));
    // The link's one picture is untouched: still none.
    expect(await t.store.imageVersions(OWNER, [id])).toEqual(new Map());
    expect(await t.store.image(OWNER, id, "page")).toBeNull();
  });

  it("★ tries the candidates in order and keeps the first of at least 16 px", async () => {
    // [Stopping at the first failure, or applying the 64 px floor.]
    const answers: Record<string, ImageOutcome> = {
      [F1]: NOT_FOUND,
      [F2]: { kind: "not_image", contentType: "image/svg+xml" },
      [F3]: okPng(png(15, 15)),
      [F4]: okPng(png(16, 16)),
    };
    const t = setup(async (url) => answers[url] ?? NOT_FOUND);
    const id = await t.page([F1, F2, F3, F4]);
    await t.pass.sweep();
    expect(t.calls).toEqual([F1, F2, F3, F4]);
    expect((await t.store.favicon(OWNER, id))?.bytes).toEqual(new Uint8Array(png(16, 16)));
    expect(t.store.faviconRow(OWNER, id)).toMatchObject({ status: "ok", stored: true });
  });

  it("ends as none when every candidate fails, and as refused when every one was refused", async () => {
    const t = setup(async (url) =>
      url === F1 ? { kind: "refused", reason: "address" } : NOT_FOUND,
    );
    const failed = await t.page([F1, F2]);
    const refused = await t.page([F1]);
    await t.pass.sweep();
    expect(t.store.faviconRow(OWNER, failed)).toMatchObject({ status: "none", stored: false });
    expect(t.store.faviconRow(OWNER, refused)).toMatchObject({ status: "refused", stored: false });
    expect(await t.store.pendingFavicons(null, 100)).toEqual([]);
  });

  it("★ backs off after a failure that may pass, and ends as none after MAX_IMAGE_ATTEMPTS", async () => {
    // [Ending a favicon on one timeout, or retrying it every sweep without a bound.]
    const t = setup(async () => ({ kind: "timeout" }));
    const id = await t.page([F1]);
    await t.pass.sweep();
    await t.pass.sweep();
    expect(t.calls).toEqual([F1]);
    expect(t.store.faviconRow(OWNER, id)).toMatchObject({ status: "pending" });
    for (let i = 1; i < MAX_IMAGE_ATTEMPTS; i++) {
      t.wait();
      await t.pass.sweep();
    }
    expect(t.calls).toHaveLength(MAX_IMAGE_ATTEMPTS);
    expect(t.store.faviconRow(OWNER, id)).toMatchObject({ status: "none", stored: false });
  });

  it("stores a later candidate when an earlier one fails in a way that may pass", async () => {
    const t = setup(async (url) => (url === F1 ? { kind: "timeout" } : okPng(png(32, 32))));
    const id = await t.page([F1, F2]);
    await t.pass.sweep();
    expect(t.store.faviconRow(OWNER, id)).toMatchObject({ status: "ok", stored: true });
  });

  it("★ writes nothing for a fetch whose candidates were rewritten meanwhile, then fetches the new ones", async () => {
    // [Writing on the claim it read, so the old page's A.png lands over the new page's B.png.]
    let id = "";
    const t = setup(async (url) => {
      if (url === F1) {
        expect(await t.store.recordWordPictureCheck(OWNER, id, IMG, [], [F2])).toBe(true);
      }
      return okPng(png(32, url === F1 ? 33 : 34));
    });
    id = await t.page([F1], { imageUrl: IMG });
    await t.pass.sweep();
    expect(t.store.faviconRow(OWNER, id)).toEqual({
      candidates: [F2],
      status: "pending",
      generation: 2,
      discovery: FAVICON_DISCOVERY_VERSION,
      stored: false,
    });
    await t.pass.sweep();
    expect(t.calls).toEqual([F1, F2]);
    expect((await t.store.favicon(OWNER, id))?.bytes).toEqual(new Uint8Array(png(32, 34)));
  });

  it("stop() during a fetch writes nothing and leaves the favicon pending", async () => {
    let started!: () => void;
    const fetching = new Promise<void>((r) => {
      started = r;
    });
    const t = setup(
      (_url, signal) =>
        new Promise((resolve) => {
          started();
          signal?.addEventListener("abort", () => resolve({ kind: "aborted" }));
        }),
    );
    const id = await t.page([F1]);
    const sweep = t.pass.sweep();
    await fetching;
    await t.pass.stop();
    await sweep;
    expect(t.store.faviconRow(OWNER, id)).toMatchObject({ status: "pending", stored: false });
  });

  it("start() sweeps now and again every pollMs, and stop() ends it", async () => {
    const t = setup(async () => okPng(png(32, 32)));
    const first = await t.page([F1]);
    const pass = createFaviconPass({ store: t.store, fetcher: t.fetcher, now: t.now, pollMs: 5 });
    running.push(pass);
    pass.start();
    await expect.poll(() => t.store.faviconRow(OWNER, first)?.status).toBe("ok");
    const second = await t.page([F2]);
    await expect.poll(() => t.store.faviconRow(OWNER, second)?.status).toBe("ok");
    await pass.stop();
  });
});
