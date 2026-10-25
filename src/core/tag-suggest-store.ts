import type { OwnerId } from "./types.js";

/** What the suggested tag merges (#251) read and write beyond the tag catalog. */
export interface TagSuggestStore {
  /** Pairs of the owner's tag keys that are both on at least one live (deleted_at IS NULL) link, each as [a, b] with a < b. */
  sharedPairs(owner: OwnerId): Promise<[string, string][]>;
  /** The owner's dismissed pairs, each [a, b] with a < b. */
  dismissedPairs(owner: OwnerId): Promise<[string, string][]>;
  /** Records a dismissal; the keys may come in either order. Repeating it is harmless. */
  dismissPair(owner: OwnerId, a: string, b: string, at: Date): Promise<void>;
  /** Removes a dismissal, keys in either order. Removing a missing one is harmless. */
  undismissPair(owner: OwnerId, a: string, b: string): Promise<void>;
}
