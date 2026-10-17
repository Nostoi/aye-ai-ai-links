import { CoreError } from "./errors.js";
import { checkImage } from "./image-type.js";
import type { LinkEdit, LinkEditStore } from "./link-edit-store.js";
import { normalizeTitle, notFound } from "./links.js";
import type { OwnerId } from "./types.js";

export type EditDeps = { edits: LinkEditStore; now: () => Date };

/** What the owner asked to change: a title (null or blank removes it), the picture's bytes, or "page". */
export type EditInput = { title?: string | null; picture?: Uint8Array | "page" };

export const BAD_PICTURE = "That picture can't be used. Try a PNG, JPEG, GIF or WebP under 2 MB.";
export const UNDO_CONFLICT = "This link changed since, so nothing was undone.";

/**
 * The owner's edit of a link's title and picture. The title goes through the one title rule and
 * the picture through the one image check, both before anything is written. "page" removes the
 * owner's picture, so the page's shows. The store applies the edit in one transaction. Returns
 * the edit's id for its Undo, or null when nothing changed.
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
  const result = await deps.edits.applyEdit(owner, id, edit, deps.now());
  if (!result) throw notFound(id);
  return result.editId;
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
