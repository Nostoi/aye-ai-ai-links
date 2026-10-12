import type { PageExtractor } from "./extract.js";
import type { PageFetcher } from "./fetch.js";
import {
  type AttemptOutcome,
  pastLastAttempt,
  pastLastAttemptRecord,
  snapshotRecord,
} from "./snapshot-outcome.js";
import type { SnapshotLease, SnapshotRecord, SnapshotStore } from "./snapshot-store.js";
import type { OwnerId } from "./types.js";

/** The shortest lease that outlasts a fetch (15 s) and two extractions (2 × 20 s). */
export const MIN_LEASE_MS = 55_000;

/** The abort reason of `stop()`. Only this abort gives an attempt back; any other is a retry. */
const SHUTDOWN = Symbol("snapshot runner stopped");

export type SnapshotRunnerOptions = {
  store: SnapshotStore;
  fetcher: PageFetcher;
  extractor: PageExtractor;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** How long a job holds its snapshot; at least `MIN_LEASE_MS`. Default 120 s. */
  leaseMs?: number;
  /** Time between sweeps for retries and expired leases. Default 30 s. */
  pollMs?: number;
  /** Jobs at once, sweeps and kicks together. Default 2. */
  slots?: number;
};

export type SnapshotRunner = {
  /** Sweep now, then every `pollMs`. */
  start(): void;
  /**
   * Stop sweeping, refuse kicks, abort running jobs and wait for them. An aborted job gives its
   * attempt back, unless its page was already extracted ok: that one is recorded.
   */
  stop(): Promise<void>;
  /**
   * Fetch this link ahead of the backlog. Resolves when its job ends; a link already queued or
   * running shares that job. Resolves at once when stopped or when the lease is refused.
   */
  kick(owner: OwnerId, linkId: string): Promise<void>;
  /** Start due snapshots in the free slots. Resolves once they are started, not finished. */
  sweep(): Promise<void>;
};

type Job = {
  owner: OwnerId;
  linkId: string;
  key: string;
  leased: boolean;
  promise: Promise<void>;
  resolve: () => void;
};

/** Takes due snapshots from the store, fetches and extracts them, and records the outcome. */
export function createSnapshotRunner(o: SnapshotRunnerOptions): SnapshotRunner {
  const { store, fetcher, extractor, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const leaseMs = o.leaseMs ?? 120_000;
  const pollMs = o.pollMs ?? 30_000;
  const slots = o.slots ?? 2;
  if (leaseMs < MIN_LEASE_MS)
    throw new RangeError(`A lease must last at least ${MIN_LEASE_MS} ms.`);

  const controller = new AbortController();
  /** Queued and running jobs, by owner and link. */
  const jobs = new Map<string, Job>();
  /** Kicks waiting for a slot; they go before anything due. */
  const queue: Job[] = [];
  let active = 0;
  let started = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const keyOf = (owner: OwnerId, linkId: string) => JSON.stringify([owner, linkId]);
  const shutDown = () => controller.signal.reason === SHUTDOWN;

  function newJob(owner: OwnerId, linkId: string): Job {
    let resolve = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const job = { owner, linkId, key: keyOf(owner, linkId), leased: false, promise, resolve };
    jobs.set(job.key, job);
    return job;
  }

  /** Runs a job in a slot taken before its first await, so no lease can exceed `slots`. */
  function launch(job: Job): void {
    active++;
    attempt(job)
      .catch((err) => log(`snapshot ${job.key}: job failed`, err))
      .finally(() => {
        active--;
        jobs.delete(job.key);
        job.resolve();
        refill(job.leased);
      });
  }

  /** Kicks first, then due rows: only after a leased job, so a failing store cannot spin. */
  function refill(fromDue: boolean): void {
    if (stopped) return;
    while (active < slots) {
      const next = queue.shift();
      if (!next) break;
      launch(next);
    }
    if (fromDue && active < slots) void sweep();
  }

  async function attempt(job: Job): Promise<void> {
    const t = now();
    const lease = await store.leaseSnapshot(
      job.owner,
      job.linkId,
      t,
      new Date(t.getTime() + leaseMs),
    );
    if (!lease) return;
    job.leased = true;
    if (pastLastAttempt(lease.attempts)) {
      return write(job, lease, pastLastAttemptRecord(lease.attempts));
    }
    const outcome = shutDown() ? null : await fetchAndExtract(lease.url);
    // A page extracted ok is finished work: record it even when the shutdown came during it.
    const finished = outcome?.stage === "extract" && outcome.extract.kind === "ok";
    if (outcome === null || (shutDown() && !finished)) {
      const released = await store.releaseSnapshot(job.owner, job.linkId, lease.claim, now());
      if (!released) log(`snapshot ${job.key}: release refused`);
      return;
    }
    return write(job, lease, snapshotRecord({ outcome, attempts: lease.attempts, now: now() }));
  }

  /** The attempt's outcome, or null for a page fetched after shutdown: it is not extracted. */
  async function fetchAndExtract(url: string): Promise<AttemptOutcome | null> {
    const signal = controller.signal;
    const fetched = await fetcher.fetch(url, signal);
    if (fetched.kind !== "ok") return { stage: "fetch", fetch: fetched };
    if (shutDown()) return null;
    const extract = await extractor.extract(fetched.html, fetched.finalUrl, signal);
    return { stage: "extract", extract };
  }

  async function write(job: Job, lease: SnapshotLease, record: SnapshotRecord): Promise<void> {
    if (!(await store.recordSnapshot(job.owner, job.linkId, lease.claim, record))) {
      log(`snapshot ${job.key}: record refused (lease lost, or status and next time disagree)`);
    }
  }

  async function sweep(): Promise<void> {
    if (stopped || active >= slots) return;
    let due: { owner: OwnerId; linkId: string }[];
    try {
      due = await store.dueSnapshots(now(), slots - active);
    } catch (err) {
      log("snapshot sweep failed", err);
      return;
    }
    for (const { owner, linkId } of due) {
      if (stopped || active >= slots) return;
      if (!jobs.has(keyOf(owner, linkId))) launch(newJob(owner, linkId));
    }
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      const tick = async () => {
        await sweep();
        if (!stopped) timer = setTimeout(tick, pollMs);
      };
      void tick();
    },

    stop() {
      if (stopping) return stopping;
      stopped = true;
      clearTimeout(timer);
      controller.abort(SHUTDOWN);
      for (const job of queue.splice(0)) {
        jobs.delete(job.key);
        job.resolve();
      }
      stopping = Promise.all([...jobs.values()].map((j) => j.promise)).then(() => {});
      return stopping;
    },

    kick(owner, linkId) {
      if (stopped) return Promise.resolve();
      const existing = jobs.get(keyOf(owner, linkId));
      if (existing) return existing.promise;
      const job = newJob(owner, linkId);
      if (active < slots) launch(job);
      else queue.push(job);
      return job.promise;
    },

    sweep,
  };
}
