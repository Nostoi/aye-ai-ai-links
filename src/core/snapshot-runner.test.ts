import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractOutcome } from "./extract.js";
import { FakeStore } from "./fake-store.js";
import type { FetchOutcome } from "./fetch.js";
import type { CopyKeeper } from "./keep-copy.js";
import type { CopyDraft } from "./saved-copy.js";
import { MAX_ATTEMPTS } from "./snapshot-outcome.js";
import { createSnapshotRunner, type SnapshotRunner } from "./snapshot-runner.js";
import type { SnapshotRecord } from "./snapshot-store.js";
import { A, at, B, newLink } from "./snapshot-store-contract.js";

const pageOk: ExtractOutcome = {
  kind: "ok",
  metadata: { title: "T", description: null, imageUrl: null },
  text: "body",
};

/** A fake fetch or extract step: held calls wait for `finish`, and a caller's abort ends them. */
function step<T>(name: string, order: string[], ok: (arg: string) => T, aborted: T) {
  const s = {
    hold: false,
    /** Log an abort but keep the call held, like a step that finishes just after it. */
    ignoreAbort: false,
    calls: [] as { arg: string; finish(v?: T): void }[],
    run(arg: string, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve) => {
        let done = false;
        const finish = (v: T = ok(arg)) => {
          if (!done) resolve(v);
          done = true;
        };
        const abort = () => {
          if (!done) order.push(`${name}:abort`);
          if (!s.ignoreAbort) finish(aborted);
        };
        s.calls.push({ arg, finish });
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
        if (!s.hold) finish();
      });
    },
    async close() {
      order.push(`${name}:close`);
    },
  };
  return s;
}

const runners: SnapshotRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.stop()));
});

function setup(
  opts: { slots?: number; leaseMs?: number; pollMs?: number; copies?: CopyKeeper } = {},
) {
  const store = new FakeStore();
  const order: string[] = [];
  const h = {
    store,
    order,
    clock: at(1000),
    leases: [] as { owner: string; linkId: string; now: Date; until: Date }[],
    records: [] as { owner: string; linkId: string; rec: SnapshotRecord }[],
    releases: [] as string[],
    /** Jobs between their lease call and its end (refused, recorded or released). */
    open: 0,
    maxOpen: 0,
    leaseGate: null as Promise<void> | null,
    rawLease: store.leaseSnapshot.bind(store),
    log: vi.fn(),
    extractOptions: [] as ({ copy?: boolean } | undefined)[],
    fetch: step<FetchOutcome>(
      "fetch",
      order,
      (url) => ({ kind: "ok", finalUrl: url, contentType: "text/html", html: "<p>" }),
      { kind: "aborted" },
    ),
    extract: step<ExtractOutcome>("extract", order, () => pageOk, { kind: "aborted" }),
    save: async (owner: string, n: number, savedAt = at(0)) =>
      (await store.insertIfAbsent(owner, newLink(n, savedAt))).link,
  };
  const end = () => h.open--;
  const realRecord = store.recordSnapshot.bind(store);
  const realRelease = store.releaseSnapshot.bind(store);
  store.leaseSnapshot = async (owner, linkId, now, until) => {
    h.leases.push({ owner, linkId, now, until });
    h.maxOpen = Math.max(h.maxOpen, ++h.open);
    if (h.leaseGate) await h.leaseGate;
    const lease = await h.rawLease(owner, linkId, now, until);
    if (!lease) end();
    return lease;
  };
  store.recordSnapshot = async (owner, linkId, claim, rec) => {
    h.records.push({ owner, linkId, rec });
    end();
    return realRecord(owner, linkId, claim, rec);
  };
  store.releaseSnapshot = async (owner, linkId, claim, now) => {
    h.releases.push(linkId);
    end();
    return realRelease(owner, linkId, claim, now);
  };
  const runner = createSnapshotRunner({
    store,
    fetcher: { fetch: (u, s) => h.fetch.run(u, s), close: () => h.fetch.close() },
    extractor: {
      extract: (html, _u, s, options) => {
        h.extractOptions.push(options);
        return h.extract.run(html, s);
      },
      close: () => h.extract.close(),
    },
    now: () => new Date(h.clock),
    log: h.log,
    ...opts,
  });
  runners.push(runner);
  return Object.assign(h, { runner });
}

/** Lease a link n times directly, letting each lease lapse, so the runner's lease is n + 1. */
async function useAttempts(s: ReturnType<typeof setup>, linkId: string, n: number) {
  for (let i = 0; i < n; i++) await s.rawLease(A, linkId, at(i), new Date(at(i).getTime() + 1));
}

const finishHeld = (calls: { finish(): void }[]) => {
  for (const c of calls) c.finish();
};

/** Collect unhandled rejections until `off()`. */
function listenUnhandled() {
  const unhandled: unknown[] = [];
  const on = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", on);
  return { unhandled, off: () => process.off("unhandledRejection", on) };
}

describe("snapshot runner", () => {
  it("runs at most 2 jobs at once across sweeps and kicks, and finishes them all", async () => {
    const s = setup();
    const links = await Promise.all([1, 2, 3, 4, 5].map((n) => s.save(A, n)));
    s.fetch.hold = true;
    await s.runner.sweep();
    await vi.waitFor(() => expect(s.fetch.calls).toHaveLength(2));
    const kicks = links.slice(3).map((l) => s.runner.kick(A, l.id));
    expect(s.open).toBe(2);
    s.fetch.hold = false;
    finishHeld(s.fetch.calls);
    await Promise.all(kicks);
    await vi.waitFor(() => expect(s.records).toHaveLength(5));
    expect(s.maxOpen).toBe(2);
    expect(s.records.every((r) => r.rec.status === "ok")).toBe(true);
  });

  it("a kick on a link the sweep is running joins that job: one fetch", async () => {
    const s = setup();
    const link = await s.save(A, 1);
    s.fetch.hold = true;
    await s.runner.sweep();
    await vi.waitFor(() => expect(s.fetch.calls).toHaveLength(1));
    const kicked = s.runner.kick(A, link.id);
    expect(s.runner.kick(A, link.id)).toBe(kicked);
    let settled = false;
    void kicked.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    s.fetch.calls[0]?.finish();
    await kicked;
    expect(s.records).toHaveLength(1);
    expect(s.fetch.calls).toHaveLength(1);
    expect(s.leases).toHaveLength(1);
  });

  it("a kick goes ahead of a 50-row backlog", async () => {
    const s = setup();
    for (let n = 1; n <= 50; n++) await s.save(A, n, at(n));
    const late = await s.save(A, 99, at(500));
    s.fetch.hold = true;
    await s.runner.sweep();
    await vi.waitFor(() => expect(s.fetch.calls).toHaveLength(2));
    void s.runner.kick(A, late.id);
    s.fetch.calls[0]?.finish();
    await vi.waitFor(() => expect(s.fetch.calls).toHaveLength(3));
    expect(s.fetch.calls[2]?.arg).toBe(late.url);
  });

  it("leases for 120 s by default, and refuses a lease shorter than 55 s", async () => {
    const s = setup();
    const link = await s.save(A, 1);
    await s.runner.kick(A, link.id);
    expect(s.leases.map((l) => l.until.getTime() - l.now.getTime())).toEqual([120_000]);
    expect(() => setup({ leaseMs: 54_999 })).toThrow(RangeError);
    expect(() => setup({ leaseMs: 55_000 })).not.toThrow();
  });

  it.each(["fetch", "extract"] as const)(
    "stop() during the %s gives the attempt back and leaves the row due",
    async (stage) => {
      const s = setup();
      const link = await s.save(A, 1);
      s[stage].hold = true;
      const job = s.runner.kick(A, link.id);
      await vi.waitFor(() => expect(s[stage].calls).toHaveLength(1));
      await s.runner.stop();
      await job;
      expect(s.order).toEqual([`${stage}:abort`]);
      expect(s.records).toEqual([]);
      expect(s.releases).toEqual([link.id]);
      expect(await s.store.dueSnapshots(s.clock, 10)).toEqual([{ owner: A, linkId: link.id }]);
      expect((await s.rawLease(A, link.id, s.clock, at(2000)))?.attempts).toBe(1);
    },
  );

  it("an extraction that ends ok after stop() is recorded, not thrown away", async () => {
    const s = setup();
    const link = await s.save(A, 1);
    s.extract.hold = true;
    s.extract.ignoreAbort = true;
    void s.runner.kick(A, link.id);
    await vi.waitFor(() => expect(s.extract.calls).toHaveLength(1));
    const stopped = s.runner.stop();
    s.extract.calls[0]?.finish();
    await stopped;
    expect(s.order).toEqual(["extract:abort"]);
    expect(s.releases).toEqual([]);
    expect(s.records.map((r) => [r.rec.status, r.rec.attempts])).toEqual([["ok", 1]]);
  });

  it("a fetch that ends ok after stop() is given back without extracting", async () => {
    const s = setup();
    const link = await s.save(A, 1);
    s.fetch.hold = true;
    s.fetch.ignoreAbort = true;
    void s.runner.kick(A, link.id);
    await vi.waitFor(() => expect(s.fetch.calls).toHaveLength(1));
    const stopped = s.runner.stop();
    s.fetch.calls[0]?.finish();
    await stopped;
    expect(s.extract.calls).toHaveLength(0);
    expect(s.records).toEqual([]);
    expect(s.releases).toEqual([link.id]);
  });

  it("start() sweeps at once and every pollMs, and stop() leaves no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const s = setup({ pollMs: 1000 });
      const first = await s.save(A, 1);
      const later = await s.save(A, 2, at(2000));
      s.runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.leases.map((l) => l.linkId)).toEqual([first.id]);
      s.clock = at(3000);
      await vi.advanceTimersByTimeAsync(999);
      expect(s.leases).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.leases.map((l) => l.linkId)).toEqual([first.id, later.id]);
      await s.save(A, 3, at(4000));
      s.clock = at(5000);
      await s.runner.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(s.leases).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("quiesce() lets a running job finish and record, and starts nothing new", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const s = setup({ pollMs: 1000, slots: 1 });
      const running = await s.save(A, 1);
      const queued = await s.save(A, 2);
      const late = await s.save(A, 3);
      s.extract.hold = true;
      s.runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.extract.calls).toHaveLength(1);
      let queuedSettled = false;
      void s.runner.kick(A, queued.id).then(() => {
        queuedSettled = true;
      });
      s.runner.quiesce();
      void s.runner.kick(A, late.id);
      s.extract.calls[0]?.finish();
      await vi.advanceTimersByTimeAsync(5000);
      await new Promise((r) => setImmediate(r));
      expect(queuedSettled).toBe(true);
      expect(s.order).toEqual([]);
      expect(s.releases).toEqual([]);
      expect(s.records.map((r) => [r.linkId, r.rec.status])).toEqual([[running.id, "ok"]]);
      expect(s.leases.map((l) => l.linkId)).toEqual([running.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["fetch", "extract"] as const)(
    "an abort that is not a shutdown, in the %s, uses up the attempt",
    async (stage) => {
      const s = setup();
      const link = await s.save(A, 1);
      s[stage].hold = true;
      const job = s.runner.kick(A, link.id);
      await vi.waitFor(() => expect(s[stage].calls).toHaveLength(1));
      s[stage].calls[0]?.finish({ kind: "aborted" });
      await job;
      expect(s.releases).toEqual([]);
      expect(s.records.map((r) => [r.rec.status, r.rec.attempts, r.rec.lastError])).toEqual([
        ["retrying", 1, `${stage}:aborted`],
      ]);
    },
  );

  it("a lease past the last attempt records failed without fetching", async () => {
    const s = setup();
    const link = await s.save(A, 1);
    await useAttempts(s, link.id, MAX_ATTEMPTS);
    await s.runner.kick(A, link.id);
    expect(s.fetch.calls).toHaveLength(0);
    expect(s.records.map((r) => [r.rec.status, r.rec.attempts, r.rec.lastError])).toEqual([
      ["failed", MAX_ATTEMPTS + 1, "lease:expired"],
    ]);
  });

  it("the last allowed attempt still fetches", async () => {
    const s = setup();
    const link = await s.save(A, 1);
    await useAttempts(s, link.id, MAX_ATTEMPTS - 1);
    await s.runner.kick(A, link.id);
    expect(s.fetch.calls).toHaveLength(1);
    expect(s.records.map((r) => [r.rec.status, r.rec.attempts])).toEqual([["ok", MAX_ATTEMPTS]]);
  });

  it("a store that throws is logged, never an unhandled rejection, and the next job runs", async () => {
    const { unhandled, off } = listenUnhandled();
    try {
      const s = setup({ slots: 1 });
      await s.save(A, 1);
      const second = await s.save(A, 2, at(1));
      const record = s.store.recordSnapshot.bind(s.store);
      let thrown = false;
      s.store.recordSnapshot = async (...args) => {
        if (thrown) return record(...args);
        thrown = true;
        throw new Error("disk full");
      };
      await s.runner.sweep();
      await vi.waitFor(() => expect(s.records.map((r) => r.linkId)).toContain(second.id));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
      expect(s.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ message: "disk full" }),
      );
    } finally {
      off();
    }
  });

  it("a sweep whose store throws is logged, and polling carries on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { unhandled, off } = listenUnhandled();
    try {
      const s = setup({ pollMs: 1000 });
      let sweeps = 0;
      s.store.dueSnapshots = async () => {
        sweeps++;
        throw new Error("db locked");
      };
      s.runner.start();
      await vi.advanceTimersByTimeAsync(2000);
      await new Promise((r) => setImmediate(r));
      expect(sweeps).toBe(3);
      expect(unhandled).toEqual([]);
      expect(s.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ message: "db locked" }),
      );
    } finally {
      off();
      vi.useRealTimers();
    }
  });

  it("a lease that always throws does not spin: no new lease until the next poll", async () => {
    const s = setup();
    await Promise.all([1, 2, 3].map((n) => s.save(A, n)));
    let leaseCalls = 0;
    s.rawLease = async () => {
      leaseCalls++;
      throw new Error("db locked");
    };
    const due = s.store.dueSnapshots.bind(s.store);
    s.store.dueSnapshots = async (now, limit) => (leaseCalls > 20 ? [] : due(now, limit));
    await s.runner.sweep();
    await new Promise((r) => setImmediate(r));
    expect(leaseCalls).toBe(2);
    await s.runner.stop();
  });

  it("writes each snapshot with its own owner, and a foreign kick leases nothing", async () => {
    const s = setup();
    const a = await s.save(A, 1);
    const b = await s.save(B, 2);
    await s.runner.kick(B, a.id);
    expect(s.fetch.calls).toHaveLength(0);
    await s.runner.sweep();
    await vi.waitFor(() => expect(s.records).toHaveLength(2));
    expect(s.records.map((r) => [r.owner, r.linkId]).sort()).toEqual([
      [A, a.id],
      [B, b.id],
    ]);
    expect((await s.store.get(A, a.id))?.snapshot?.status).toBe("ok");
    expect((await s.store.get(B, b.id))?.snapshot?.status).toBe("ok");
  });

  it("a sweep over two owners' due links leaves each page's title and text on its own link, and B's finish changes nothing of A's", async () => {
    const s = setup();
    s.fetch.hold = true;
    s.extract.hold = true;
    const a = await s.save(A, 1);
    const b = await s.save(B, 2);
    await s.runner.sweep();
    await vi.waitFor(() => expect(s.fetch.calls).toHaveLength(2));
    const read = async (owner: string, id: string) => ({
      link: (await s.store.get(owner, id))?.snapshot,
      text: await s.store.getSnapshotText(owner, id),
    });
    const finishPage = async (url: string) => {
      s.fetch.calls
        .find((c) => c.arg === url)
        ?.finish({ kind: "ok", finalUrl: url, contentType: "text/html", html: url });
      await vi.waitFor(() => expect(s.extract.calls.some((c) => c.arg === url)).toBe(true));
      s.extract.calls
        .find((c) => c.arg === url)
        ?.finish({
          kind: "ok",
          metadata: { title: `title of ${url}`, description: null, imageUrl: null },
          text: `text of ${url}`,
        });
    };

    await finishPage(a.url);
    await vi.waitFor(() => expect(s.records).toHaveLength(1));
    const aDone = await read(A, a.id);
    expect(aDone.text).toBe(`text of ${a.url}`);
    expect((await read(B, b.id)).text).toBeNull();

    await finishPage(b.url);
    await vi.waitFor(() => expect(s.records).toHaveLength(2));

    expect(s.records.map((r) => [r.owner, r.linkId]).sort()).toEqual([
      [A, a.id],
      [B, b.id],
    ]);
    expect(await read(A, a.id)).toEqual(aDone);
    expect(await read(B, b.id)).toMatchObject({
      link: { title: `title of ${b.url}` },
      text: `text of ${b.url}`,
    });
  });

  it("a kick after stop resolves at once and leases nothing", async () => {
    const s = setup();
    const first = await s.save(A, 1);
    const second = await s.save(A, 2);
    await s.runner.kick(A, first.id);
    await s.runner.stop();
    await s.runner.kick(A, second.id);
    expect(s.leases.map((l) => l.linkId)).toEqual([first.id]);
  });

  it("stop() settles 2 running and 3 queued kicks, and the queued ones never lease", async () => {
    const s = setup();
    const links = await Promise.all([1, 2, 3, 4, 5].map((n) => s.save(A, n)));
    s.fetch.hold = true;
    const kicks = links.map((l) => s.runner.kick(A, l.id));
    await vi.waitFor(() => expect(s.fetch.calls).toHaveLength(2));
    await s.runner.stop();
    await Promise.all(kicks);
    const running = links.slice(0, 2).map((l) => l.id);
    expect(s.leases.map((l) => l.linkId)).toEqual(running);
    expect(new Set(s.releases)).toEqual(new Set(running));
  });

  it("a stop while the lease is pending gives it back without fetching", async () => {
    const s = setup();
    const link = await s.save(A, 1);
    let openGate = () => {};
    s.leaseGate = new Promise((r) => {
      openGate = r;
    });
    const job = s.runner.kick(A, link.id);
    const stopped = s.runner.stop();
    openGate();
    await Promise.all([job, stopped]);
    expect(s.fetch.calls).toHaveLength(0);
    expect(s.releases).toEqual([link.id]);
  });

  it("reserves its slot before the lease: overlapping sweeps and kicks hold at most 2", async () => {
    const s = setup();
    const links = await Promise.all([1, 2, 3, 4, 5].map((n) => s.save(A, n)));
    let openGate = () => {};
    s.leaseGate = new Promise((r) => {
      openGate = r;
    });
    const sweeps = [s.runner.sweep(), s.runner.sweep()];
    const kicks = links.slice(2).map((l) => s.runner.kick(A, l.id));
    await Promise.all([...sweeps, s.runner.sweep()]);
    expect(s.open).toBe(2);
    openGate();
    await Promise.all(kicks);
    await vi.waitFor(() => expect(s.records).toHaveLength(5));
    expect(s.maxOpen).toBe(2);
  });

  it("refills a freed slot at once, without waiting for the poll", async () => {
    const s = setup();
    await Promise.all([1, 2, 3].map((n) => s.save(A, n)));
    s.fetch.hold = true;
    await s.runner.sweep();
    await vi.waitFor(() => expect(s.fetch.calls).toHaveLength(2));
    s.fetch.calls[0]?.finish();
    await vi.waitFor(() => expect(s.fetch.calls).toHaveLength(3));
  });

  it("the default log prints a message without a trailing undefined", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = new FakeStore();
      const link = (await store.insertIfAbsent(A, newLink(1, at(0)))).link;
      store.recordSnapshot = async () => false;
      const runner = createSnapshotRunner({
        store,
        fetcher: { fetch: async () => ({ kind: "timeout" }), close: async () => {} },
        extractor: { extract: async () => pageOk, close: async () => {} },
        now: () => at(1000),
      });
      await runner.kick(A, link.id);
      expect(spy.mock.calls).toEqual([[expect.stringContaining("record refused")]]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("snapshot runner saved copies", () => {
  const draft: CopyDraft = { markdown: "# T", imageUrls: [], nonce: "0".repeat(32) };
  const withCopy = (copy?: CopyDraft | null): ExtractOutcome => ({
    ...pageOk,
    ...(copy === undefined ? {} : { copy }),
  });
  const keeper = (wanted = true) => ({
    wanted,
    keep: vi.fn<CopyKeeper["keep"]>(async () => "saved"),
    refuse: vi.fn<CopyKeeper["refuse"]>(async () => false),
  });

  it("asks the extractor for a copy only when the keeper wants one", async () => {
    const none = setup();
    await none.runner.kick(A, (await none.save(A, 1)).id);
    expect(none.extractOptions).toEqual([{ copy: false }]);
    const off = setup({ copies: keeper(false) });
    await off.runner.kick(A, (await off.save(A, 1)).id);
    expect(off.extractOptions).toEqual([{ copy: false }]);
    const on = setup({ copies: keeper() });
    await on.runner.kick(A, (await on.save(A, 1)).id);
    expect(on.extractOptions).toEqual([{ copy: true }]);
  });

  it("keeps the draft once the snapshot is recorded", async () => {
    const copies = keeper();
    const s = setup({ copies });
    const link = await s.save(A, 1);
    // Seen outside the mock: the runner's catch would swallow an expect thrown inside it.
    let recordedBefore = -1;
    copies.keep.mockImplementation(async () => {
      recordedBefore = s.records.length;
      return "saved";
    });
    s.extract.run = async () => withCopy(draft);
    await s.runner.kick(A, link.id);
    expect(recordedBefore).toBe(1);
    expect(copies.keep).toHaveBeenCalledTimes(1);
    expect(copies.keep).toHaveBeenCalledWith(A, link.id, draft);
    expect(s.records.map((r) => r.rec.status)).toEqual(["ok"]);
  });

  it.each([
    ["no copy asked", withCopy()],
    ["no article", withCopy(null)],
    ["a failed extract", { kind: "aborted" } as ExtractOutcome],
  ])("does not keep for %s", async (_name, outcome) => {
    const copies = keeper();
    const s = setup({ copies });
    s.extract.run = async () => outcome;
    await s.runner.kick(A, (await s.save(A, 1)).id);
    expect(s.records).toHaveLength(1);
    expect(copies.keep).not.toHaveBeenCalled();
  });

  it("does not keep when the record is refused", async () => {
    const copies = keeper();
    const s = setup({ copies });
    const link = await s.save(A, 1);
    s.extract.run = async () => withCopy(draft);
    s.store.recordSnapshot = async () => false;
    await s.runner.kick(A, link.id);
    expect(copies.keep).not.toHaveBeenCalled();
  });

  it("logs a keep that throws, and carries on", async () => {
    const copies = keeper();
    const s = setup({ copies, slots: 1 });
    const [one, two] = [await s.save(A, 1), await s.save(A, 2)];
    const boom = new Error("boom");
    copies.keep.mockRejectedValueOnce(boom);
    s.extract.run = async () => withCopy(draft);
    await s.runner.kick(A, one.id);
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining("saved copy failed"), boom);
    expect(s.records).toHaveLength(1);
    await s.runner.kick(A, two.id);
    expect(copies.keep).toHaveBeenCalledTimes(2);
    expect(s.records).toHaveLength(2);
  });

  it("logs a folder that is not ready", async () => {
    const copies = keeper();
    copies.keep.mockResolvedValue("unavailable");
    const s = setup({ copies });
    s.extract.run = async () => withCopy(draft);
    await s.runner.kick(A, (await s.save(A, 1)).id);
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining("folder is not ready"));
    expect(s.records).toHaveLength(1);
  });

  it.each([
    ["a draft", withCopy(draft), 1],
    ["no copy", withCopy(), 0],
  ])("after stop() during extraction, an ok with %s is recorded", async (_n, outcome, kept) => {
    const copies = keeper();
    const s = setup({ copies });
    const link = await s.save(A, 1);
    s.extract.hold = true;
    s.extract.ignoreAbort = true;
    void s.runner.kick(A, link.id);
    await vi.waitFor(() => expect(s.extract.calls).toHaveLength(1));
    const stopped = s.runner.stop();
    s.extract.calls[0]?.finish(outcome);
    await stopped;
    expect(s.records.map((r) => r.rec.status)).toEqual(["ok"]);
    expect(copies.keep).toHaveBeenCalledTimes(kept);
  });
});
