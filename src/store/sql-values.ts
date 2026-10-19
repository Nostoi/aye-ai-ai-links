/** How dates and link ids cross into and out of SQLite. */
export function toMs(d: Date | null): number | null {
  if (d === null) return null;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("Cannot store an invalid date.");
  return ms;
}

export const fromMs = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/** Canonical decimal ids in 1..MAX_SAFE_INTEGER; anything else was never issued. */
export function parseId(id: string): number | null {
  if (!/^[1-9][0-9]*$/.test(id)) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : null;
}
