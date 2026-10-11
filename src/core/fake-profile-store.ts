import type { ProfileChanges, ProfileStore, ProfileWrite } from "./profile-store.js";
import type { FocusEntry, OwnerId, ProfileNote } from "./types.js";

/** In-memory ProfileStore for tests; honours the same contracts as the real store. */
export class FakeProfileStore implements ProfileStore {
  private notes = new Map<OwnerId, ProfileNote[]>();
  private focus = new Map<OwnerId, FocusEntry[]>();
  // Counters only go up, so a removed note's id is never issued again.
  private nextNoteId = 1;
  private nextFocusId = 1;

  private notesOf(owner: OwnerId): ProfileNote[] {
    return this.notes.get(owner) ?? [];
  }

  private newestFocus(owner: OwnerId, limit: number): FocusEntry[] {
    return [...(this.focus.get(owner) ?? [])]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || Number(b.id) - Number(a.id))
      .slice(0, limit)
      .map((f) => structuredClone(f));
  }

  async listNotes(owner: OwnerId) {
    return structuredClone(this.notesOf(owner));
  }

  async recentFocus(owner: OwnerId, limit: number) {
    return this.newestFocus(owner, limit);
  }

  async apply(
    owner: OwnerId,
    changes: ProfileChanges,
    { writtenBy, at, focusLimit }: { writtenBy: string; at: Date; focusLimit: number },
  ): Promise<({ ok: true } & ProfileWrite) | { ok: false; unknownId: string }> {
    const mine = this.notesOf(owner);
    // Check every id first, so a failure writes nothing.
    for (const id of [...changes.editNotes.map((e) => e.id), ...changes.removeNotes]) {
      if (!mine.some((n) => n.id === id)) return { ok: false, unknownId: id };
    }
    for (const e of changes.editNotes) {
      const note = mine.find((n) => n.id === e.id) as ProfileNote;
      Object.assign(note, { text: e.text, source: e.source, writtenBy, updatedAt: new Date(at) });
    }
    const kept = mine.filter((n) => !changes.removeNotes.includes(n.id));
    const addedNoteIds: string[] = [];
    for (const n of changes.addNotes) {
      const id = String(this.nextNoteId++);
      addedNoteIds.push(id);
      kept.push({ id, text: n.text, source: n.source, writtenBy, updatedAt: new Date(at) });
    }
    this.notes.set(owner, kept);
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
      notes: structuredClone(kept),
      recentFocus: this.newestFocus(owner, focusLimit),
      addedNoteIds,
      addedFocusIds,
    };
  }
}
