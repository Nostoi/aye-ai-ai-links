import { CoreError } from "./errors.js";
import type { LinkExpectation } from "./store.js";
import type { IntentPair } from "./tool-store.js";
import { INTENTS, type Intent, type LinkPatch, SOURCES, type Source } from "./types.js";

/**
 * Intent (#339): what the owner means to do with a link, and who said so. A link kept handy is
 * To keep, so core refuses any write of explore while its Keep handy row is `kept`.
 */

export const KEPT_TOOL_STAYS =
  "This link is kept handy, so it stays To keep. Choose Not handy anymore first.";

const isIntent = (s: string): s is Intent => (INTENTS as readonly string[]).includes(s);
const isSource = (s: string): s is Source => (SOURCES as readonly string[]).includes(s);

const invalid = (message: string) => new CoreError("invalid_input", message);

/** A written intent with its source: both or neither, each valid. Nothing given is `undefined`. */
export function checkIntent(
  intent: string | undefined,
  source: string | null | undefined,
): { intent: Intent; intentSource: Source } | undefined {
  if (intent === undefined && source == null) return undefined;
  if (intent === undefined) throw invalid("intentSource needs an intent. Send intent too.");
  if (source == null)
    throw invalid("intent needs an intentSource. Send stated, asked or inferred.");
  if (!isIntent(intent)) throw invalid(`The intent "${intent}" is not valid. Use explore or keep.`);
  if (!isSource(source)) {
    throw invalid(`The intent source "${source}" is not valid. Use stated, asked or inferred.`);
  }
  return { intent, intentSource: source };
}

/**
 * An intent and source as one pair the store can hold: a known intent, a known source or none, and
 * a keep always with a source. What a page sends back for an Undo is checked here.
 */
export function checkPair(pair: { intent: string; intentSource: string | null }): IntentPair {
  const { intent, intentSource } = pair;
  if (intentSource === null) {
    if (intent !== "explore") throw invalid("A To keep link needs a source. Reload the page.");
    return { intent, intentSource: null };
  }
  const checked = checkIntent(intent, intentSource);
  return checked as IntentPair;
}

/** What a write of this patch expects: an explore is refused while the link is a kept tool. */
export const intentExpectation = (patch: Pick<LinkPatch, "intent">): LinkExpectation =>
  patch.intent === "explore" ? { notKeptTool: true } : {};

/** Core's own conflict for an explore that the kept-tool rule refused. */
export const keptToolStays = () => new CoreError("conflict", KEPT_TOOL_STAYS);
