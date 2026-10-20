import type { ImageBytes } from "./image-store.js";
import type { OwnerId } from "./types.js";

/** A picture edit: set the owner's picture, or "page" to remove it so the fetched one shows. */
export type PictureEdit = { set: ImageBytes } | "page";

/** What one edit asks for. An absent field is left as it is; a null title removes the title. */
export type LinkEdit = { title?: string | null; picture?: PictureEdit };

export type UndoOutcome = "undone" | "conflict";

/**
 * Persistence contract for the owner's title and picture edits and their Undo. Any
 * implementation must meet all of it. The rules (the title rule, the image check) are core's:
 * the store writes what it is given.
 *
 * - Owner scoping: both methods take the owner and never read or change another owner's link;
 *   another owner's link reads as absent (null).
 * - Ids: those of `LinkStore`. An id never issued yields null, never an error.
 * - The fetched picture (`ImageStore`'s) is never read or written here.
 */
export interface LinkEditStore {
  /**
   * In one transaction: reads the link's title and owner picture. When neither would change,
   * writes nothing and returns `{ editId: null }`. Otherwise it replaces the link's edit record
   * with what this edit replaced and wrote, under a new random edit id, applies the edit and
   * returns that id. Null when the link is absent.
   */
  applyEdit(
    owner: OwnerId,
    linkId: string,
    edit: LinkEdit,
    at: Date,
  ): Promise<{ editId: string | null } | null>;

  /**
   * In one transaction: puts back what the edit replaced, and removes its record. It does this
   * only while the record's edit id is `editId` and the link still holds what the edit wrote
   * (its title, summary, why or ordered tags, and its owner picture or none, for each of those
   * the edit changed). Restoring tags re-attaches the prior ones in their order and sources; a
   * tag catalog row is never deleted and an existing one keeps its kind. Otherwise "conflict",
   * and nothing changes. Null when the link is absent.
   */
  undoEdit(owner: OwnerId, linkId: string, editId: string): Promise<UndoOutcome | null>;
}
