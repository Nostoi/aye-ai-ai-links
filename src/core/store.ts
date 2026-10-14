import type {
  Labelled,
  Link,
  LinkPatch,
  NewLink,
  OwnerId,
  Tag,
  TagKind,
  TagPatch,
} from "./types.js";

/**
 * Persistence contract used by core. Any implementation must meet all of it.
 *
 * - Owner scoping: every method takes the owner first and never reads or
 *   changes another owner's links or tags.
 * - Tags: identity is `key`, per owner. A key the owner has not used before is
 *   created with the attached name, kind and kindSource. Attaching an existing tag never
 *   changes its name, kind, kindSource, colour, pin or project fields; only updateTag, pinTag
 *   and colorTag do.
 *   Every returned LinkTag.name, .kind and .kindSource is the catalog's for its key, not the
 *   one passed in; each LinkTag keeps its own source. Tags come back in the order
 *   they were attached.
 * - Atomicity: each method that takes several steps (insert with tags, update
 *   with tags, read-back) either completes whole or changes nothing.
 * - Owners: the owner must exist (how is store-specific); saving for one that does not fails
 *   with an Error whose `code` is "unknown_owner".
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

  /**
   * The owner's whole tag catalog, ordered by key. Another owner's tags never
   * appear; an owner with no tags (or an unknown one) yields [], never an error.
   */
  listTags(owner: OwnerId): Promise<Tag[]>;

  /**
   * Conditional write: apply only the fields present in the patch to the
   * owner's tag with this key, and only while that tag's kind is still
   * `expectedKind`. Returns the tag as it is afterwards, or null when the owner
   * has no such key or its kind is no longer `expectedKind`; then nothing is
   * written. Never creates a tag and never touches another owner's. Links'
   * tags read the new values in calls that start afterwards. Project status is
   * a core rule: only core may write it, and never on a topic.
   */
  updateTag(
    owner: OwnerId,
    key: string,
    patch: TagPatch,
    expectedKind: TagKind,
  ): Promise<Tag | null>;

  /**
   * Pin or unpin the owner's tag with this key, in one write, whatever its kind. Pinning gives
   * the tag `color` only if it has none, so a color written just before is kept; unpinning keeps
   * the color. A pinned tag therefore always has a color: this is the only write of `pinned`, and
   * no write clears a color. Returns the tag as it is afterwards, or null when the owner has no
   * such key; then nothing is written. Which colors are allowed is a core rule.
   */
  pinTag(
    owner: OwnerId,
    key: string,
    pin: { pinned: true; color: string } | { pinned: false },
  ): Promise<Tag | null>;

  /**
   * Set the color of the owner's tag with this key, whatever its kind or pin. Returns the tag as
   * it is afterwards, or null when the owner has no such key; then nothing is written. Which
   * colors are allowed is a core rule.
   */
  colorTag(owner: OwnerId, key: string, color: string): Promise<Tag | null>;

  /**
   * Every one of the owner's links, in every state, each as `get` returns it, in the order the
   * store issued their ids. An owner with no links (or an unknown one) yields [].
   */
  listLinks(owner: OwnerId): Promise<Link[]>;

  /**
   * Conditional write, in one atomic step: for each id in input order that is the owner's, active,
   * not snoozed at `now` (snoozedUntil null or <= now) and has lastSurfacedAt null or <=
   * `notSurfacedAfter`, set lastSurfacedAt to `at` and return the link as read inside that step,
   * with the value it replaced. Core supplies the cutoffs, as with updateTag's `expectedKind`.
   * Foreign, unknown, malformed and no-longer-eligible ids are skipped, never an error; an id
   * given twice is claimed once. On an error nothing is written.
   */
  claimSurfaced(
    owner: OwnerId,
    ids: string[],
    when: { at: Date; notSurfacedAfter: Date; now: Date },
  ): Promise<SurfacedClaim[]>;
}

export type SurfacedClaim = { link: Link; previousSurfacedAt: Date | null };
