import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ImageType } from "../core/fetch.js";
import type { LinkEdit, LinkEditStore, UndoOutcome } from "../core/link-edit-store.js";
import type { OwnerId } from "../core/types.js";
import { parseId } from "./sqlite-store.js";

type OwnPicture = { content_type: ImageType; bytes: Buffer; sha256: string; set_at: number };
type EditRow = {
  edit_id: string;
  title_changed: number;
  picture_changed: number;
  prior_title: string | null;
  written_title: string | null;
  prior_content_type: ImageType | null;
  prior_bytes: Buffer | null;
  prior_sha256: string | null;
  prior_set_at: number | null;
  written_sha256: string | null;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The owner's title and picture edits (`owner_images`, `link_edits`) and their Undo. */
export class SqliteLinkEditStore implements LinkEditStore {
  constructor(private readonly db: Database) {}

  async applyEdit(owner: OwnerId, linkId: string, edit: LinkEdit, at: Date) {
    const n = parseId(linkId);
    if (n === null) return null;
    const set = edit.picture !== undefined && edit.picture !== "page" ? edit.picture.set : null;
    const setSha = set ? sha256(set.bytes) : null;
    return this.db
      .transaction((): { editId: string | null } | null => {
        const link = this.link(owner, n);
        if (!link) return null;
        const own = this.own(owner, n);
        const titleChanged = edit.title !== undefined && edit.title !== link.title;
        const pictureChanged =
          edit.picture === "page" ? own !== undefined : setSha !== null && own?.sha256 !== setSha;
        if (!titleChanged && !pictureChanged) return { editId: null };
        const editId = randomUUID();
        const prior = pictureChanged ? own : undefined;
        this.db
          .prepare(
            `INSERT OR REPLACE INTO link_edits (owner_id, link_id, edit_id, title_changed,
               picture_changed, prior_title, written_title, prior_content_type, prior_bytes,
               prior_sha256, prior_set_at, written_sha256, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            owner,
            n,
            editId,
            titleChanged ? 1 : 0,
            pictureChanged ? 1 : 0,
            titleChanged ? link.title : null,
            titleChanged ? (edit.title ?? null) : null,
            prior?.content_type ?? null,
            prior?.bytes ?? null,
            prior?.sha256 ?? null,
            prior?.set_at ?? null,
            pictureChanged ? setSha : null,
            at.getTime(),
          );
        if (titleChanged) this.writeTitle(owner, n, edit.title ?? null);
        if (pictureChanged) {
          if (set && setSha) {
            this.writeOwn(owner, n, {
              content_type: set.contentType,
              bytes: Buffer.from(set.bytes),
              sha256: setSha,
              set_at: at.getTime(),
            });
          } else this.removeOwn(owner, n);
        }
        return { editId };
      })
      .immediate();
  }

  async undoEdit(owner: OwnerId, linkId: string, editId: string): Promise<UndoOutcome | null> {
    const n = parseId(linkId);
    if (n === null) return null;
    return this.db
      .transaction((): UndoOutcome | null => {
        const link = this.link(owner, n);
        if (!link) return null;
        const row = this.db
          .prepare("SELECT * FROM link_edits WHERE owner_id = ? AND link_id = ?")
          .get(owner, n) as EditRow | undefined;
        if (!row || row.edit_id !== editId) return "conflict";
        const titleHolds = row.title_changed === 0 || link.title === row.written_title;
        const pictureHolds =
          row.picture_changed === 0 || (this.own(owner, n)?.sha256 ?? null) === row.written_sha256;
        if (!titleHolds || !pictureHolds) return "conflict";
        if (row.title_changed === 1) this.writeTitle(owner, n, row.prior_title);
        if (row.picture_changed === 1) {
          if (row.prior_bytes === null) this.removeOwn(owner, n);
          else {
            this.writeOwn(owner, n, {
              content_type: row.prior_content_type as ImageType,
              bytes: row.prior_bytes,
              sha256: row.prior_sha256 as string,
              set_at: row.prior_set_at as number,
            });
          }
        }
        this.db.prepare("DELETE FROM link_edits WHERE owner_id = ? AND link_id = ?").run(owner, n);
        return "undone";
      })
      .immediate();
  }

  private link(owner: OwnerId, n: number) {
    return this.db
      .prepare("SELECT title FROM links WHERE owner_id = ? AND id = ? AND deleted_at IS NULL")
      .get(owner, n) as { title: string | null } | undefined;
  }

  private own(owner: OwnerId, n: number) {
    return this.db
      .prepare(
        "SELECT content_type, bytes, sha256, set_at FROM owner_images WHERE owner_id = ? AND link_id = ?",
      )
      .get(owner, n) as OwnPicture | undefined;
  }

  /** The links row's own update fires the keyword index triggers, as `SqliteStore.update` does. */
  private writeTitle(owner: OwnerId, n: number, title: string | null): void {
    this.db
      .prepare("UPDATE links SET title = ? WHERE owner_id = ? AND id = ?")
      .run(title, owner, n);
  }

  private writeOwn(owner: OwnerId, n: number, p: OwnPicture): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO owner_images (owner_id, link_id, content_type, bytes, sha256, set_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(owner, n, p.content_type, p.bytes, p.sha256, p.set_at);
  }

  private removeOwn(owner: OwnerId, n: number): void {
    this.db.prepare("DELETE FROM owner_images WHERE owner_id = ? AND link_id = ?").run(owner, n);
  }
}
