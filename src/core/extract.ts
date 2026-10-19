import type { CopyDraft } from "./saved-copy.js";

/** What a page says about itself, read from its head. */
export type PageMetadata = {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  /** The site's icon candidates, best first; at most MAX_ICON_URLS. Read it with `boundedIconUrls`. */
  iconUrls: string[];
};

/**
 * Every way an extraction can end. Metadata is kept when it was read before the extraction
 * ended badly, and is `null` when the failure came first.
 *
 * - `timeout`, `out_of_memory` and `crashed` come from the page's content: the same HTML will
 *   fail the same way, so callers should not retry them.
 * - `spawn_failed` is about the machine (the child could not start, lost its channel, or ended
 *   before it had received the page), not the page, so a retry is reasonable.
 * - `aborted` means the caller's signal fired or the extractor was closed (shutdown), before the
 *   metadata and text were in. After them, any end is `ok`.
 * - On `ok`, `copy` is absent when it was not asked for or did not arrive, and `null` when the
 *   page had no article.
 */
export type ExtractOutcome =
  | { kind: "ok"; metadata: PageMetadata; text: string | null; copy?: CopyDraft | null }
  | { kind: "timeout"; metadata: PageMetadata | null }
  | { kind: "out_of_memory"; metadata: PageMetadata | null }
  | { kind: "crashed"; metadata: PageMetadata | null; detail: string }
  | { kind: "spawn_failed"; detail: string }
  | { kind: "aborted" };

/**
 * Reads a fetched page's metadata and readable text without blocking the caller.
 *
 * - Never rejects: see `ExtractOutcome`.
 * - `close()` stops any extraction in flight (reported as `aborted`) and refuses later ones.
 */
export interface PageExtractor {
  extract(
    html: string,
    finalUrl: string,
    signal?: AbortSignal,
    options?: { copy?: boolean },
  ): Promise<ExtractOutcome>;
  close(): Promise<void>;
}
