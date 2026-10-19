import type { TrackCall } from "./server.js";

export type CallTracker = {
  track: TrackCall;
  /** How many tool calls are running, and a promise that settles when those have ended. */
  calls: () => { running: number; ended: Promise<void> };
};

export function createCallTracker(): CallTracker {
  // Tool calls still running. A response can be under way, or its connection closed, before
  // its call ends, so shutdown waits on the calls themselves, not on the HTTP requests.
  const running = new Set<Promise<unknown>>();
  const track: TrackCall = (call) => {
    running.add(call);
    const done = () => running.delete(call);
    call.then(done, done);
    return call;
  };
  return {
    track,
    calls: () => ({
      running: running.size,
      ended: Promise.allSettled([...running]).then(() => {}),
    }),
  };
}
