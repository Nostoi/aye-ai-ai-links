import {
  type CopyDraft,
  copyLimits,
  MAX_COPY_MARKDOWN_BYTES,
  type SaveCopyResult,
  type SavedCopyWriter,
} from "./saved-copy.js";
import type { ToolStore } from "./tool-store.js";
import type { OwnerId } from "./types.js";

/** null: nothing written (not the owner's link, or a no-copy reason with a row already there). */
export type KeepResult = SaveCopyResult | "tool" | null;

export interface CopyKeeper {
  /** Whether new snapshots should ask the extractor for a copy. */
  readonly wanted: boolean;
  /**
   * Applies core's rules, then saves the draft or records why there is none. A store error
   * reaches the caller.
   */
  keep(owner: OwnerId, linkId: string, draft: CopyDraft): Promise<KeepResult>;
}

/** The rules for which link gets a copy; the store holds none of them. */
export function createCopyKeeper(o: {
  copies: SavedCopyWriter;
  tools: Pick<ToolStore, "getTool">;
  limitBytes: number;
  now: () => Date;
}): CopyKeeper {
  const { copies, tools, limitBytes, now } = o;
  const limits = copyLimits(limitBytes);
  return {
    wanted: limitBytes > 0,

    async keep(owner, linkId, draft) {
      if ((await tools.getTool(owner, linkId))?.status === "kept") {
        return (await copies.recordNoCopy(owner, linkId, "none")) ? "tool" : null;
      }
      if (Buffer.byteLength(draft.markdown, "utf8") > MAX_COPY_MARKDOWN_BYTES) {
        return (await copies.recordNoCopy(owner, linkId, "too_large")) ? "too_large" : null;
      }
      return copies.saveCopy(owner, linkId, draft, limits, now());
    },
  };
}
