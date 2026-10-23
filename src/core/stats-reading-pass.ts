import { createHash } from "node:crypto";
import { recentFocus } from "./profile.js";
import type { ProfileStore } from "./profile-store.js";
import { capCodePoints } from "./snapshot-text.js";
import { getStats, type Stats } from "./stats.js";
import type { StatsReadingStore } from "./stats-reading-store.js";
import type { StatsStore } from "./stats-store.js";
import type { LinkStore } from "./store.js";
import type { ToolStore } from "./tool-store.js";
import type { OwnerId } from "./types.js";

/** The longest reading the server stores, in code points: two to four plain sentences. */
export const READING_MAX = 600;
/** Time between sweeps: an hour. */
export const READING_POLL_MS = 3_600_000;
/** A reading is due again this long after it was written. */
export const READING_EVERY_MS = 7 * 86_400_000;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 24 * 3_600_000;
const ABORTED = Symbol("aborted");

/** The AI could not be reached. A bad reply is any other error. */
export class StatsReaderUnavailable extends Error {
  override name = "StatsReaderUnavailable";
}

/** Writes the short reading of an owner's stats. Implemented over the one AI connection in `src/ai/`. */
export interface StatsReader {
  read(
    input: { allTime: Stats; lastMonth: Stats; focus: string[] },
    signal: AbortSignal,
  ): Promise<string>;
}

export type StatsReadingPassOptions = {
  readings: StatsReadingStore;
  store: LinkStore;
  tools: ToolStore;
  stats: StatsStore;
  profile: ProfileStore;
  reader: StatsReader;
  /** Stored with each reading, shown as who wrote it. */
  writtenBy: string;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Time between sweeps. Default `READING_POLL_MS`. */
  pollMs?: number;
};

export type StatsReadingPass = {
  /** Sweep now and every `pollMs`. */
  start(): void;
  /** Take no new work: stop sweeping. A sweep in flight carries on. */
  quiesce(): void;
  /** Quiesce, abort the call in flight, and wait for the sweep to end. Writes nothing for that owner. */
  stop(): Promise<void>;
  /** One sweep. Resolves when it ends. */
  sweep(): Promise<void>;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The counts the reading depends on, in a fixed key order. Leaves out `window` and `trackingSince`. */
const counts = (s: Stats) => ({
  saved: s.saved,
  opened: s.opened,
  notOpenedYet: s.notOpenedYet,
  setAside: s.setAside,
  notNow: s.notNow,
  tags: s.tags.map((t) => ({ name: t.name, kind: t.kind, saved: t.saved, opened: t.opened })),
  partialCounts: s.partialCounts,
});

/** What the reading is written from, so an unchanged library is not read again. */
export function readingInputHash(input: {
  allTime: Stats;
  lastMonth: Stats;
  focus: string[];
}): string {
  const stable = {
    allTime: counts(input.allTime),
    lastMonth: counts(input.lastMonth),
    focus: input.focus,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/**
 * Writes, in the background, the AI's short reading of each owner's stats. An owner is due when
 * they have a live link and no reading, or one written `READING_EVERY_MS` ago. A due owner whose
 * stats and recent focus hash as they did for the stored reading is not read again. One call at a
 * time, and a write only while the stored reading is the one that was seen, so a newer one wins.
 *
 * A refused reply (empty, over `READING_MAX`, or a thrown error) or a failed write keeps the old
 * reading and backs that owner off: 60 s, doubling to 24 h, in memory, so a restart tries again.
 * `stop` aborts the call in flight, stops waiting for it, and writes nothing for it, even if it
 * answers later.
 */
export function createStatsReadingPass(o: StatsReadingPassOptions): StatsReadingPass {
  const { readings, reader, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? READING_POLL_MS;

  const failures = new Map<OwnerId, { attempts: number; retryAt: number }>();
  const abort = new AbortController();
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sweep in flight. */
  let running: Promise<void> | undefined;

  /** The call's result, or ABORTED once `stop` is called, whether or not the call heeds it. */
  async function untilAborted<T>(call: Promise<T>): Promise<T | typeof ABORTED> {
    const { signal } = abort;
    let onAbort = () => {};
    const cut = new Promise<typeof ABORTED>((resolve) => {
      onAbort = () => resolve(ABORTED);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    call.catch(() => {}); // a late failure after stop is no one's to handle
    try {
      return await Promise.race([call, cut]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  function fail(owner: OwnerId, why: string, error: unknown): void {
    const attempts = (failures.get(owner)?.attempts ?? 0) + 1;
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    failures.set(owner, { attempts, retryAt: now().getTime() + wait });
    log(
      `stats reading ${JSON.stringify(owner)}: ${why}: ${messageOf(error)} (attempt ${attempts})`,
    );
  }

  /** A well-formed reply: non-empty and within READING_MAX. */
  function checked(reply: string): string {
    const text = reply.trim();
    if (text === "") throw new Error("the reply was empty");
    if (capCodePoints(text, READING_MAX).truncated) throw new Error("the reply was too long");
    return text;
  }

  async function take(owner: OwnerId): Promise<void> {
    const { signal } = abort;
    const failed = failures.get(owner);
    if (failed && now().getTime() < failed.retryAt) return;
    const deps = { store: o.store, tools: o.tools, stats: o.stats, now };
    const [allTime, lastMonth, focus, previous] = await Promise.all([
      getStats(deps, owner, "all"),
      getStats(deps, owner, "30"),
      recentFocus({ profile: o.profile }, owner),
      readings.getReading(owner),
    ]);
    const input = { allTime, lastMonth, focus: focus.map((f) => f.text) };
    const inputHash = readingInputHash(input);
    if (previous && previous.inputHash === inputHash) return;
    let text: string;
    try {
      const reply = await untilAborted((async () => reader.read(input, signal))());
      if (reply === ABORTED || signal.aborted) return;
      text = checked(reply);
    } catch (error) {
      if (!signal.aborted) fail(owner, "could not read the stats", error);
      return;
    }
    try {
      const done = await readings.putReadingIf(owner, previous?.writtenAt ?? null, {
        text,
        writtenBy: o.writtenBy,
        writtenAt: now(),
        inputHash,
      });
      if (done) failures.delete(owner);
    } catch (error) {
      if (!signal.aborted) fail(owner, "a store call failed", error);
    }
  }

  async function sweepOnce(): Promise<void> {
    if (quiet) return;
    try {
      const owners = await readings.readingCandidates(new Date(now().getTime() - READING_EVERY_MS));
      const due = new Set(owners);
      for (const owner of failures.keys()) if (!due.has(owner)) failures.delete(owner);
      for (const owner of owners) {
        if (quiet) return;
        try {
          await take(owner);
        } catch (error) {
          if (abort.signal.aborted) return;
          log(`stats reading ${JSON.stringify(owner)}: a store call failed`, error);
        }
      }
    } catch (error) {
      log("stats reading pass sweep failed", error);
    }
  }

  /** Runs `work` as the one thing in flight, so `stop` can wait for it and sweeps never overlap. */
  function exclusive(work: () => Promise<void>): Promise<void> {
    const prior = running ?? Promise.resolve();
    const mine = prior.then(work);
    running = mine;
    return mine.finally(() => {
      if (running === mine) running = undefined;
    });
  }

  function quiesce(): void {
    quiet = true;
    clearTimeout(timer);
  }

  return {
    start() {
      if (started || quiet) return;
      started = true;
      const tick = async () => {
        await exclusive(sweepOnce);
        if (!quiet) timer = setTimeout(tick, pollMs);
      };
      void tick();
    },
    quiesce,
    async stop() {
      quiesce();
      abort.abort();
      await running;
    },
    sweep: () => exclusive(sweepOnce),
  };
}
