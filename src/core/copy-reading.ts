import type { StoredImage } from "./image-store.js";
import { COPY_READ_TIMEOUT_MS, type ReadCopy, type SavedCopyReader } from "./saved-copy.js";
import type { LinkStore } from "./store.js";
import type { Link, OwnerId } from "./types.js";

export type CopyView = { link: Link; madeAt: Date; copy: ReadCopy | "missing" | "unreadable" };
export type CopyReader = {
  /** null: not the owner's link, or no ok copy. */
  view(owner: OwnerId, linkId: string): Promise<CopyView | null>;
  /** null: no such ok image; "unreadable": a throw or the deadline. */
  image(owner: OwnerId, linkId: string, n: number): Promise<StoredImage | "unreadable" | null>;
};
/** One saved-copy file read at a time, process-wide (R40). */
export type ReadGate = {
  run<T>(read: () => Promise<T>, deadlineMs: number): Promise<T | "timeout">;
};

/**
 * One slot and a FIFO of waiters. A run answers "timeout" once `deadlineMs` passes, counted from
 * the call, and a waiter whose deadline passes never starts its read. A started read holds the slot
 * until its own promise settles; a rejection after the deadline is swallowed here, so the caller
 * that kept the promise logs it.
 */
export function createReadGate(): ReadGate {
  let busy = false;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else busy = false;
  };
  return {
    run<T>(read: () => Promise<T>, deadlineMs: number): Promise<T | "timeout"> {
      return new Promise<T | "timeout">((resolve, reject) => {
        let done = false;
        const start = () => {
          busy = true;
          let call: Promise<T>;
          try {
            call = read();
          } catch (error) {
            call = Promise.reject(error);
          }
          call
            .then(
              (value) => {
                if (!done) resolve(value);
              },
              (error) => {
                if (!done) reject(error);
              },
            )
            .finally(() => {
              done = true;
              clearTimeout(timer);
              release();
            });
        };
        const timer = setTimeout(() => {
          done = true;
          const i = waiting.indexOf(start);
          if (i >= 0) waiting.splice(i, 1);
          resolve("timeout");
        }, deadlineMs);
        if (busy) waiting.push(start);
        else start();
      });
    },
  };
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads saved copies for their owner: the ledger first, then one file read through the gate. */
export function createCopyReader(o: {
  store: Pick<LinkStore, "get">;
  copies: SavedCopyReader;
  gate: ReadGate;
  timeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
}): CopyReader {
  const timeoutMs = o.timeoutMs ?? COPY_READ_TIMEOUT_MS;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  const failed = (linkId: string, why: string, error?: unknown) =>
    log(`[saved copies] copy ${linkId} could not be read: ${why}`, error);

  /** The read through the gate; a throw or the deadline is logged and answers "unreadable". */
  async function limited<T>(linkId: string, read: () => Promise<T>): Promise<T | "unreadable"> {
    let call: Promise<T> | undefined;
    try {
      const result = await o.gate.run(() => {
        call = read();
        return call;
      }, timeoutMs);
      if (result !== "timeout") return result;
      failed(linkId, "timed out");
      call?.catch((error) => failed(linkId, reason(error), error));
      return "unreadable";
    } catch (error) {
      failed(linkId, reason(error), error);
      return "unreadable";
    }
  }

  return {
    async view(owner, linkId) {
      const link = await o.store.get(owner, linkId);
      if (!link) return null;
      const info = (await o.copies.copyInfo(owner, [linkId])).get(linkId);
      if (!info) return null;
      const copy = await limited(linkId, () => o.copies.readCopy(owner, linkId));
      return copy === null ? null : { link, madeAt: info.madeAt, copy };
    },
    image: (owner, linkId, n) => limited(linkId, () => o.copies.copyImage(owner, linkId, n)),
  };
}
