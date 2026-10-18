import type { LinkChecker } from "./fetch.js";
import { applyCheck, type CheckVerdict, checkCutoffs, judgeCheck } from "./link-check.js";
import type { DueCheck, LinkCheck, LinkCheckStore } from "./link-check-store.js";
import { isWebUrl } from "./url-key.js";

/** Due links read per sweep. */
export const SWEEP_SIZE = 20;

/** How long the timer waits after a sweep that hit a store error, so a bad row isn't retried every poll. */
export const ERROR_BACKOFF_MS = 60 * 60 * 1000;

export type LinkCheckRunnerOptions = {
  checks: LinkCheckStore;
  checker: LinkChecker;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Time between sweeps. Default 60 s. */
  pollMs?: number;
  /** Time before the next timed sweep after one that hit a store error. Default ERROR_BACKOFF_MS. */
  errorBackoffMs?: number;
  /** Least wall-clock time from one request's end to the next one's start. Default 10 s. */
  gapMs?: number;
  /** Least time, by `now`, before the same host is requested again. Default 60 s. */
  hostGapMs?: number;
};

export type LinkCheckRunner = {
  /** Sweep now and every `pollMs`. */
  start(): void;
  /** Take no new work: stop sweeping. A check in flight carries on and is recorded. */
  quiesce(): void;
  /** Quiesce, abort the check in flight, and wait for the sweep to end. Records nothing for it. */
  stop(): Promise<void>;
  /** Check due links, one at a time. Resolves when it ends. */
  sweep(): Promise<void>;
};

/** A link that isn't a web address is never requested. */
const NOT_WEB: CheckVerdict = { result: "unknown", detail: "refused:scheme" };

/** The host a URL names, lower-cased, or null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Resolves after `ms`, or as soon as `signal` fires. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Checks every saved link again now and then (#128), in the background and apart from the
 * snapshot runner: it holds no `SnapshotStore`, so a check never changes a snapshot. What is due
 * comes from the stored rows (`dueChecks` with core's cutoffs), so a restart loses nothing; the
 * host spacing is kept in memory.
 *
 * Per due link: read its row, check its URL (a name that doesn't resolve asks the checker's canary
 * lookup whether the server is online), judge, `applyCheck`, then `updateCheckIf` against the
 * row read. If the owner changed the row meanwhile, the same verdict is applied once more to the
 * row as it now is. A null write means the link was deleted. Every check is recorded except one
 * aborted by `stop`, so no link stays due forever.
 */
export function createLinkCheckRunner(o: LinkCheckRunnerOptions): LinkCheckRunner {
  const { checks, checker, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 60_000;
  const errorBackoffMs = o.errorBackoffMs ?? ERROR_BACKOFF_MS;
  const gapMs = o.gapMs ?? 10_000;
  const hostGapMs = o.hostGapMs ?? 60_000;

  /** When each host was last requested, by `now`. */
  const requested = new Map<string, number>();
  /** When the last request ended, on the timer clock. */
  let lastEnded: number | null = null;
  const abort = new AbortController();
  /** Fires on quiesce, to end a wait in the request gap. */
  const wake = new AbortController();
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sweep in flight. */
  let running: Promise<void> | undefined;

  /** Waits out `gapMs` since the last request; false when stopped or quiesced meanwhile. */
  async function waitForGap(): Promise<boolean> {
    const wait = lastEnded === null ? 0 : lastEnded + gapMs - performance.now();
    if (wait > 0) await pause(wait, wake.signal);
    return !quiet && !abort.signal.aborted;
  }

  /** Writes the verdict onto `expected`; once more onto the row as it is if that changed meanwhile. */
  async function record(
    due: DueCheck,
    expected: LinkCheck | null,
    verdict: CheckVerdict,
    at: Date,
  ): Promise<void> {
    const first = await checks.updateCheckIf(
      due.owner,
      due.linkId,
      expected,
      applyCheck(expected, verdict, at),
    );
    if (first === null || first.applied) return;
    const again = await checks.updateCheckIf(
      due.owner,
      due.linkId,
      first.check,
      applyCheck(first.check, verdict, at),
    );
    if (again !== null && !again.applied) {
      log(
        `link check ${due.owner}/${due.linkId}: its row changed twice during the check; not recorded`,
      );
    }
  }

  /** Checks one due link and records the verdict. Throws only for a store error. */
  async function checkOne(due: DueCheck, host: string | null): Promise<void> {
    const expected = await checks.getCheck(due.owner, due.linkId);
    if (!isWebUrl(due.url)) {
      await record(due, expected, NOT_WEB, now());
      return;
    }
    if (!(await waitForGap())) return;
    const at = now();
    if (host !== null) requested.set(host, at.getTime());
    const outcome = await checker.check(due.url, abort.signal);
    lastEnded = performance.now();
    const up =
      outcome.kind === "network_error" && outcome.code === "ENOTFOUND"
        ? await checker.canResolve(abort.signal)
        : false;
    if (abort.signal.aborted) return;
    const verdict = judgeCheck(outcome, up);
    if (verdict === null) return;
    await record(due, expected, verdict, at);
  }

  async function scan(): Promise<void> {
    const due = await checks.dueChecks(checkCutoffs(now()), SWEEP_SIZE);
    for (const d of due) {
      if (quiet) return;
      const host = hostOf(d.url);
      const last = host === null ? undefined : requested.get(host);
      if (last !== undefined && now().getTime() - last < hostGapMs) continue;
      await checkOne(d, host);
    }
  }

  /** Resolves true when the sweep ended on a store error. */
  async function sweepOnce(): Promise<boolean> {
    if (quiet) return false;
    let failed = false;
    try {
      await scan();
    } catch (error) {
      log("link check sweep failed", error);
      failed = true;
    }
    return failed;
  }

  /** Runs `work` as the one thing in flight, so `stop` can wait for it and sweeps never overlap. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const prior = running ?? Promise.resolve();
    const mine = prior.then(work);
    const done = mine.then(() => {});
    running = done;
    return mine.finally(() => {
      if (running === done) running = undefined;
    });
  }

  function quiesce(): void {
    quiet = true;
    clearTimeout(timer);
    wake.abort();
  }

  return {
    start() {
      if (started || quiet) return;
      started = true;
      const tick = async () => {
        const failed = await exclusive(sweepOnce);
        if (!quiet) timer = setTimeout(tick, failed ? errorBackoffMs : pollMs);
      };
      void tick();
    },

    quiesce,

    async stop() {
      quiesce();
      abort.abort();
      await running;
    },

    sweep: async () => {
      await exclusive(sweepOnce);
    },
  };
}
