import { FRESHNESS_MS, type MetadataStash } from "./metadata-stash.js";

/** The startup fill gives up after this, so a slow client cannot hold the start past deploy's listen check. */
const FILL_BOUND_MS = 6_000;

const RETRY_MS = 30_000;

/**
 * Keeps the stash current for connected and pending clients: every F/2 it reads the connected
 * set afresh, then fetches each client outside the auth lock. Each fetch gets its own abort
 * controller from the stash; nothing holds a signal for the life of the process.
 */
export function createMetadataRefresher({
  stash,
  readConnected,
  intervalMs = FRESHNESS_MS / 2,
  retryMs = RETRY_MS,
  fillBoundMs = FILL_BOUND_MS,
  log = (error: unknown) => console.error("[oauth] metadata refresh failed:", error),
}: {
  stash: MetadataStash;
  /** The connected CIMD client ids, read under the auth lock. */
  readConnected: () => Promise<Set<string>>;
  intervalMs?: number;
  retryMs?: number;
  fillBoundMs?: number;
  log?: (error: unknown) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let nextAfterFill = intervalMs;

  async function cycle(): Promise<number> {
    try {
      const targets = stash.sync(await readConnected());
      const results = await Promise.all(
        targets.map((id) =>
          stash.refresh(id).catch((error: unknown) => {
            log(error);
            return "failed" as const;
          }),
        ),
      );
      return results.includes("failed") ? retryMs : intervalMs;
    } catch (error) {
      log(error);
      return retryMs;
    }
  }

  function schedule(delayMs: number) {
    if (stopped) return;
    timer = setTimeout(() => {
      running = cycle().then((nextMs) => {
        running = undefined;
        schedule(nextMs);
      });
    }, delayMs);
  }

  return {
    /**
     * One cycle now, for startup. Past the bound the start goes on; the cycle keeps running, and
     * each client is refused until its fetch completes.
     */
    async fill() {
      const done = cycle().then((nextMs) => {
        nextAfterFill = nextMs;
        running = undefined;
      });
      running = done;
      let bound: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<true>((resolve) => {
        bound = setTimeout(() => resolve(true), fillBoundMs);
      });
      try {
        if (await Promise.race([done.then(() => false as const), late])) {
          log(new Error(`the startup metadata fill passed ${fillBoundMs} ms`));
        }
      } finally {
        clearTimeout(bound);
      }
    },
    start: () => schedule(nextAfterFill),
    /** Runs one cycle at once; tests use it in place of waiting F/2. */
    cycle: async (): Promise<void> => {
      await cycle();
    },
    /** Stops the timer, aborts every fetch in flight and waits for the current cycle to end. */
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await stash.close();
      await running;
    },
  };
}

export type MetadataRefresher = ReturnType<typeof createMetadataRefresher>;
