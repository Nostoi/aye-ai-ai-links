import { type FolderCheck, MAX_COPY_BYTES, type SavedCopyUsage } from "./saved-copy.js";

/** Full means a copy of the largest size may no longer fit. Always true at limit 0. */
export const copiesFull = (usedBytes: number, limitBytes: number): boolean =>
  limitBytes - usedBytes < MAX_COPY_BYTES;

export type CopyUsageLevel = "low" | "high" | "full";

export const copyUsageLevel = (usedBytes: number, limitBytes: number): CopyUsageLevel =>
  copiesFull(usedBytes, limitBytes) ? "full" : usedBytes >= 0.8 * limitBytes ? "high" : "low";

export type CopyNotice =
  | { kind: "high"; usedBytes: number; limitBytes: number }
  | { kind: "full" }
  | { kind: "paused" };

/** What All links says about saved copies; null when there is nothing to say. */
export function copyNotice(
  usedBytes: number,
  limitBytes: number,
  folder: FolderCheck["state"],
): CopyNotice | null {
  if (limitBytes <= 0) return null;
  if (folder !== "ready") return { kind: "paused" };
  const level = copyUsageLevel(usedBytes, limitBytes);
  if (level === "full") return { kind: "full" };
  return level === "high" ? { kind: "high", usedBytes, limitBytes } : null;
}

/** The line for All links. Usage is read only when there is a limit and the folder is ready. */
export async function readCopyNotice(
  copies: Pick<SavedCopyUsage, "usedBytes" | "lastCheck">,
  limitBytes: number,
): Promise<CopyNotice | null> {
  const folder = copies.lastCheck().state;
  if (limitBytes <= 0 || folder !== "ready") return copyNotice(0, limitBytes, folder);
  return copyNotice(await copies.usedBytes(), limitBytes, folder);
}
