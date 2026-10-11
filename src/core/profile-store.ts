import type { FocusEntry, Labelled, OwnerId, ProfileNote, Source } from "./types.js";

/** Already cleaned by core: trimmed, non-blank, within the caps, with valid sources. */
export type ProfileChanges = {
  addNotes: Labelled[];
  editNotes: { id: string; text: string; source: Source }[];
  removeNotes: string[];
  addFocus: Labelled[];
};

/** The profile as it stands once a write has committed, plus the ids that write issued. */
export type ProfileWrite = {
  notes: ProfileNote[];
  recentFocus: FocusEntry[];
  addedNoteIds: string[];
  addedFocusIds: string[];
};

/**
 * Persistence contract for the owner's profile notes and focus log. Any
 * implementation must meet all of it.
 *
 * - Owner scoping: every method takes the owner first and never reads or
 *   changes another owner's notes or focus entries.
 * - Ids: decimal strings. An id the store never issued, or one that belongs to
 *   another owner, is simply absent. The id of a removed note is never issued
 *   again.
 * - Owners: adding for an owner that does not exist fails with an Error whose
 *   `code` is "unknown_owner", and writes nothing.
 */
export interface ProfileStore {
  /** The owner's notes, oldest first (by id). [] for an unknown owner. */
  listNotes(owner: OwnerId): Promise<ProfileNote[]>;

  /** The owner's newest focus entries, newest first (created_at, then id), at most `limit`. */
  recentFocus(owner: OwnerId, limit: number): Promise<FocusEntry[]>;

  /**
   * Apply every change in one atomic step: edits, then removes, then adds.
   * An edit replaces the note's text and source and restamps its writer and
   * `updatedAt`. If any edit or remove id is absent, foreign or never issued,
   * nothing is written and the result names that id. On success the result is
   * read inside the same atomic step, so a committed write is never reported
   * as failed by a later read.
   */
  apply(
    owner: OwnerId,
    changes: ProfileChanges,
    context: { writtenBy: string; at: Date; focusLimit: number },
  ): Promise<({ ok: true } & ProfileWrite) | { ok: false; unknownId: string }>;
}
