import type { GuessCandidate, IntentGuesses, LinkStore } from "./store.js";
import type { Link, OwnerId, Source } from "./types.js";

/** Links per call. */
export const GUESS_BATCH = 25;
/** Links per call when a batch has failed before, so one bad link spoils few others. */
export const GUESS_RETRY_BATCH = 5;
/** The most links one reply may name. More is a failed reply, so one injected page turns at most this many. */
export const GUESS_KEEP_MAX = 8;
/** Failed batches a link takes part in before it ends `failed`, staying To explore. */
const MAX_TRIES = 3;
/** Failed batches in a row after which the pass pauses. */
const PAUSE_AFTER = 3;
const BATCH_BACKOFF_BASE_MS = 60_000;
const BATCH_BACKOFF_MAX_MS = 24 * 3_600_000;
const PAUSE_BASE_MS = 60_000;
const PAUSE_MAX_MS = 3_600_000;
const PAGE_SIZE = 100;

/** The AI could not be reached. A bad reply is any other error. */
export class IntentGuesserUnavailable extends Error {
  override name = "IntentGuesserUnavailable";
}

/** What one link sends to the model: no page text. */
export type GuessLink = {
  title: string;
  site: string;
  path: string;
  tags: { name: string; pinned: boolean }[];
  why: { text: string; source: Source } | null;
  summary: string | null;
};

/** Picks the links that are clearly To keep. Implemented over the one AI connection in `src/ai/`. */
export interface IntentGuesser {
  /** The 1-based positions in `links` the model named. */
  guess(links: GuessLink[], signal: AbortSignal): Promise<number[]>;
}

export type IntentPassOptions = {
  store: LinkStore & IntentGuesses;
  guesser: IntentGuesser;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Time between sweeps. Default 60 s. */
  pollMs?: number;
  /** Time between calls. Default 5 s. */
  gapMs?: number;
};

export type IntentPass = {
  /** Sweep now and every `pollMs` until no row is undecided. */
  start(): void;
  /** Take no new work: stop sweeping. A sweep in flight carries on. */
  quiesce(): void;
  /** Quiesce, abort the call in flight, and wait for the sweep to end. Writes nothing for that call. */
  stop(): Promise<void>;
  /** One sweep. Resolves when it ends. */
  sweep(): Promise<void>;
};

const doubling = (base: number, max: number, n: number) => Math.min(base * 2 ** (n - 1), max);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const keyOf = (c: GuessCandidate) => JSON.stringify([c.owner, c.id]);

function material(link: Link, pinned: Set<string>): GuessLink {
  let site = link.url;
  let path = "";
  try {
    const url = new URL(link.url);
    site = url.hostname;
    path = url.pathname;
  } catch {}
  return {
    title: link.title ?? "",
    site,
    path,
    tags: link.tags.map((t) => ({ name: t.name, pinned: pinned.has(t.key) })),
    why: link.why ? { text: link.why.text, source: link.why.source } : null,
    summary: link.summary,
  };
}

/** The numbers a reply names, once each, or an error when one is outside 1..`count` or there are too many. */
function checked(reply: number[], count: number): Set<number> {
  const named = new Set(reply);
  for (const n of named) {
    if (!Number.isInteger(n) || n < 1 || n > count) {
      throw new Error(`the reply named ${n}, outside 1 to ${count}`);
    }
  }
  if (named.size > GUESS_KEEP_MAX) {
    throw new Error(`the reply named ${named.size} links, over the limit of ${GUESS_KEEP_MAX}`);
  }
  return named;
}

/**
 * The one-off pass that guesses To keep for the links the migration queued (#339). It sends up to
 * 25 links of one owner per call, one call at a time with a gap, and writes keep/inferred only for
 * the links the reply names and only while nobody has spoken for them. Every queued link ends
 * `keep`, `not_keep` or `failed`; nothing but a model's "clearly To keep" changes a link.
 *
 * A reply that is not the expected shape, names a link that is not in the batch, names more than 8,
 * or is cut off counts as a failed batch: nothing is written, each link in it gains a try and backs
 * off in memory (60 s, doubling to 24 h) while later batches go ahead. A link with 3 tries ends
 * `failed`; a link that has failed is retried 5 to a call. Three failed batches in a row, or an
 * unreachable AI (which adds no try), pause the pass: 60 s, then each later pause twice as long, up
 * to 1 h, until a call succeeds. `stop` aborts the call in flight and writes nothing for it. The pass
 * logs `intent guesses: done` and stops polling once no row is undecided.
 */
export function createIntentPass(o: IntentPassOptions): IntentPass {
  const { store, guesser, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 60_000;
  const gapMs = o.gapMs ?? 5_000;

  /** When a failed link may be tried again, by `keyOf`. */
  const retryAt = new Map<string, number>();
  let failedInRow = 0;
  let pauses = 0;
  let pausedUntil = 0;
  let finished = false;
  const abort = new AbortController();
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  const paused = () => now().getTime() < pausedUntil;

  function pause(why: string): void {
    pauses += 1;
    pausedUntil = now().getTime() + doubling(PAUSE_BASE_MS, PAUSE_MAX_MS, pauses);
    failedInRow = 0;
    log(`intent pass paused: ${why}`);
  }

  /** Waits `ms`, or until `stop`. */
  function gap(ms: number): Promise<void> {
    if (ms <= 0 || abort.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(wake);
        abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const wake = setTimeout(done, ms);
      abort.signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Backs the batch off, adds a try to each of its links, and counts it toward pausing. */
  async function fail(batch: GuessCandidate[], why: string, error: unknown): Promise<void> {
    log(`intent guesses (${batch.length} links): ${why}: ${messageOf(error)}`);
    const worst = Math.max(...batch.map((c) => c.tries)) + 1;
    const until = now().getTime() + doubling(BATCH_BACKOFF_BASE_MS, BATCH_BACKOFF_MAX_MS, worst);
    for (const c of batch) retryAt.set(keyOf(c), until);
    failedInRow += 1;
    if (failedInRow >= PAUSE_AFTER) pause(`${failedInRow} failed batches in a row`);
  }

  /** One batch of one owner. True when it called the model. */
  async function take(owner: OwnerId, batch: GuessCandidate[]): Promise<boolean> {
    const { signal } = abort;
    const sent: { id: string; link: Link }[] = [];
    const settled: string[] = [];
    for (const c of batch) {
      const link = await store.get(owner, c.id);
      if (!link) continue;
      if (link.intentSource === null) sent.push({ id: c.id, link });
      else settled.push(c.id);
    }
    if (sent.length === 0) {
      await store.recordGuesses(owner, settled, []);
      return false;
    }
    const pinned = new Set((await store.listTags(owner)).filter((t) => t.pinned).map((t) => t.key));
    let named: Set<number>;
    try {
      const reply = await guesser.guess(
        sent.map((s) => material(s.link, pinned)),
        signal,
      );
      if (signal.aborted) return true;
      named = checked(reply, sent.length);
    } catch (error) {
      if (signal.aborted) return true;
      if (error instanceof IntentGuesserUnavailable) {
        log(`intent guesses: the AI could not be reached: ${error.message}`);
        pause("the AI could not be reached");
        return true;
      }
      await store.recordGuessFailure(
        owner,
        sent.map((s) => s.id),
        MAX_TRIES,
      );
      await fail(batch, "could not guess", error);
      return true;
    }
    try {
      const keep = sent.filter((_, i) => named.has(i + 1)).map((s) => s.id);
      await store.recordGuesses(owner, [...sent.map((s) => s.id), ...settled], keep);
      for (const c of batch) retryAt.delete(keyOf(c));
      failedInRow = 0;
      pauses = 0;
      pausedUntil = 0;
    } catch (error) {
      if (!signal.aborted) await fail(batch, "a store call failed", error);
    }
    return true;
  }

  /** Splits a page into batches of one owner: links that have failed before go 5 to a call. */
  function batches(rows: GuessCandidate[]): GuessCandidate[][] {
    const groups = new Map<string, GuessCandidate[]>();
    for (const c of rows) {
      const key = `${c.tries > 0}|${c.owner}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const out: GuessCandidate[][] = [];
    for (const group of groups.values()) {
      const size = (group[0] as GuessCandidate).tries > 0 ? GUESS_RETRY_BATCH : GUESS_BATCH;
      for (let i = 0; i < group.length; i += size) out.push(group.slice(i, i + size));
    }
    return out;
  }

  async function scan(): Promise<void> {
    let after: { owner: OwnerId; id: string } | null = null;
    for (;;) {
      const rows = await store.guessCandidates(after, PAGE_SIZE);
      const due = rows.filter((c) => (retryAt.get(keyOf(c)) ?? 0) <= now().getTime());
      for (const batch of batches(due)) {
        if (quiet || paused()) return;
        try {
          if (await take((batch[0] as GuessCandidate).owner, batch)) await gap(gapMs);
        } catch (error) {
          if (abort.signal.aborted) return;
          log("intent guesses: a store call failed", error);
        }
      }
      if (rows.length < PAGE_SIZE) break;
      const last = rows[rows.length - 1] as GuessCandidate;
      after = { owner: last.owner, id: last.id };
    }
    if (quiet || paused()) return;
    if ((await store.guessCandidates(null, 1)).length === 0) {
      finished = true;
      log("intent guesses: done");
    }
  }

  async function sweepOnce(): Promise<void> {
    if (quiet || paused() || finished) return;
    try {
      await scan();
    } catch (error) {
      log("intent pass sweep failed", error);
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
        if (!quiet && !finished) timer = setTimeout(tick, pollMs);
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
