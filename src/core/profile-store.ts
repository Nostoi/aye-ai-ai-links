import type { FocusEntry, Labelled, OwnerId, ProfileNote, Source } from "./types.js";

/**
 * Already cleaned by core: trimmed, non-blank, within the caps, with valid sources. An edit or
 * remove applies only while the note still has `expectedSource` and, when given,
 * `expectedUpdatedAt`.
 */
export type ProfileChanges = {
  addNotes: Labelled[];
  editNotes: {
    id: string;
    text: string;
    source: Source;
    expectedSource: Source;
    expectedUpdatedAt?: Date;
  }[];
  removeNotes: { id: string; expectedSource: Source; expectedUpdatedAt?: Date }[];
  addFocus: Labelled[];
};

/** The profile as it stands once a write has committed, plus the ids that write issued. */
export type ProfileWrite = {
  notes: ProfileNote[];
  recentFocus: FocusEntry[];
  addedNoteIds: string[];
  addedFocusIds: string[];
};

export type ProfileApplyResult =
  | ({ ok: true } & ProfileWrite)
  | { ok: false; unknownId: string }
  | { ok: false; conflictId: string };

/**
 * Persistence contract for the owner's profile notes and focus log. Any
 * implementation must meet all of it.
 *
 * - Owner scoping: every method takes the owner first and never reads or
 *   changes another owner's notes or focus entries.
 * - Ids: decimal strings. An id the store never issued, or one that belongs to
 *   another owner, is simply absent. The id of a removed note is never issued
 *   again.
 * - Removal is soft: a removed note keeps its row, unchanged, and is absent to
 *   every read, edit and remove until `restoreNote` brings it back. The owner's
 *   notes removed before a cutoff are deleted (purged) by that owner's next
 *   `apply` or `restoreNote`.
 * - Owners: adding for an owner that does not exist fails with an Error whose
 *   `code` is "unknown_owner", and writes nothing.
 */
export interface ProfileStore {
  /** The owner's notes, oldest first (by id). [] for an unknown owner. */
  listNotes(owner: OwnerId): Promise<ProfileNote[]>;

  /** The owner's newest focus entries, newest first (created_at, then id), at most `limit`. */
  recentFocus(owner: OwnerId, limit: number): Promise<FocusEntry[]>;

  /** The owner's whole focus log, oldest first (created_at, then id). [] for an unknown owner. */
  listFocus(owner: OwnerId): Promise<FocusEntry[]>;

  /**
   * Apply every change in one atomic step: purge, then edits, then removes, then adds.
   * The purge deletes the owner's notes removed before `purgeBefore`. An edit replaces the
   * note's text and source and restamps its writer and `updatedAt`. A remove marks the note
   * removed at `at`. If any edit or remove id is absent, foreign or never issued, nothing is
   * written and the result names that id; if the note is there but no longer as expected, the
   * result is a conflict. On success the result is read inside the same atomic step, so a
   * committed write is never reported as failed by a later read.
   */
  apply(
    owner: OwnerId,
    changes: ProfileChanges,
    context: { writtenBy: string; at: Date; focusLimit: number; purgeBefore: Date },
  ): Promise<ProfileApplyResult>;

  /**
   * In one atomic step, purge the owner's notes removed before `removedSince`, then bring back
   * the owner's note `id` if it was removed at or after it, exactly as it was. False, changing
   * nothing else, when there is no such removed note.
   */
  restoreNote(owner: OwnerId, id: string, removedSince: Date): Promise<boolean>;
}
