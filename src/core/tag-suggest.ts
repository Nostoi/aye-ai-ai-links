import type { LinkStore } from "./store.js";
import { listTagsWithCounts } from "./tag-edit.js";
import type { TagEditStore } from "./tag-edit-store.js";
import type { TagSuggestStore } from "./tag-suggest-store.js";
import type { OwnerId, Tag } from "./types.js";

/** The meaning of a tag's name as a unit vector, each name embedded on its own. */
export interface NameVectors {
  vectorOf(name: string): Promise<Float32Array>;
}

/** The least meaning similarity of a suggested pair: see the spec's table (2026-10-24-tag-merge-suggestions-design.md). */
export const MERGE_SUGGEST_MIN = 0.75;

/** The most suggestions one view gets. */
export const MERGE_SUGGEST_MAX = 5;

export type TagMergeSuggestion = {
  a: { tag: Tag; links: number };
  b: { tag: Tag; links: number };
};

const spelled = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** True when the names are equal once capitals and all but letters and digits are dropped, or once a final `s` is dropped from one. */
export function spellingTwins(a: string, b: string): boolean {
  const x = spelled(a);
  const y = spelled(b);
  if (x === "" || y === "") return false;
  return x === y || x === `${y}s` || y === `${x}s`;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

const dot = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
};

/** Order for names: by code point, so the result never depends on a locale. */
const byName = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Pairs of the owner's tags to offer for a merge: spelling twins, then close-meaning tags that no
 * live link carries together, less the pairs turned down. The strongest `MERGE_SUGGEST_MAX`.
 */
export async function suggestTagMerges(
  deps: {
    store: LinkStore;
    tagEdits: TagEditStore;
    tagSuggest: TagSuggestStore;
    names: NameVectors;
  },
  owner: OwnerId,
): Promise<TagMergeSuggestion[]> {
  const [all, shared, dismissed] = await Promise.all([
    listTagsWithCounts(deps, owner),
    deps.tagSuggest.sharedPairs(owner),
    deps.tagSuggest.dismissedPairs(owner),
  ]);
  const live = all.filter((t) => t.links > 0);
  const apart = new Set(shared.map(([a, b]) => pairKey(a, b)));
  const turnedDown = new Set(dismissed.map(([a, b]) => pairKey(a, b)));
  const vectors = await Promise.all(live.map((t) => deps.names.vectorOf(t.tag.name)));

  const found: { suggestion: TagMergeSuggestion; score: number }[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const x = live[i];
      const y = live[j];
      const vx = vectors[i];
      const vy = vectors[j];
      if (!x || !y || !vx || !vy) continue;
      const key = pairKey(x.tag.key, y.tag.key);
      if (turnedDown.has(key)) continue;
      // Twins outrank every meaning score, which is a cosine and so at most 1.
      const twins = spellingTwins(x.tag.name, y.tag.name);
      const score = twins ? 2 : dot(vx, vy);
      if (!twins && (score < MERGE_SUGGEST_MIN || apart.has(key))) continue;
      const [a, b] =
        x.links !== y.links ? (x.links > y.links ? [x, y] : [y, x]) : sortedByName(x, y);
      found.push({ suggestion: { a, b }, score });
    }
  }
  found.sort(
    (p, q) =>
      q.score - p.score ||
      byName(p.suggestion.a.tag.name, q.suggestion.a.tag.name) ||
      byName(p.suggestion.b.tag.name, q.suggestion.b.tag.name),
  );
  return found.slice(0, MERGE_SUGGEST_MAX).map((f) => f.suggestion);
}

const sortedByName = <T extends { tag: Tag }>(x: T, y: T): [T, T] =>
  byName(x.tag.name, y.tag.name) <= 0 ? [x, y] : [y, x];
