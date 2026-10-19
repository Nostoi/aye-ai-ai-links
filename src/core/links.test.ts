import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractOutcome, PageExtractor } from "./extract.js";
import { FakeSavedCopies } from "./fake-saved-copies.js";
import { FakeStore } from "./fake-store.js";
import type { FetchOutcome, PageFetcher } from "./fetch.js";
import {
  getLinkWithText,
  normalizeTitle,
  recordOpening,
  SAVE_WAIT_MS,
  saveLink,
  titleFits,
  updateLink,
} from "./links.js";
import { copyLimits } from "./saved-copy.js";
import { createSnapshotRunner } from "./snapshot-runner.js";
import { newLink } from "./snapshot-store-contract.js";
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
    iconUrls: [],
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
        await getLinkWithText(
          {
            store,
            now: () => T0,
            pages: racingPages(store),
            savedCopies: new FakeSavedCopies(store),
          },
          "a",
          link.id,
          "t",
        ),
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
    const deps = { store, pages: store, now: () => T0, savedCopies: new FakeSavedCopies(store) };
    const { link } = await saveLink(deps, "a", URL_A);
    await finishOk(store, "a", link.id, "y".repeat(TEXT_CHARS + 1));
    const got = await getLinkWithText(deps, "a", link.id, "t");
    expect(got.link.snapshot?.status).toBe("ok");
    expect(got.snapshotText).toEqual({ text: "y".repeat(TEXT_CHARS), truncated: true });
  });
});

describe("getLinkWithText savedCopy", () => {
  const draft = { markdown: "body", imageUrls: [], nonce: "0123456789abcdef0123456789abcdef" };
  const madeAt = new Date("2026-02-03T04:05:06Z");
  const setup = async () => {
    const store = new FakeStore();
    const savedCopies = new FakeSavedCopies(store);
    const deps = { store, pages: store, savedCopies, now: () => T0 };
    const { link } = await saveLink(deps, "a", URL_A);
    return { deps, savedCopies, link };
  };

  it("is { madeAt } for a link with an ok copy", async () => {
    const { deps, savedCopies, link } = await setup();
    await savedCopies.saveCopy("a", link.id, draft, copyLimits(1_000_000), madeAt);
    expect((await getLinkWithText(deps, "a", link.id, "t")).savedCopy).toEqual({ madeAt });
  });

  it("is null for a link with no copy row", async () => {
    const { deps, link } = await setup();
    expect((await getLinkWithText(deps, "a", link.id, "t")).savedCopy).toBeNull();
  });

  it("is null for a none row", async () => {
    const { deps, savedCopies, link } = await setup();
    await savedCopies.recordNoCopy("a", link.id, "none");
    expect((await getLinkWithText(deps, "a", link.id, "t")).savedCopy).toBeNull();
  });

  it("is null for a no_room row", async () => {
    const { deps, savedCopies, link } = await setup();
    expect(await savedCopies.saveCopy("a", link.id, draft, copyLimits(1), madeAt)).toBe("no_room");
    expect((await getLinkWithText(deps, "a", link.id, "t")).savedCopy).toBeNull();
  });

  it("is null after a copy whose file write failed was released", async () => {
    const { deps, savedCopies, link } = await setup();
    savedCopies.failNextWrite(new Error("disk full"));
    await expect(
      savedCopies.saveCopy("a", link.id, draft, copyLimits(1_000_000), madeAt),
    ).rejects.toThrow("disk full");
    expect((await getLinkWithText(deps, "a", link.id, "t")).savedCopy).toBeNull();
  });

  it("refuses another owner's id before reading any copy info", async () => {
    const { deps, savedCopies, link } = await setup();
    const spy = vi.spyOn(savedCopies, "copyInfo");
    await expect(getLinkWithText(deps, "b", link.id, "t")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("recordOpening", () => {
  const setup = () => {
    const store = new FakeStore();
    const logged: string[] = [];
    const searchLog = {
      record: async () => void logged.push("record"),
      pairOpen: async () => void logged.push("pairOpen"),
    };
    return { store, logged, deps: { store, searchLog, now: () => T0 } };
  };

  it("records when the owner opened the link and nothing else: no surfacing, no search log", async () => {
    const { store, logged, deps } = setup();
    const { link } = await saveLink(deps, "a", URL_A);
    await recordOpening(deps, "a", link.id);
    const [after] = store.all("a");
    expect(after).toEqual({ ...link, lastOpenedAt: T0 });
    expect(after?.lastSurfacedAt).toBeNull();
    expect(logged).toEqual([]);
  });

  it("refuses another owner's link as not found, changing nothing", async () => {
    const { store, deps } = setup();
    const { link } = await saveLink(deps, "b", URL_A);
    const before = structuredClone(store.all("b"));
    await expect(recordOpening(deps, "a", link.id)).rejects.toMatchObject({ code: "not_found" });
    expect(store.all("b")).toEqual(before);
  });
});

describe("normalizeTitle", () => {
  it("trims, reads blank as no title, takes 200 characters and refuses 201", () => {
    expect(normalizeTitle("  Quokka notes \n")).toBe("Quokka notes");
    expect(normalizeTitle("   ")).toBeNull();
    expect(normalizeTitle(null)).toBeNull();
    expect(normalizeTitle(` ${"a".repeat(200)} `)).toBe("a".repeat(200));
    expect(() => normalizeTitle("a".repeat(201))).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "A title can be at most 200 characters.",
      }),
    );
  });

  it("titleFits agrees with it: trimmed, counted in characters, 200 fits and 201 does not", () => {
    expect(titleFits(` ${"😀".repeat(200)} `)).toBe(true);
    expect(titleFits("😀".repeat(201))).toBe(false);
  });

  it("counts characters, not UTF-16 units: 200 emoji pass", () => {
    expect(normalizeTitle("🦘".repeat(200))).toBe("🦘".repeat(200));
  });
});

describe("titles through saveLink and updateLink", () => {
  const deps = () => ({ store: new FakeStore(), now: () => T0 });

  it("saveLink stores the trimmed title, and refuses 201 characters saving nothing", async () => {
    const d = deps();
    expect((await saveLink(d, "a", { ...URL_A, title: "  Trip  " })).link.title).toBe("Trip");
    await expect(
      saveLink(d, "a", { url: "https://ex.com/b", savedBy: "agent", title: "a".repeat(201) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(d.store.all("a").map((l) => l.url)).toEqual(["https://ex.com/a"]);
  });

  it("updateLink trims, clears a blank title, refuses 201 leaving the title, and never checks a title it is not writing", async () => {
    const d = deps();
    const long = "b".repeat(201);
    const { link } = await d.store.insertIfAbsent("a", { ...newLink(1, T0), title: long });
    expect((await updateLink(d, "a", link.id, { summary: "kept" })).title).toBe(long);
    await expect(updateLink(d, "a", link.id, { title: "c".repeat(201) })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect((await d.store.get("a", link.id))?.title).toBe(long);
    expect((await updateLink(d, "a", link.id, { title: "  New " })).title).toBe("New");
    expect((await updateLink(d, "a", link.id, { title: " " })).title).toBeNull();
  });
});
