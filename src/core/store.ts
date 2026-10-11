import type { Labelled, Link, LinkPatch, NewLink, OwnerId } from "./types.js";

/**
 * Persistence contract used by core. Every method takes the owner first and
 * must never return or change another owner's data.
 */
export interface LinkStore {
  /**
   * Atomically insert unless (owner, urlKey) already exists; then return the
   * existing link with created false. Unknown tags are created with kind
   * "topic"; attaching an existing tag never changes that tag's metadata.
   */
  insertIfAbsent(owner: OwnerId, link: NewLink): Promise<{ link: Link; created: boolean }>;

  /** The link, or null when absent or owned by someone else. */
  get(owner: OwnerId, id: string): Promise<Link | null>;

  /**
   * Apply only the fields present in the patch, atomically and per field (not
   * a whole-row rewrite). A `tags` field replaces the link's whole tag set.
   * Returns the updated link, or null when absent or foreign.
   */
  update(owner: OwnerId, id: string, patch: LinkPatch): Promise<Link | null>;

  /**
   * Set why only if it is currently null (conditional, atomic). Returns the
   * link as it is after the call, or null when absent or foreign.
   */
  fillWhyIfMissing(owner: OwnerId, id: string, why: Labelled): Promise<Link | null>;
}
