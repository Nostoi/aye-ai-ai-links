import { AsyncLocalStorage } from "node:async_hooks";

/** Runs `fn` alone: no other call through the same lock starts until it settles. */
export type WithAuthLock = <T>(fn: () => Promise<T>) => Promise<T>;

const held = new AsyncLocalStorage<true>();

/**
 * Whether the calling code runs inside an auth-lock call. Network fetches check it: a fetch made
 * while the lock is held would stall every auth request queued behind it.
 */
export const insideAuthLock = (): boolean => held.getStore() === true;

/**
 * The one auth lock of the server process (condition 3 of the auth spec). Every better-auth call
 * goes through it: each `/api/auth/*` request, each `getSession`, and any server-side `auth.api`
 * call. A promise chain: calls run in arrival order, and a failure is passed to its own caller
 * without stopping the queue.
 */
export function createAuthLock(): WithAuthLock {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => held.run(true, fn));
    tail = run.catch(() => {});
    return run;
  };
}
