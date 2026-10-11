/** Cut to at most `max` code points, never splitting a surrogate pair. */
export function capCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  let count = 0;
  let end = 0;
  for (const ch of s) {
    if (count === max) break;
    count += 1;
    end += ch.length;
  }
  return s.slice(0, end);
}
