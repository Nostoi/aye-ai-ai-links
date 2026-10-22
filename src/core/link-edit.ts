import { CoreError } from "./errors.js";
import { checkImage } from "./image-type.js";
import type { LinkEdit, LinkEditStore } from "./link-edit-store.js";
import { isSource, normalizeTitle, notFound } from "./links.js";
import { normalizeTags } from "./tags.js";
import type { OwnerId, Source } from "./types.js";

export type EditDeps = { edits: LinkEditStore; now: () => Date };

/**
 * What the owner asked to change: a title (null or blank removes it), the picture's bytes or
 * "page", and the link's tags. `tags.names` is the final list in order; `tags.seen` is the
 * ordered key and source of each tag the owner's dialog opened with.
 */
export type EditInput = {
  title?: string | null;
  picture?: Uint8Array | "page";
  tags?: { names: string[]; seen: { key: string; source: string }[] };
};

export const BAD_PICTURE = "That picture can't be used. Try a PNG, JPEG, GIF or WebP under 2 MB.";
export const UNDO_CONFLICT = "This link changed since, so nothing was undone.";
export const TAGS_CONFLICT =
  "This link's tags changed since you opened it. Close and open Edit again.";

/**
 * The owner's edit of a link's title, picture and tags. The title goes through the one title
 * rule, the picture through the one image check and the names through the one tag rule, all
 * before anything is written. "page" removes the owner's picture, so the page's shows. A tag
 * the dialog opened with keeps its source, so removing one and adding it back changes nothing;
 * any other name is stated. The store applies the edit in one transaction, and only while the
 * link still holds the tags the dialog opened with (otherwise a conflict, and nothing is
 * written). Returns the edit's id for its Undo, or null when nothing changed.
 */
export async function editLink(
  deps: EditDeps,
  owner: OwnerId,
  id: string,
  input: EditInput,
): Promise<string | null> {
  const edit: LinkEdit = {};
  if (input.title !== undefined) edit.title = normalizeTitle(input.title);
  if (input.picture === "page") edit.picture = "page";
  else if (input.picture !== undefined) {
    const check = checkImage(input.picture);
    if (!check.ok) throw new CoreError("invalid_input", BAD_PICTURE);
    edit.picture = { set: { contentType: check.type, bytes: input.picture } };
  }
  if (input.tags) edit.tags = tagEdit(input.tags);
  const result = await deps.edits.applyEdit(owner, id, edit, deps.now());
  if (!result) throw notFound(id);
  if (result === "conflict") throw new CoreError("conflict", TAGS_CONFLICT);
  return result.editId;
}

function tagEdit({ names, seen }: NonNullable<EditInput["tags"]>): NonNullable<LinkEdit["tags"]> {
  const sources = new Map<string, Source>();
  for (const t of seen) {
    if (!isSource(t.source)) {
      throw new CoreError("invalid_input", `A tag's source is "${t.source}", which is not one.`);
    }
    sources.set(t.key, t.source);
  }
  const set = normalizeTags(names.map((name) => ({ name, source: "stated" as const }))).map((t) => {
    const source = sources.get(t.key);
    return source ? { ...t, source } : t;
  });
  return { expected: seen.map((t) => ({ key: t.key, source: t.source as Source })), set };
}

/**
 * The Undo of `editLink`: it puts back what the edit replaced only while the edit is the link's
 * latest and the link still holds what it wrote. Otherwise it is a conflict, and nothing changes.
 */
export async function undoEdit(
  deps: Pick<EditDeps, "edits">,
  owner: OwnerId,
  id: string,
  editId: string,
): Promise<void> {
  const outcome = await deps.edits.undoEdit(owner, id, editId);
  if (outcome === null) throw notFound(id);
  if (outcome === "conflict") throw new CoreError("conflict", UNDO_CONFLICT);
}
