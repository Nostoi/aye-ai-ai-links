import type { Labelled, Link, LinkTag } from "./types.js";

/** The fields an in-app AI edit records so it can be undone: title, summary, why and the ordered tags. */
export type Covered = Pick<Link, "title" | "summary" | "why" | "tags">;

/** Which covered fields an edit changed. */
export type Changed = { [K in keyof Covered]: boolean };

export const coveredOf = (l: Covered): Covered => ({
  title: l.title,
  summary: l.summary,
  why: l.why && { ...l.why },
  tags: l.tags.map((t) => ({ ...t })),
});

const sameWhy = (a: Labelled | null, b: Labelled | null) =>
  a?.text === b?.text && a?.source === b?.source;

type TagMark = Pick<LinkTag, "key" | "source">;

/** Tags are the same when they list the same keys with the same sources in the same order. */
export const sameTags = (a: TagMark[], b: TagMark[]) =>
  a.length === b.length && a.every((t, i) => t.key === b[i]?.key && t.source === b[i]?.source);

export const changedFields = (before: Covered, after: Covered): Changed => ({
  title: before.title !== after.title,
  summary: before.summary !== after.summary,
  why: !sameWhy(before.why, after.why),
  tags: !sameTags(before.tags, after.tags),
});

export const anyChanged = (c: Changed) => c.title || c.summary || c.why || c.tags;

/** True while `current` still holds `written` for every field `changed` names. */
export const holdsWritten = (changed: Changed, written: Covered, current: Covered): boolean =>
  (!changed.title || current.title === written.title) &&
  (!changed.summary || current.summary === written.summary) &&
  (!changed.why || sameWhy(current.why, written.why)) &&
  (!changed.tags || sameTags(current.tags, written.tags));

export function extendedPrior(
  old: { changed: Changed; prior: Covered },
  changed: Changed,
  before: Covered,
): { changed: Changed; prior: Covered } {
  const pick = <K extends keyof Covered>(k: K): Covered[K] =>
    old.changed[k] ? old.prior[k] : before[k];
  return {
    changed: {
      title: old.changed.title || changed.title,
      summary: old.changed.summary || changed.summary,
      why: old.changed.why || changed.why,
      tags: old.changed.tags || changed.tags,
    },
    prior: { title: pick("title"), summary: pick("summary"), why: pick("why"), tags: pick("tags") },
  };
}
