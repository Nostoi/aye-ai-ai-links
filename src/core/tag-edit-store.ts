import type { OwnerId, Tag } from "./types.js";

/** The catalog fields a merge writes onto the kept tag. Which values survive is a core rule. */
export type TagSettings = Pick<
  Tag,
  "kind" | "kindSource" | "color" | "pinned" | "description" | "projectStatus"
>;

/** What a merge or delete receipt records that its Undo checks or writes. */
type Footprinted = {
  removed: { key: string };
  kept?: { key: string; links: (string | number)[] };
  aliases: string[];
  address?: string | null;
  links: { id: string | number }[];
};

/** Its tag keys and every link it recorded, purged ones included. */
const footprint = (r: Footprinted): Set<string> => {
  const keys = [r.removed.key, ...r.aliases];
  if (r.kept) keys.push(r.kept.key);
  if (r.address) keys.push(r.address);
  const links = [...(r.kept?.links ?? []), ...r.links.map((l) => l.id)];
  return new Set([...keys.map((k) => `tag:${k}`), ...links.map((id) => `link:${id}`)]);
};

/** Whether two receipts share a tag key or a link. */
export const receiptsMeet = (a: Footprinted, b: Footprinted): boolean => {
  const mine = footprint(a);
  return [...footprint(b)].some((x) => mine.has(x));
};

/**
 * Persistence contract for renaming, merging and deleting the owner's tags, and the Undo of a
 * merge or delete (#240). Any implementation must meet all of it. The rules (the new name's key,
 * the merged settings, the Undo window) are core's: the store applies what it is given.
 *
 * - Owner scoping: every method takes the owner and never reads or changes another owner's
 *   tags, links, old keys or receipts.
 * - Atomicity: each method is one step; on "conflict", "taken" or null nothing is written.
 * - Hidden links (in their delete-Undo window) are rewritten and restored like live ones; only
 *   the counts leave them out.
 * - Old keys: a key a rename or merge took away keeps reaching the tag that now has its links,
 *   through chains, and never expires. A live tag with the same key wins over it.
 * - Link-edit receipts: a rename that changes the key, a merge and a delete each remove, in the
 *   same step, every one of the owner's `LinkEditStore` records whose tags (before or after)
 *   name the old key, so that edit's Undo answers as one with no record does.
 * - Receipts: a merge or delete keeps a receipt until Undo uses it or a later merge or delete
 *   prunes it; one older than `since` is never used.
 */
export interface TagEditStore {
  /** Live (deleted_at IS NULL) links per tag key, every state. Keys with none are absent. */
  tagLinkCounts(owner: OwnerId): Promise<Map<string, number>>;
  /** Sets name and key. "taken" when another of the owner's tags has newKey. Adds alias oldKey→this tag when the key changes. Null when no tag has `key`. */
  renameTag(
    owner: OwnerId,
    key: string,
    name: string,
    newKey: string,
  ): Promise<Tag | "taken" | null>;
  /**
   * Moves `from`'s links onto `into`, writes `set` onto `into` and removes `from`, after pruning
   * the owner's receipts older than `pruneBefore`. "conflict" when either stored tag differs
   * from the one given in any field; null when either is missing. `moved`: the live links the old
   * tag was on. `links`: the kept tag's live count afterwards.
   */
  mergeTag(
    owner: OwnerId,
    m: { from: Tag; into: Tag; set: TagSettings; at: Date; pruneBefore: Date },
  ): Promise<{ tag: Tag; changeId: string; moved: number; links: number } | "conflict" | null>;
  /** Takes the tag off every link and removes it, pruning as `mergeTag` does. `moved`: the live links it was on. */
  deleteTag(
    owner: OwnerId,
    d: { tag: Tag; at: Date; pruneBefore: Date },
  ): Promise<{ changeId: string; moved: number } | "conflict" | null>;
  /**
   * Puts back exactly what the merge or delete changed: the removed tag, its old keys, the kept
   * tag's settings and each remaining link's tags with their sources and positions. "conflict",
   * writing nothing, when any of that has changed since; "blocked", writing nothing, when it hasn't but a newer receipt that can itself still be undone shares its ground. Null when no receipt with this id at or
   * after `since`. On "undone", the receipt is removed. Each tag comes with its live count:
   * `[removed, kept]` for a merge, `[removed]` for a delete.
   */
  undoTagChange(
    owner: OwnerId,
    changeId: string,
    since: Date,
  ): Promise<{ tags: { tag: Tag; links: number }[] } | "conflict" | "blocked" | null>;
  /** The live key an old key now reaches: a live tag with `key` wins, then an alias. Null for neither. */
  currentKey(owner: OwnerId, key: string): Promise<string | null>;
}
