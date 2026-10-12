import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractOutcome, PageExtractor } from "./extract.js";
import { FakeStore } from "./fake-store.js";
import type { FetchOutcome, PageFetcher } from "./fetch.js";
import { getLinkWithText, SAVE_WAIT_MS, saveLink, updateLink } from "./links.js";
import { createSnapshotRunner } from "./snapshot-runner.js";
import { EXCERPT_CHARS, TEXT_CHARS } from "./snapshot-text.js";
import { describeStoreContract, type StoreHarness } from "./store-contract.js";
import type { Link } from "./types.js";

function harnessFor(store: FakeStore): StoreHarness {
  return {
    store,
    addOwner: () => {},
    all: (owner) => store.all(owner),
    catalog: (owner) => store.catalog(owner),
    seedTag: (owner, tag) => store.seedTag(owner, tag),
  };
}

describeStoreContract("FakeStore", () => harnessFor(new FakeStore()));

describe("saveLink and page snapshots", () => {
  const setup = () => {
    const kicks: [string, string][] = [];
    const deps = {
      store: new FakeStore(),
      now: () => new Date("2026-01-01T00:00:00Z"),
      snapshots: {
        kick: async (owner: string, linkId: string) => {
          kicks.push([owner, linkId]);
        },
      },
    };
    return { deps, kicks };
  };

  it("kicks the snapshot of a new link, and never of a repeat save", async () => {
    const { deps, kicks } = setup();
    const first = await saveLink(deps, "a", { url: "https://ex.com/a", savedBy: "agent" });
    await saveLink(deps, "a", { url: "https://ex.com/a", savedBy: "agent" });
    // The repeat that fills a missing why takes its own branch.
    await saveLink(deps, "a", {
      url: "https://ex.com/a",
      savedBy: "agent",
      why: { text: "for the trip", source: "stated" },
    });
    expect(kicks).toEqual([["a", first.link.id]]);
  });

  it("saves without a snapshot runner", async () => {
    const { deps } = setup();
    const { snapshots: _, ...bare } = deps;
    const saved = await saveLink(bare, "a", { url: "https://ex.com/a", savedBy: "agent" });
    expect(saved.created).toBe(true);
  });
});

const T0 = new Date("2026-01-01T00:00:00Z");
const URL_A = { url: "https://ex.com/a", savedBy: "agent" };

/** Records an ok snapshot for a link, as a finished job does. */
async function finishOk(store: FakeStore, owner: string, id: string, text: string | null) {
  const lease = await store.leaseSnapshot(owner, id, T0, new Date(T0.getTime() + 120_000));
  if (!lease) throw new Error("no lease");
  const recorded = await store.recordSnapshot(owner, id, lease.claim, {
    status: "ok",
    attempts: lease.attempts,
    nextFetchAt: null,
    fetchedAt: T0,
    title: "Page title",
    description: "About the page",
    imageUrl: null,
    text,
    lastError: null,
  });
  if (!recorded) throw new Error("not recorded");
}

/** Tracks whether a promise has settled, without awaiting it. */
function watch<T>(promise: Promise<T>) {
  const state = { done: false, value: undefined as T | undefined };
  void promise.then((v) => {
    state.done = true;
    state.value = v;
  });
  return state;
}

describe("saveLink waits for a new link's page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A kick that runs `job` and resolves when it ends; `kicks` counts the calls. */
  const depsWith = (job: (store: FakeStore, owner: string, id: string) => Promise<void>) => {
    const store = new FakeStore();
    const kicks: string[] = [];
    const deps = {
      store,
      pages: store,
      now: () => T0,
      snapshots: {
        kick: (owner: string, id: string) => {
          kicks.push(id);
          return job(store, owner, id);
        },
      },
    };
    return { store, deps, kicks };
  };

  const elapse = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const never = () => new Promise<void>(() => {});

  it("returns the fetched page when the job ends within the wait (D1)", async () => {
    const text = "x".repeat(EXCERPT_CHARS + 1);
    const { deps } = depsWith(async (store, owner, id) => {
      await elapse(SAVE_WAIT_MS - 1);
      await finishOk(store, owner, id, text);
    });
    const saving = watch(saveLink(deps, "a", URL_A));
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1);
    expect(saving.done).toBe(true);
    expect(saving.value?.link.snapshot).toMatchObject({ status: "ok", title: "Page title" });
    expect(saving.value?.snapshotText).toEqual({
      text: text.slice(0, EXCERPT_CHARS),
      truncated: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns pending at the wait's end when the job has not ended, and clears its timer (D2)", async () => {
    const { deps } = depsWith(never);
    const saving = watch(saveLink(deps, "a", URL_A));
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1);
    expect(saving.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(saving.done).toBe(true);
    expect(saving.value?.created).toBe(true);
    expect(saving.value?.link.snapshot?.status).toBe("pending");
    expect(saving.value?.snapshotText).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer when the job wins", async () => {
    const { deps } = depsWith(async () => {});
    const saving = watch(saveLink(deps, "a", URL_A));
    await vi.advanceTimersByTimeAsync(0);
    expect(saving.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the saveWaitMs it is given", async () => {
    const { deps } = depsWith(never);
    const saving = watch(saveLink({ ...deps, saveWaitMs: 50 }, "a", URL_A));
    await vi.advanceTimersByTimeAsync(50);
    expect(saving.done).toBe(true);
  });

  it("returns an edit made during the wait (#57 title)", async () => {
    const { deps } = depsWith(async (store, owner, id) => {
      await elapse(1_000);
      await updateLink({ store, now: () => T0 }, owner, id, { title: "Edited" });
      await never();
    });
    const saving = watch(saveLink(deps, "a", { ...URL_A, title: "First" }));
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
    expect(saving.value?.link.title).toBe("Edited");
  });

  it("never kicks or waits on a repeat save, and returns the stored excerpt at once (D3)", async () => {
    const { deps, kicks, store } = depsWith(async () => {});
    const first = await saveLink(deps, "a", URL_A);
    await finishOk(store, "a", first.link.id, "stored body");
    const repeat = watch(saveLink(deps, "a", URL_A));
    const fillsWhy = watch(saveLink(deps, "a", { ...URL_A, why: { text: "w", source: "stated" } }));
    await vi.advanceTimersByTimeAsync(0);
    for (const r of [repeat, fillsWhy]) {
      expect(r.done).toBe(true);
      expect(r.value?.created).toBe(false);
      expect(r.value?.link.snapshot?.status).toBe("ok");
      expect(r.value?.snapshotText).toEqual({ text: "stored body", truncated: false });
    }
    expect(fillsWhy.value?.link.why?.text).toBe("w");
    expect(kicks).toEqual([first.link.id]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Codex: an extraction that completes between the link read and the text read.
  describe("text and status come from one moment", () => {
    /** A reader that finishes the link's extraction just before it reads the text. */
    const racingPages = (store: FakeStore) => ({
      getSnapshotText: async (owner: string, id: string) => {
        await finishOk(store, owner, id, "finished meanwhile");
        return store.getSnapshotText(owner, id);
      },
    });
    const coherent = (r: { link: Link; snapshotText: unknown } | undefined) => {
      expect(r?.link.snapshot?.status).toBe("pending");
      expect(r?.snapshotText).toBeNull();
    };

    it("on a save whose wait ran out", async () => {
      const { deps, store } = depsWith(never);
      const saving = watch(saveLink({ ...deps, pages: racingPages(store) }, "a", URL_A));
      await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);
      coherent(saving.value);
    });

    it("on a repeat save", async () => {
      const store = new FakeStore();
      await saveLink({ store, now: () => T0 }, "a", URL_A);
      coherent(await saveLink({ store, now: () => T0, pages: racingPages(store) }, "a", URL_A));
    });

    it("on getLinkWithText", async () => {
      const store = new FakeStore();
      const { link } = await saveLink({ store, now: () => T0 }, "a", URL_A);
      coherent(
        await getLinkWithText({ store, now: () => T0, pages: racingPages(store) }, "a", link.id),
      );
    });
  });

  it("lets a read that fails after the commit fail the call; a retry returns the saved link", async () => {
    const { deps, store } = depsWith(async () => {});
    vi.spyOn(store, "get").mockRejectedValueOnce(new Error("database closed"));
    await expect(saveLink(deps, "a", URL_A)).rejects.toThrow("database closed");
    const retry = await saveLink(deps, "a", URL_A);
    expect(retry.created).toBe(false);
    expect(store.all("a")).toHaveLength(1);
    expect(retry.link.id).toBe(store.all("a")[0]?.id);
  });
});

describe("saveLink with the real snapshot runner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const PAGE: ExtractOutcome = {
    kind: "ok",
    metadata: { title: "Page title", description: null, imageUrl: null },
    text: "page text",
  };

  /** A runner over a FakeStore whose fetches hang until aborted, unless `fetch` is given. */
  const withRunner = (o: { fetch?: PageFetcher["fetch"]; slots?: number } = {}) => {
    const store = new FakeStore();
    const leases = vi.spyOn(store, "leaseSnapshot");
    const fetcher: PageFetcher = {
      fetch:
        o.fetch ??
        ((_url, signal) =>
          new Promise<FetchOutcome>((resolve) => {
            signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), {
              once: true,
            });
          })),
      close: async () => {},
    };
    const extractor: PageExtractor = { extract: async () => PAGE, close: async () => {} };
    const log = vi.fn();
    const runner = createSnapshotRunner({
      store,
      fetcher,
      extractor,
      now: () => T0,
      log,
      slots: o.slots ?? 2,
    });
    const deps = { store, pages: store, now: () => T0, snapshots: runner };
    return { store, runner, deps, leases, log };
  };

  it("returns pending at once for a save after quiesce, and leases nothing", async () => {
    const { runner, deps, leases } = withRunner();
    runner.quiesce();
    const saving = watch(saveLink(deps, "a", URL_A));
    await vi.advanceTimersByTimeAsync(0);
    expect(saving.done).toBe(true);
    expect(saving.value?.link.snapshot?.status).toBe("pending");
    expect(leases).not.toHaveBeenCalled();
  });

  it("ends a queued save's wait when quiesce settles it, while a running one waits on", async () => {
    const { runner, deps } = withRunner({ slots: 1 });
    const running = watch(saveLink(deps, "a", URL_A));
    const queued = watch(saveLink(deps, "a", { ...URL_A, url: "https://ex.com/b" }));
    await vi.advanceTimersByTimeAsync(0);
    expect([running.done, queued.done]).toEqual([false, false]);
    runner.quiesce();
    await vi.advanceTimersByTimeAsync(0);
    expect(queued.done).toBe(true);
    expect(queued.value?.link.snapshot?.status).toBe("pending");
    expect(running.done).toBe(false);
    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1);
    expect(running.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(running.done).toBe(true);
    expect(running.value?.link.snapshot?.status).toBe("pending");
    await runner.stop();
  });

  it("returns pending, without waiting out the timer, when recording fails after extraction", async () => {
    const { store, deps, log } = withRunner({
      fetch: async (url) => ({ kind: "ok", finalUrl: url, contentType: "text/html", html: "" }),
    });
    vi.spyOn(store, "recordSnapshot").mockRejectedValue(new Error("SQLITE_FULL"));
    const saving = watch(saveLink(deps, "a", URL_A));
    await vi.advanceTimersByTimeAsync(0);
    expect(saving.done).toBe(true);
    expect(saving.value?.link.snapshot?.status).toBe("pending");
    expect(saving.value?.snapshotText).toBeNull();
    expect(String(log.mock.calls[0]?.[1])).toContain("SQLITE_FULL");
  });

  it("returns the fetched page and its excerpt when the job ends in time", async () => {
    const { deps } = withRunner({
      fetch: async (url) => ({ kind: "ok", finalUrl: url, contentType: "text/html", html: "" }),
    });
    const saving = watch(saveLink(deps, "a", URL_A));
    await vi.advanceTimersByTimeAsync(0);
    expect(saving.value?.link.snapshot).toMatchObject({ status: "ok", title: "Page title" });
    expect(saving.value?.snapshotText).toEqual({ text: "page text", truncated: false });
  });
});

describe("getLinkWithText", () => {
  it("returns the link and its text, capped at TEXT_CHARS", async () => {
    const store = new FakeStore();
    const deps = { store, pages: store, now: () => T0 };
    const { link } = await saveLink(deps, "a", URL_A);
    await finishOk(store, "a", link.id, "y".repeat(TEXT_CHARS + 1));
    const got = await getLinkWithText(deps, "a", link.id);
    expect(got.link.snapshot?.status).toBe("ok");
    expect(got.snapshotText).toEqual({ text: "y".repeat(TEXT_CHARS), truncated: true });
  });
});
