import type { SummarySource } from "./types.js";

/**
 * Who may replace whom: the owner beats the server, and the server beats an AI writing on its
 * own. A summary with no label (written before labels, or none at all) counts as an AI's.
 */
export const REPLACEABLE_SUMMARY_SOURCES: (SummarySource | null)[] = [null, "inferred"];

/** The owner gave this summary, or asked for it. Nothing but the owner replaces it. */
export const isOwnerSummary = (s: SummarySource | null): boolean => s === "stated" || s === "asked";

/** An AI on its own may replace this summary, and so may the server. */
export const isReplaceableSummary = (s: SummarySource | null): boolean =>
  REPLACEABLE_SUMMARY_SOURCES.includes(s);
