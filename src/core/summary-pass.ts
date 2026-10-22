import type { SnapshotStore } from "./snapshot-store.js";
import { capCodePoints, readSnapshotText } from "./snapshot-text.js";
import type { LinkStore, SummaryCandidate, SummaryCandidates } from "./store.js";
import { isReplaceableSummary, REPLACEABLE_SUMMARY_SOURCES } from "./summary-rule.js";
import type { SummarySource } from "./types.js";

/** The longest summary the server writes, in code points: one desktop row line, two phone lines. */
export const SUMMARY_MAX = 90;
/** How much page text goes to the model, in code points. */
export const SUMMARY_PAGE_CHARS = 6_000;

/** Failures in a row, on different links, after which the pass pauses. */
const PAUSE_AFTER = 3;
const LINK_BACKOFF_BASE_MS = 60_000;
const LINK_BACKOFF_MAX_MS = 24 * 3_600_000;
const PAUSE_BASE_MS = 60_000;
const PAUSE_MAX_MS = 3_600_000;
const PAGE_SIZE = 100;

/** The AI could not be reached. A bad reply, or a refused page, is any other error. */
export class SummarizerUnavailable extends Error {
  override name = "SummarizerUnavailable";
}

/** Writes one short summary of a page. Implemented over the one AI connection in `src/ai/`. */
export interface Summarizer {
  summarize(
    page: { title: string | null; description: string | null; text: string },
    signal: AbortSignal,
  ): Promise<string>;
}

export type SummaryPassOptions = {
  store: LinkStore & SummaryCandidates;
  pages: Pick<SnapshotStore, "getSnapshotText">;
  summarizer: Summarizer;
  now: () => Date;
  log?: (message: string, error?: unknown) => void;
  /** Time between sweeps. Default 60 s. */
  pollMs?: number;
  /** Time between calls. Default 5 s. */
  gapMs?: number;
};

export type SummaryPass = {
  /** Sweep now and every `pollMs`. */
  start(): void;
  /** Take no new work: stop sweeping. A sweep in flight carries on. */
  quiesce(): void;
  /** Quiesce, abort the call in flight, and wait for the sweep to end. Writes nothing for that link. */
  stop(): Promise<void>;
  /** One sweep. Resolves when it ends. */
  sweep(): Promise<void>;
};

/** A link waiting out a backoff, and the summary it had when it failed. */
type Failure = {
  attempts: number;
  retryAt: number;
  summary: string | null;
  source: SummarySource | null;
};

const doubling = (base: number, max: number, n: number) => Math.min(base * 2 ** (n - 1), max);
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const ABORTED = Symbol("aborted");

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Writes, in the background, a one-line summary for every link whose page text the server has and
 * whose summary the server may replace (`REPLACEABLE_SUMMARY_SOURCES`). One call at a time, with a
 * gap, and a write only while the link still holds the summary and label it had when read, so an
 * edit made during the call wins.
 *
 * A failure backs off that link alone: 60 s, doubling to 24 h, with no cap on tries, and it ends
 * when the link's summary changes. Three failures in a row on different links pause the whole
 * pass: 60 s, doubling to 1 h, until one call succeeds. Backoffs are kept in memory, so a restart
 * tries everything again. `stop` aborts the call in flight, stops waiting for it, and writes
 * nothing for it, even if it answers later.
 */
export function createSummaryPass(o: SummaryPassOptions): SummaryPass {
  const { store, pages, summarizer, now } = o;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const pollMs = o.pollMs ?? 60_000;
  const gapMs = o.gapMs ?? 5_000;

  const failures = new Map<string, Failure>();
  /** The links that failed since the last success, and how many pauses they have caused. */
  const streak = new Set<string>();
  let pauses = 0;
  let pausedUntil = 0;
  const abort = new AbortController();
  let started = false;
  let quiet = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The sweep in flight. */
  let running: Promise<void> | undefined;

  const keyOf = (c: SummaryCandidate) => JSON.stringify([c.owner, c.id]);
  const paused = () => now().getTime() < pausedUntil;

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

  /** Backs the link off. `pause` also counts the failure toward pausing the whole pass. */
  function fail(
    key: string,
    seen: { summary: string | null; summarySource: SummarySource | null },
    why: string,
    error: unknown,
    pause: boolean,
  ): void {
    const attempts = (failures.get(key)?.attempts ?? 0) + 1;
    const retryAt = now().getTime() + doubling(LINK_BACKOFF_BASE_MS, LINK_BACKOFF_MAX_MS, attempts);
    failures.set(key, { attempts, retryAt, summary: seen.summary, source: seen.summarySource });
    log(`summary ${key}: ${why}: ${messageOf(error)} (attempt ${attempts})`);
    if (!pause) return;
    streak.add(key);
    if (pauses > 0 || streak.size >= PAUSE_AFTER) {
      pauses += 1;
      pausedUntil = now().getTime() + doubling(PAUSE_BASE_MS, PAUSE_MAX_MS, pauses);
      log(`summary pass paused after ${streak.size} failing links`);
    }
  }

  /** A well-formed reply: one trimmed line within SUMMARY_MAX. */
  function checked(reply: string): string {
    const text = reply.trim();
    if (text === "") throw new Error("the reply was empty");
    if (capCodePoints(text, SUMMARY_MAX).truncated) throw new Error("the reply was too long");
    return text;
  }

  /** Summarises one candidate. True when it called the model. */
  async function take(c: SummaryCandidate, key: string): Promise<boolean> {
    const { signal } = abort;
    const read = await store.get(c.owner, c.id);
    if (!read || !isReplaceableSummary(read.summarySource)) return false;
    const failed = failures.get(key);
    if (failed) {
      if (failed.summary !== read.summary || failed.source !== read.summarySource) {
        failures.delete(key);
      } else if (now().getTime() < failed.retryAt) {
        return false;
      }
    }
    const body = await readSnapshotText(pages, c.owner, read, SUMMARY_PAGE_CHARS);
    if (!body || body.text.trim() === "") return false;
    const page = {
      title: read.snapshot?.title ?? read.title,
      description: read.snapshot?.description ?? null,
      text: body.text,
    };
    let text: string;
    try {
      const reply = await untilAborted((async () => summarizer.summarize(page, signal))());
      if (reply === ABORTED || signal.aborted) return true;
      text = checked(reply);
    } catch (error) {
      if (!signal.aborted) fail(key, read, "could not summarise", error, true);
      return true;
    }
    streak.clear();
    pauses = 0;
    pausedUntil = 0;
    try {
      const done = await store.updateIf(
        c.owner,
        c.id,
        { summary: read.summary, summarySource: [read.summarySource] },
        { summary: text, summarySource: "server" },
      );
      if (done?.applied) failures.delete(key);
    } catch (error) {
      fail(key, read, "a store call failed", error, false);
    }
    return true;
  }

  async function scan(): Promise<void> {
    const seen = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const rows = await store.summaryCandidates(after, PAGE_SIZE, REPLACEABLE_SUMMARY_SOURCES);
      for (const c of rows) {
        if (quiet || paused()) return;
        const key = keyOf(c);
        seen.add(key);
        try {
          if (await take(c, key)) await gap(gapMs);
        } catch (error) {
          if (abort.signal.aborted) return;
          log(`summary ${key}: a store call failed`, error);
        }
      }
      if (rows.length < PAGE_SIZE) break;
      after = (rows.at(-1) as SummaryCandidate).id;
      await nextTurn();
      if (quiet) return;
    }
    for (const key of failures.keys()) if (!seen.has(key)) failures.delete(key);
  }

  async function sweepOnce(): Promise<void> {
    if (quiet || paused()) return;
    try {
      await scan();
    } catch (error) {
      log("summary pass sweep failed", error);
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
