import { CoreError } from "./errors.js";
import type { LinkStore } from "./store.js";
import type { TagEditStore, TagSettings } from "./tag-edit-store.js";
import { cleanTagName, tagKey } from "./tags.js";
import type { OwnerId, Tag } from "./types.js";

/** How long a merge or delete can be undone, from the page or an AI (owner, 2026-10-23). */
export const TAG_UNDO_WINDOW_MS = 3_600_000;

type TagEditDeps = { store: LinkStore; tagEdits: TagEditStore; now: () => Date };

// Also what the Tags page shows: it may already have been undone, from there or from an AI.
const TOO_LATE =
  "It's too late to undo: that change was already undone, or can no longer be undone.";
const UNDO_CONFLICT = "The tags changed since, so nothing was undone.";
const UNDO_BLOCKED =
  "A later change to the same tags is in the way, so nothing was undone. Undoing that one first may not be enough.";

const notFound = (name: string) =>
  new CoreError(
    "not_found",
    `No tag named "${name}" was found. Ask the owner for the exact name; list_tags shows the names in use.`,
  );

const conflict = (name: string) =>
  new CoreError(
    "conflict",
    `The tag "${name}" was changed by someone else while this ran. Look at the tags again and, if it should still change, repeat the request.`,
  );

const cutoff = (now: Date) => new Date(now.getTime() - TAG_UNDO_WINDOW_MS);

/**
 * The settings the kept tag ends a merge with. It keeps its own colour, description, kind and
 * status; it is pinned if either was. The exception: a topic that absorbs a project the owner
 * marked (stated or asked) becomes that project, with its status and source.
 */
export function mergedSettings(from: Tag, into: Tag): TagSettings {
  const takesProject =
    into.kind === "topic" &&
    from.kind === "project" &&
    (from.kindSource === "stated" || from.kindSource === "asked");
  const kindOf = takesProject ? from : into;
  return {
    kind: kindOf.kind,
    kindSource: kindOf.kindSource,
    projectStatus: kindOf.projectStatus,
    pinned: from.pinned || into.pinned,
    color: into.color ?? from.color,
    description: into.description ?? from.description,
  };
}

export async function listTagsWithCounts(
  { store, tagEdits }: Pick<TagEditDeps, "store" | "tagEdits">,
  owner: OwnerId,
): Promise<{ tag: Tag; links: number }[]> {
  const [tags, counts] = await Promise.all([store.listTags(owner), tagEdits.tagLinkCounts(owner)]);
  return tags.map((tag) => ({ tag, links: counts.get(tag.key) ?? 0 }));
}

/**
 * Give a tag a new name. When another tag already has the new name's key, nothing changes and
 * the other tag comes back with its live count, so the caller can offer a merge. A change of
 * capitals or spacing keeps the key and renames in place.
 */
export async function renameTag(
  deps: TagEditDeps,
  owner: OwnerId,
  input: { name: string; newName: string },
): Promise<{ renamed: Tag } | { taken: Tag; links: number }> {
  const key = tagKey(input.name);
  const newName = cleanTagName(input.newName);
  const result = await deps.tagEdits.renameTag(owner, key, newName, tagKey(newName));
  if (result === null) throw notFound(input.name);
  if (result !== "taken") return { renamed: result };
  const all = await listTagsWithCounts(deps, owner);
  const other = all.find((t) => t.tag.key === tagKey(newName));
  if (!other) throw conflict(input.name);
  return { taken: other.tag, links: other.links };
}

/**
 * Move one tag's links onto another and remove it. The write only lands while both tags are
 * still as read; if they moved, read again once, then report a conflict.
 */
export async function mergeTags(
  { store, tagEdits, now }: TagEditDeps,
  owner: OwnerId,
  input: { name: string; into: string },
): Promise<{ tag: Tag; changeId: string; moved: number; links: number }> {
  const fromKey = tagKey(input.name);
  const intoKey = tagKey(input.into);
  if (fromKey === intoKey) {
    throw new CoreError(
      "invalid_input",
      `"${input.name}" and "${input.into}" are the same tag. Name a different tag to merge it into.`,
    );
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const tags = await store.listTags(owner);
    const from = tags.find((t) => t.key === fromKey);
    if (!from) throw notFound(input.name);
    const into = tags.find((t) => t.key === intoKey);
    if (!into) throw notFound(input.into);
    const at = now();
    const done = await tagEdits.mergeTag(owner, {
      from,
      into,
      set: mergedSettings(from, into),
      at,
      pruneBefore: cutoff(at),
    });
    if (done === null) {
      const left = await store.listTags(owner);
      throw notFound(left.some((t) => t.key === fromKey) ? input.into : input.name);
    }
    if (done !== "conflict") return done;
  }
  throw conflict(input.name);
}

/** Take a tag off every link and remove it, with the same read-again-once rule as a merge. */
export async function deleteTag(
  { store, tagEdits, now }: TagEditDeps,
  owner: OwnerId,
  input: { name: string },
): Promise<{ changeId: string; moved: number }> {
  const key = tagKey(input.name);
  for (let attempt = 0; attempt < 2; attempt++) {
    const tag = (await store.listTags(owner)).find((t) => t.key === key);
    if (!tag) throw notFound(input.name);
    const at = now();
    const done = await tagEdits.deleteTag(owner, { tag, at, pruneBefore: cutoff(at) });
    if (done === null) throw notFound(input.name);
    if (done !== "conflict") return done;
  }
  throw conflict(input.name);
}

/** Put back what a merge or delete changed, within the window. Refused, unchanged, if the tags have moved since. */
export async function undoTagChange(
  { tagEdits, now }: TagEditDeps,
  owner: OwnerId,
  changeId: string,
): Promise<{ tag: Tag; links: number }[]> {
  const done = await tagEdits.undoTagChange(owner, changeId, cutoff(now()));
  if (done === null) throw new CoreError("not_found", TOO_LATE);
  if (done === "conflict") throw new CoreError("conflict", UNDO_CONFLICT);
  if (done === "blocked") throw new CoreError("conflict", UNDO_BLOCKED);
  return done.tags;
}

/** The live key an old tag name or address now reaches, or null. */
export function tagAddress(
  { tagEdits }: TagEditDeps,
  owner: OwnerId,
  name: string,
): Promise<string | null> {
  return tagEdits.currentKey(owner, tagKey(name));
}
