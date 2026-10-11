import type { Database } from "better-sqlite3";
import type { ProfileChanges, ProfileStore, ProfileWrite } from "../core/profile-store.js";
import type { FocusEntry, OwnerId, ProfileNote, Source } from "../core/types.js";
import { parseId, StoreError } from "./sqlite-store.js";

type NoteRow = { id: number; text: string; source: Source; written_by: string; updated_at: number };
type FocusRow = {
  id: number;
  text: string;
  source: Source;
  written_by: string;
  created_at: number;
};

/** Thrown inside the transaction so the rollback undoes the writes made before it. */
class UnknownNote extends Error {
  constructor(readonly unknownId: string) {
    super(`No profile note with id "${unknownId}".`);
  }
}

const toNote = (r: NoteRow): ProfileNote => ({
  id: String(r.id),
  text: r.text,
  source: r.source,
  writtenBy: r.written_by,
  updatedAt: new Date(r.updated_at),
});

const toFocus = (r: FocusRow): FocusEntry => ({
  id: String(r.id),
  text: r.text,
  source: r.source,
  writtenBy: r.written_by,
  createdAt: new Date(r.created_at),
});

function ms(d: Date): number {
  const t = d.getTime();
  if (!Number.isFinite(t)) throw new RangeError("Cannot store an invalid date.");
  return t;
}

/** Owner-scoped profile persistence. Owners are created elsewhere (`SqliteStore.ensureUser`). */
export class SqliteProfileStore implements ProfileStore {
  constructor(private readonly db: Database) {}

  async listNotes(owner: OwnerId) {
    return this.notes(owner);
  }

  async recentFocus(owner: OwnerId, limit: number) {
    return this.focus(owner, limit);
  }

  async apply(
    owner: OwnerId,
    changes: ProfileChanges,
    context: { writtenBy: string; at: Date; focusLimit: number },
  ): Promise<({ ok: true } & ProfileWrite) | { ok: false; unknownId: string }> {
    try {
      const written = this.db
        .transaction(() => this.applySync(owner, changes, context))
        .immediate();
      return { ok: true, ...written };
    } catch (e) {
      if (e instanceof UnknownNote) return { ok: false, unknownId: e.unknownId };
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        throw new StoreError(
          "unknown_owner",
          `Owner "${owner}" does not exist. Create it with ensureUser first.`,
        );
      }
      throw e;
    }
  }

  private applySync(
    owner: OwnerId,
    changes: ProfileChanges,
    { writtenBy, at, focusLimit }: { writtenBy: string; at: Date; focusLimit: number },
  ): ProfileWrite {
    const when = ms(at);
    const edit = this.db.prepare(
      "UPDATE profile_notes SET text = ?, source = ?, written_by = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
    );
    for (const e of changes.editNotes) {
      const id = parseId(e.id);
      if (id === null || edit.run(e.text, e.source, writtenBy, when, id, owner).changes === 0) {
        throw new UnknownNote(e.id);
      }
    }
    const remove = this.db.prepare("DELETE FROM profile_notes WHERE id = ? AND owner_id = ?");
    for (const raw of changes.removeNotes) {
      const id = parseId(raw);
      if (id === null || remove.run(id, owner).changes === 0) throw new UnknownNote(raw);
    }
    const addNote = this.db.prepare(
      "INSERT INTO profile_notes (owner_id, text, source, written_by, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const addedNoteIds = changes.addNotes.map((n) =>
      String(addNote.run(owner, n.text, n.source, writtenBy, when).lastInsertRowid),
    );
    const addFocus = this.db.prepare(
      "INSERT INTO focus_log (owner_id, text, source, written_by, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const addedFocusIds = changes.addFocus.map((f) =>
      String(addFocus.run(owner, f.text, f.source, writtenBy, when).lastInsertRowid),
    );
    return {
      notes: this.notes(owner),
      recentFocus: this.focus(owner, focusLimit),
      addedNoteIds,
      addedFocusIds,
    };
  }

  private notes(owner: OwnerId): ProfileNote[] {
    const rows = this.db
      .prepare(
        "SELECT id, text, source, written_by, updated_at FROM profile_notes WHERE owner_id = ? ORDER BY id",
      )
      .all(owner) as NoteRow[];
    return rows.map(toNote);
  }

  private focus(owner: OwnerId, limit: number): FocusEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, text, source, written_by, created_at FROM focus_log
         WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(owner, limit) as FocusRow[];
    return rows.map(toFocus);
  }
}
