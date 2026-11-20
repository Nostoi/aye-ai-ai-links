/** Runs one model call with a signal that aborts when `signal` does, or after `timeoutMs`. */
export async function withCallSignal<T>(
  signal: AbortSignal,
  timeoutMs: number,
  run: (call: AbortSignal) => Promise<T>,
): Promise<T> {
  const call = new AbortController();
  const abort = () => call.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await run(call.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
