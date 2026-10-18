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
  /** Records `none` and answers true when core gives this link no copy before any fetch (a kept tool). */
  refuse(owner: OwnerId, linkId: string): Promise<boolean>;
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
  /** For a kept tool, records `none` and answers whether a row was written; otherwise undefined. */
  async function refuseTool(owner: OwnerId, linkId: string): Promise<boolean | undefined> {
    if ((await tools.getTool(owner, linkId))?.status !== "kept") return undefined;
    return copies.recordNoCopy(owner, linkId, "none");
  }

  return {
    wanted: limitBytes > 0,

    async refuse(owner, linkId) {
      return (await refuseTool(owner, linkId)) !== undefined;
    },

    async keep(owner, linkId, draft) {
      const refused = await refuseTool(owner, linkId);
      if (refused !== undefined) return refused ? "tool" : null;
      if (Buffer.byteLength(draft.markdown, "utf8") > MAX_COPY_MARKDOWN_BYTES) {
        return (await copies.recordNoCopy(owner, linkId, "too_large")) ? "too_large" : null;
      }
      return copies.saveCopy(owner, linkId, draft, limits, now());
    },
  };
}
