import type { ProfileApplyResult, ProfileChanges, ProfileStore } from "./profile-store.js";
import type { FocusEntry, OwnerId, ProfileNote } from "./types.js";

type Stored = ProfileNote & { removedAt: Date | null };

const shown = (notes: Stored[]): ProfileNote[] =>
  notes
    .filter((n) => n.removedAt === null)
    .map(({ removedAt: _removedAt, ...note }) => structuredClone(note));

/** In-memory ProfileStore for tests; honours the same contracts as the real store. */
export class FakeProfileStore implements ProfileStore {
  private notes = new Map<OwnerId, Stored[]>();
  private focus = new Map<OwnerId, FocusEntry[]>();
  // Counters only go up, so a removed note's id is never issued again.
  private nextNoteId = 1;
  private nextFocusId = 1;

  private notesOf(owner: OwnerId): Stored[] {
    return this.notes.get(owner) ?? [];
  }

  private purge(owner: OwnerId, before: Date) {
    this.notes.set(
      owner,
      this.notesOf(owner).filter((n) => n.removedAt === null || n.removedAt >= before),
    );
  }

  private newestFocus(owner: OwnerId, limit: number): FocusEntry[] {
    return [...(this.focus.get(owner) ?? [])]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || Number(b.id) - Number(a.id))
      .slice(0, limit)
      .map((f) => structuredClone(f));
  }

  async listNotes(owner: OwnerId) {
    return shown(this.notesOf(owner));
  }

  async recentFocus(owner: OwnerId, limit: number) {
    return this.newestFocus(owner, limit);
  }

  async apply(
    owner: OwnerId,
    changes: ProfileChanges,
    {
      writtenBy,
      at,
      focusLimit,
      purgeBefore,
    }: { writtenBy: string; at: Date; focusLimit: number; purgeBefore: Date },
  ): Promise<ProfileApplyResult> {
    const live = this.notesOf(owner).filter((n) => n.removedAt === null);
    // Check every id first, so a failure writes nothing.
    for (const { id, expectedSource, expectedUpdatedAt } of [
      ...changes.editNotes,
      ...changes.removeNotes,
    ]) {
      const note = live.find((n) => n.id === id);
      if (!note) return { ok: false, unknownId: id };
      if (
        note.source !== expectedSource ||
        (expectedUpdatedAt !== undefined &&
          note.updatedAt.getTime() !== expectedUpdatedAt.getTime())
      ) {
        return { ok: false, conflictId: id };
      }
    }
    this.purge(owner, purgeBefore);
    const mine = this.notesOf(owner);
    for (const e of changes.editNotes) {
      const note = mine.find((n) => n.id === e.id) as Stored;
      Object.assign(note, { text: e.text, source: e.source, writtenBy, updatedAt: new Date(at) });
    }
    for (const r of changes.removeNotes) {
      (mine.find((n) => n.id === r.id) as Stored).removedAt = new Date(at);
    }
    const addedNoteIds: string[] = [];
    for (const n of changes.addNotes) {
      const id = String(this.nextNoteId++);
      addedNoteIds.push(id);
      mine.push({
        id,
        text: n.text,
        source: n.source,
        writtenBy,
        updatedAt: new Date(at),
        removedAt: null,
      });
    }
    this.notes.set(owner, mine);
    const addedFocusIds: string[] = [];
    const log = this.focus.get(owner) ?? [];
    for (const f of changes.addFocus) {
      const id = String(this.nextFocusId++);
      addedFocusIds.push(id);
      log.push({ id, text: f.text, source: f.source, writtenBy, createdAt: new Date(at) });
    }
    this.focus.set(owner, log);
    return {
      ok: true,
      notes: shown(mine),
      recentFocus: this.newestFocus(owner, focusLimit),
      addedNoteIds,
      addedFocusIds,
    };
  }

  async restoreNote(owner: OwnerId, id: string, removedSince: Date) {
    this.purge(owner, removedSince);
    const note = this.notesOf(owner).find((n) => n.id === id && n.removedAt !== null);
    if (!note) return false;
    note.removedAt = null;
    return true;
  }
}
