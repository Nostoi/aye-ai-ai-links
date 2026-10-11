import type { Labelled, Link, LinkPatch, NewLink, OwnerId } from "./types.js";

/**
 * Persistence contract used by core. Any implementation must meet all of it.
 *
 * - Owner scoping: every method takes the owner first and never reads or
 *   changes another owner's links or tags.
 * - Tags: identity is `key`, per owner. A key the owner has not used before is
 *   created with the attached name as its name and kind "topic". Attaching an
 *   existing tag never changes its name, kind, colour, pin or project fields.
 *   Every returned LinkTag.name is the catalog's name for its key, not the name
 *   passed in; each LinkTag keeps its own source. Tags come back in the order
 *   they were attached.
 * - Atomicity: each method that takes several steps (insert with tags, update
 *   with tags, read-back) either completes whole or changes nothing.
 * - Ids: a store may issue any id format. An id it never issued (any string,
 *   including empty, malformed or out of range) yields null, never an error.
 */
export interface LinkStore {
  /**
   * Insert unless (owner, urlKey) already exists, in one atomic step; then
   * return the existing link with created false. When created is false the
   * candidate is discarded whole: its tags are not attached and no catalog rows
   * are created.
   */
  insertIfAbsent(owner: OwnerId, link: NewLink): Promise<{ link: Link; created: boolean }>;

  /** The link, or null when absent or owned by someone else. */
  get(owner: OwnerId, id: string): Promise<Link | null>;

  /**
   * Apply only the fields present in the patch, per field (not a whole-row
   * rewrite). A `tags` field replaces the link's whole tag set. Returns the
   * updated link, or null when absent or foreign; then nothing is written,
   * including tags and catalog rows.
   */
  update(owner: OwnerId, id: string, patch: LinkPatch): Promise<Link | null>;

  /**
   * Conditional write: set why only if it is currently null. Returns the link
   * as it is after the call, or null when absent or foreign.
   */
  fillWhyIfMissing(owner: OwnerId, id: string, why: Labelled): Promise<Link | null>;
}
