import { CoreError } from "./errors.js";
import { COPY_UNDO_WINDOW_MS, type SavedCopyRemover } from "./saved-copy.js";
import type { OwnerId } from "./types.js";

type RemovalDeps = { savedCopies: SavedCopyRemover; now: () => Date };

/** Removes the owner's copy at once; not_found when there is no ok copy. */
export async function removeSavedCopy(
  deps: RemovalDeps,
  owner: OwnerId,
  id: string,
): Promise<void> {
  if (!(await deps.savedCopies.removeCopy(owner, id, deps.now()))) {
    throw new CoreError("not_found", "That saved copy is not there any more. Reload the page.");
  }
}

/** Undoes a removal within COPY_UNDO_WINDOW_MS; not_found otherwise. */
export async function restoreSavedCopy(
  deps: RemovalDeps,
  owner: OwnerId,
  id: string,
): Promise<void> {
  const since = new Date(deps.now().getTime() - COPY_UNDO_WINDOW_MS);
  if (!(await deps.savedCopies.restoreCopy(owner, id, since))) {
    throw new CoreError("not_found", "It's too late to undo: the saved copy was removed for good.");
  }
}
