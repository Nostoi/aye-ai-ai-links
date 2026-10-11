export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };
export type RateLimiter = (key: string) => RateDecision;

/** A fixed-window counter per key. Callers keep the key set small; windows are not swept. */
export function createRateLimiter({
  limit = 120,
  windowMs = 60_000,
  now = Date.now,
}: {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return (key) => {
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    if (w.count >= limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((w.start + windowMs - t) / 1000) };
    }
    w.count += 1;
    return { allowed: true };
  };
}
