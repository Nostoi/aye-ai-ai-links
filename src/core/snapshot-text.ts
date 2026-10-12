import type { SnapshotStore } from "./snapshot-store.js";
import type { Link, OwnerId } from "./types.js";

/** How much page text `save_link` returns. */
export const EXCERPT_CHARS = 500;
/** How much page text `get_link` returns. */
export const TEXT_CHARS = 20_000;

export type SnapshotText = { text: string; truncated: boolean };

export type PageTextReader = Pick<SnapshotStore, "getSnapshotText">;

/**
 * The first `max` code points, never splitting a surrogate pair. This repeats
 * `fetch/cap.ts`, which core may not import.
 */
export function capCodePoints(text: string, max: number): SnapshotText {
  let units = 0;
  let count = 0;
  for (const ch of text) {
    if (count === max) return { text: text.slice(0, units), truncated: true };
    units += ch.length;
    count += 1;
  }
  return { text, truncated: false };
}

/**
 * The page text that belongs to `link` as it was read, capped at `max`, or null.
 * Only an ok snapshot has text, and ok is final, so text is read only when the link's own
 * snapshot is ok: a fetch that finishes after the link was read cannot pair new text with
 * an old status.
 */
export async function readSnapshotText(
  pages: PageTextReader | undefined,
  owner: OwnerId,
  link: Link,
  max: number,
): Promise<SnapshotText | null> {
  if (!pages || link.snapshot?.status !== "ok") return null;
  const text = await pages.getSnapshotText(owner, link.id);
  return text === null ? null : capCodePoints(text, max);
}
