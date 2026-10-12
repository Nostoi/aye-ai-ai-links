import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractOutcome } from "./extract.js";
import { FakeStore } from "./fake-store.js";
import type { FetchOutcome } from "./fetch.js";
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
          finish(aborted);
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

function setup(opts: { slots?: number; leaseMs?: number } = {}) {
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
    extractor: { extract: (html, _u, s) => h.extract.run(html, s), close: () => h.extract.close() },
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
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
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
      process.off("unhandledRejection", onUnhandled);
    }
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
});
