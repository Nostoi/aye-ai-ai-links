import type { Labelled, Link, LinkTag } from "./types.js";

/**
 * The fields an edit records so it can be undone: title, summary with its source, why, the
 * ordered tags, and the intent with its source.
 */
export type Covered = Pick<
  Link,
  "title" | "summary" | "summarySource" | "why" | "tags" | "intent" | "intentSource"
>;

/** Which covered fields an edit changed. The summary and its source are one field, as are the intent and its source. */
export type Changed = {
  title: boolean;
  summary: boolean;
  why: boolean;
  tags: boolean;
  intent: boolean;
};

export const coveredOf = (l: Covered): Covered => ({
  title: l.title,
  summary: l.summary,
  summarySource: l.summarySource,
  why: l.why && { ...l.why },
  tags: l.tags.map((t) => ({ ...t })),
  intent: l.intent,
  intentSource: l.intentSource,
});

const sameWhy = (a: Labelled | null, b: Labelled | null) =>
  a?.text === b?.text && a?.source === b?.source;

const sameSummary = (a: Covered, b: Covered) =>
  a.summary === b.summary && a.summarySource === b.summarySource;

const sameIntent = (a: Covered, b: Covered) =>
  a.intent === b.intent && a.intentSource === b.intentSource;

type TagMark = Pick<LinkTag, "key" | "source">;

/** Tags are the same when they list the same keys with the same sources in the same order. */
export const sameTags = (a: TagMark[], b: TagMark[]) =>
  a.length === b.length && a.every((t, i) => t.key === b[i]?.key && t.source === b[i]?.source);

export const changedFields = (before: Covered, after: Covered): Changed => ({
  title: before.title !== after.title,
  summary: !sameSummary(before, after),
  why: !sameWhy(before.why, after.why),
  tags: !sameTags(before.tags, after.tags),
  intent: !sameIntent(before, after),
});

export const anyChanged = (c: Changed) => c.title || c.summary || c.why || c.tags || c.intent;

/** True while `current` still holds `written` for every field `changed` names. */
export const holdsWritten = (changed: Changed, written: Covered, current: Covered): boolean =>
  (!changed.title || current.title === written.title) &&
  (!changed.summary || sameSummary(current, written)) &&
  (!changed.why || sameWhy(current.why, written.why)) &&
  (!changed.tags || sameTags(current.tags, written.tags)) &&
  (!changed.intent || sameIntent(current, written));

export function extendedPrior(
  old: { changed: Changed; prior: Covered },
  changed: Changed,
  before: Covered,
): { changed: Changed; prior: Covered } {
  const from = (field: keyof Changed): Covered => (old.changed[field] ? old.prior : before);
  const summary = from("summary");
  const intent = from("intent");
  return {
    changed: {
      title: old.changed.title || changed.title,
      summary: old.changed.summary || changed.summary,
      why: old.changed.why || changed.why,
      tags: old.changed.tags || changed.tags,
      intent: old.changed.intent || changed.intent,
    },
    prior: {
      title: from("title").title,
      summary: summary.summary,
      summarySource: summary.summarySource,
      why: from("why").why,
      tags: from("tags").tags,
      intent: intent.intent,
      intentSource: intent.intentSource,
    },
  };
}
