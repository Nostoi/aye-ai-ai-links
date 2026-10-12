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
  quiesce(): void;
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
  /** One per job: a signal shared by every fetch would keep each fetch's wrapper alive. */
  controller: AbortController;
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

  /** Queued and running jobs, by owner and link. */
  const jobs = new Map<string, Job>();
  /** Kicks waiting for a slot; they go before anything due. */
  const queue: Job[] = [];
  /** Jobs holding a slot. */
  const running = new Set<Job>();
  let started = false;
  let quiet = false;
  let stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const keyOf = (owner: OwnerId, linkId: string) => JSON.stringify([owner, linkId]);
  const shutDown = (job: Job) => job.controller.signal.reason === SHUTDOWN;

  function newJob(owner: OwnerId, linkId: string): Job {
    let resolve = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const key = keyOf(owner, linkId);
    const controller = new AbortController();
    const job: Job = { owner, linkId, key, leased: false, controller, promise, resolve };
    jobs.set(key, job);
    return job;
  }

  /** Runs a job in a slot taken before its first await, so no lease can exceed `slots`. */
  function launch(job: Job): void {
    running.add(job);
    attempt(job)
      .catch((err) => log(`snapshot ${job.key}: job failed`, err))
      .finally(() => {
        running.delete(job);
        jobs.delete(job.key);
        job.resolve();
        refill(job.leased);
      });
  }

  /** Kicks first, then due rows: only after a leased job, so a failing store cannot spin. */
  function refill(fromDue: boolean): void {
    if (quiet) return;
    while (running.size < slots) {
      const next = queue.shift();
      if (!next) break;
      launch(next);
    }
    if (fromDue && running.size < slots) void sweep();
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
    const outcome = shutDown(job) ? null : await fetchAndExtract(job, lease.url);
    // A page extracted ok is finished work: record it even when the shutdown came during it.
    const finished = outcome?.stage === "extract" && outcome.extract.kind === "ok";
    if (outcome === null || (shutDown(job) && !finished)) {
      const released = await store.releaseSnapshot(job.owner, job.linkId, lease.claim, now());
      if (!released) log(`snapshot ${job.key}: release refused`);
      return;
    }
    return write(job, lease, snapshotRecord({ outcome, attempts: lease.attempts, now: now() }));
  }

  /** The attempt's outcome, or null for a page fetched after shutdown: it is not extracted. */
  async function fetchAndExtract(job: Job, url: string): Promise<AttemptOutcome | null> {
    const signal = job.controller.signal;
    const fetched = await fetcher.fetch(url, signal);
    if (fetched.kind !== "ok") return { stage: "fetch", fetch: fetched };
    if (shutDown(job)) return null;
    const extract = await extractor.extract(fetched.html, fetched.finalUrl, signal);
    return { stage: "extract", extract };
  }

  async function write(job: Job, lease: SnapshotLease, record: SnapshotRecord): Promise<void> {
    if (!(await store.recordSnapshot(job.owner, job.linkId, lease.claim, record))) {
      log(`snapshot ${job.key}: record refused (lease lost, or status and next time disagree)`);
    }
  }

  async function sweep(): Promise<void> {
    if (quiet || running.size >= slots) return;
    let due: { owner: OwnerId; linkId: string }[];
    try {
      due = await store.dueSnapshots(now(), slots - running.size);
    } catch (err) {
      log("snapshot sweep failed", err);
      return;
    }
    for (const { owner, linkId } of due) {
      if (quiet || running.size >= slots) return;
      if (!jobs.has(keyOf(owner, linkId))) launch(newJob(owner, linkId));
    }
  }

  function quiesce(): void {
    if (quiet) return;
    quiet = true;
    clearTimeout(timer);
    for (const job of queue.splice(0)) {
      jobs.delete(job.key);
      job.resolve();
    }
  }

  return {
    start() {
      if (started || quiet) return;
      started = true;
      const tick = async () => {
        await sweep();
        if (!quiet) timer = setTimeout(tick, pollMs);
      };
      void tick();
    },

    quiesce,

    stop() {
      if (stopping) return stopping;
      quiesce();
      for (const job of running) job.controller.abort(SHUTDOWN);
      stopping = Promise.all([...running].map((j) => j.promise)).then(() => {});
      return stopping;
    },

    kick(owner, linkId) {
      if (quiet) return Promise.resolve();
      const existing = jobs.get(keyOf(owner, linkId));
      if (existing) return existing.promise;
      const job = newJob(owner, linkId);
      if (running.size < slots) launch(job);
      else queue.push(job);
      return job.promise;
    },

    sweep,
  };
}
