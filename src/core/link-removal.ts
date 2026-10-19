import { CoreError } from "./errors.js";
import { COPY_UNDO_WINDOW_MS } from "./saved-copy.js";
import type { LinkRemover } from "./store.js";
import type { OwnerId } from "./types.js";

/** Shared with saved copies: delete removes the copy, so both Undo windows must end together. */
export const LINK_UNDO_WINDOW_MS = COPY_UNDO_WINDOW_MS;

type RemovalDeps = { store: LinkRemover; now: () => Date };

/** Hides the owner's link at once; not_found when it is absent or already hidden. */
export async function deleteLink(deps: RemovalDeps, owner: OwnerId, id: string): Promise<void> {
  if (!(await deps.store.markDeleted(owner, id, deps.now()))) {
    throw new CoreError("not_found", "That link is not there any more. Reload the page.");
  }
}

/** Undoes a delete within LINK_UNDO_WINDOW_MS; not_found otherwise. */
export async function restoreLink(deps: RemovalDeps, owner: OwnerId, id: string): Promise<void> {
  const since = new Date(deps.now().getTime() - LINK_UNDO_WINDOW_MS);
  if (!(await deps.store.unmarkDeleted(owner, id, since))) {
    throw new CoreError("not_found", "It's too late to undo: the link was deleted for good.");
  }
}

/** Deletes, for every owner, the links hidden longer than LINK_UNDO_WINDOW_MS ago. Returns how many. */
export function purgeDeletedLinks(deps: RemovalDeps): Promise<number> {
  return deps.store.purgeDeleted(new Date(deps.now().getTime() - LINK_UNDO_WINDOW_MS));
}

export type LinkPurgerOptions = {
  store: LinkRemover;
  now: () => Date;
  /** Time between purges. Default 60 s. */
  everyMs?: number;
  log?: (message: string, error?: unknown) => void;
};

/** Purges once at `start`, then every `everyMs`, never overlapping; a failure is logged and the timer goes on. */
export function createLinkPurger(o: LinkPurgerOptions): { start(): void; stop(): void } {
  const everyMs = o.everyMs ?? 60_000;
  const log =
    o.log ??
    ((message, error) =>
      error === undefined ? console.error(message) : console.error(message, error));
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    try {
      await purgeDeletedLinks(o);
    } catch (error) {
      log("link purge failed", error);
    }
    if (!stopped) timer = setTimeout(tick, everyMs);
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      void tick();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
