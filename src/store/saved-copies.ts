import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ImageType } from "../core/fetch.js";
import { imageVersion, type StoredImage } from "../core/image-store.js";
import {
  COPY_NONCE,
  type CopyCandidate,
  type CopyDraft,
  type CopyInfo,
  type CopyLimits,
  type FolderCheck,
  IMAGE_EXT,
  MAX_COPY_IMAGES,
  type NoCopyStatus,
  type ReadCopy,
  type SaveCopyResult,
  type SavedCopyMaintenance,
  type SavedCopyReader,
  type SavedCopyUsage,
  type SavedCopyWriter,
} from "../core/saved-copy.js";
import type { OwnerId } from "../core/types.js";
import { CopyFolder } from "./copy-folder.js";
import { parseId, toMs } from "./sqlite-store.js";

const failure = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message;

type Saved = Pick<SavedCopyWriter, "saveCopy" | "recordNoCopy">;
type Maintained = Pick<SavedCopyMaintenance, "checkFolder" | "backfillCandidates">;

/** Saved copies (#135): the `saved_copies*` rows and the folder holding their files. */
export class SqliteSavedCopyStore implements SavedCopyReader, SavedCopyUsage, Saved, Maintained {
  private readonly folder: CopyFolder;
  private check: FolderCheck = {
    state: "mismatch",
    detail: "The saved-copy folder is not checked",
  };
  private prepared = false;

  constructor(
    private readonly db: Database,
    private readonly root: string,
  ) {
    this.folder = new CopyFolder(root);
  }

  /** Reads work on a folder that is ready, or one that only refuses writes. */
  private get readable(): boolean {
    return this.check.state === "ready" || (this.check.state === "unwritable" && this.prepared);
  }

  async checkFolder(): Promise<FolderCheck> {
    this.prepared = false;
    this.check = this.runCheck();
    return this.check;
  }

  private runCheck(): FolderCheck {
    try {
      this.folder.prepare();
    } catch (e) {
      return { state: "unwritable", detail: failure(e) };
    }
    let row: { id: string } | undefined;
    let marker: string | null;
    let empty = true;
    try {
      row = this.db.prepare("SELECT id FROM saved_copy_library WHERE only = 1").get() as
        | { id: string }
        | undefined;
      marker = this.folder.readMarker();
      if (marker === null) empty = this.folder.isEmpty();
    } catch (e) {
      return { state: "mismatch", detail: `${this.root} could not be checked: ${failure(e)}` };
    }
    if (marker === null) {
      if (!empty) {
        return { state: "mismatch", detail: `${this.root} holds files but no saved-copy marker` };
      }
    } else if (!row) {
      return {
        state: "mismatch",
        detail: `${this.root} has a marker from another library; this database has none`,
      };
    } else if (marker !== row.id) {
      return { state: "mismatch", detail: `${this.root} has a marker from another library` };
    }
    this.prepared = true;
    try {
      if (marker === null) {
        const id = row?.id ?? randomUUID();
        if (!row)
          this.db.prepare("INSERT INTO saved_copy_library (only, id) VALUES (1, ?)").run(id);
        this.folder.writeMarker(id);
      }
      this.folder.probe();
    } catch (e) {
      return { state: "unwritable", detail: failure(e) };
    }
    return { state: "ready" };
  }

  async saveCopy(
    owner: OwnerId,
    linkId: string,
    draft: CopyDraft,
    limits: CopyLimits,
    at: Date,
  ): Promise<SaveCopyResult | null> {
    const id = parseId(linkId);
    if (id === null) return null;
    const images = draft.imageUrls.length;
    if (images > MAX_COPY_IMAGES) throw new Error("Too many images for a saved copy");
    if (images > 0 && !COPY_NONCE.test(draft.nonce)) throw new Error("Invalid copy nonce");
    const outcome = this.db
      .transaction((): SaveCopyResult | null | "write" =>
        this.reserve(owner, id, draft, limits, at),
      )
      .immediate();
    if (outcome !== "write") return outcome;
    try {
      this.folder.writeCopy(linkId, draft.markdown);
      this.confirmCopy(owner, id, at);
    } catch (e) {
      try {
        this.releaseCopy(owner, id);
      } catch {
        // the row stays `saving` until the startup undo
      }
      try {
        this.folder.removeCopy(linkId);
      } catch {
        // an orphan folder is the sweep's
      }
      throw e;
    }
    return "saved";
  }

  /** Drops a `saving` row; its image rows go with it. */
  private releaseCopy(owner: OwnerId, id: number): void {
    this.db
      .transaction(() =>
        this.db
          .prepare(
            "DELETE FROM saved_copies WHERE owner_id = ? AND link_id = ? AND status = 'saving'",
          )
          .run(owner, id),
      )
      .immediate();
  }

  /** The row check and write of a save; "write" means the files may now be written. */
  private reserve(
    owner: OwnerId,
    id: number,
    draft: CopyDraft,
    limits: CopyLimits,
    at: Date,
  ): SaveCopyResult | null | "write" {
    if (!this.db.prepare("SELECT 1 FROM links WHERE id = ? AND owner_id = ?").get(id, owner)) {
      return null;
    }
    const row = this.db
      .prepare("SELECT status FROM saved_copies WHERE owner_id = ? AND link_id = ?")
      .get(owner, id) as { status: string } | undefined;
    if (row && row.status !== "no_room") return "exists";
    if (this.check.state !== "ready") return "unavailable";
    const md = Buffer.byteLength(draft.markdown);
    if (md > limits.copyBytes) return this.settle(owner, id, "too_large");
    const used = this.db
      .prepare("SELECT coalesce(sum(bytes), 0) FROM saved_copies")
      .pluck()
      .get() as number;
    if (used + md > limits.totalBytes) return this.settle(owner, id, "no_room");
    this.db
      .prepare(
        `INSERT INTO saved_copies (owner_id, link_id, status, made_at, finished_at, image_nonce,
           md_bytes, bytes, removed_at)
         VALUES (?, ?, 'saving', ?, NULL, ?, ?, ?, NULL)
         ON CONFLICT (owner_id, link_id) DO UPDATE SET status = 'saving', made_at = excluded.made_at,
           finished_at = NULL, image_nonce = excluded.image_nonce, md_bytes = excluded.md_bytes,
           bytes = excluded.bytes, removed_at = NULL`,
      )
      .run(owner, id, toMs(at), draft.imageUrls.length > 0 ? draft.nonce : null, md, md);
    const image = this.db.prepare(
      "INSERT INTO saved_copy_images (owner_id, link_id, n, url, status) VALUES (?, ?, ?, ?, 'pending')",
    );
    for (const [i, url] of draft.imageUrls.entries()) image.run(owner, id, i + 1, url);
    return "write";
  }

  /** Upserts a row that holds no copy, and returns the answer for it. */
  private settle(owner: OwnerId, id: number, status: NoCopyStatus): "no_room" | "too_large" {
    this.db
      .prepare(
        `INSERT INTO saved_copies (owner_id, link_id, status) VALUES (?, ?, ?)
         ON CONFLICT (owner_id, link_id) DO UPDATE SET status = excluded.status, made_at = NULL,
           finished_at = NULL, image_nonce = NULL, md_bytes = 0, bytes = 0, removed_at = NULL`,
      )
      .run(owner, id, status);
    return status as "no_room" | "too_large";
  }

  /** Moves a `saving` row to `ok`; a copy with no images is finished at once. */
  private confirmCopy(owner: OwnerId, id: number, at: Date): void {
    const changed = this.db
      .transaction(
        () =>
          this.db
            .prepare(
              `UPDATE saved_copies SET status = 'ok',
                 finished_at = CASE WHEN image_nonce IS NULL THEN ? END
               WHERE owner_id = ? AND link_id = ? AND status = 'saving'`,
            )
            .run(toMs(at), owner, id).changes,
      )
      .immediate();
    if (changed !== 1) throw new Error("The saved copy was not waiting to be confirmed");
  }

  async recordNoCopy(owner: OwnerId, linkId: string, status: NoCopyStatus): Promise<boolean> {
    const id = parseId(linkId);
    if (id === null) return false;
    return this.db
      .transaction((): boolean => {
        if (!this.db.prepare("SELECT 1 FROM links WHERE id = ? AND owner_id = ?").get(id, owner)) {
          return false;
        }
        const row = this.db
          .prepare("SELECT status FROM saved_copies WHERE owner_id = ? AND link_id = ?")
          .get(owner, id) as { status: string } | undefined;
        if (row && row.status !== "no_room") return false;
        this.settle(owner, id, status);
        return true;
      })
      .immediate();
  }

  async copyInfo(owner: OwnerId, linkIds: string[]): Promise<Map<string, CopyInfo>> {
    const ids = linkIds.map(parseId).filter((n): n is number => n !== null);
    const rows = this.db
      .prepare(
        `SELECT link_id, made_at FROM saved_copies c, json_each(?) j
         WHERE c.owner_id = ? AND c.status = 'ok' AND c.link_id = j.value`,
      )
      .all(JSON.stringify(ids), owner) as { link_id: number; made_at: number }[];
    return new Map(rows.map((r) => [String(r.link_id), { madeAt: new Date(r.made_at) }]));
  }

  async readCopy(owner: OwnerId, linkId: string): Promise<ReadCopy | "missing" | null> {
    const id = parseId(linkId);
    if (id === null) return null;
    const row = this.db
      .prepare(
        `SELECT made_at, finished_at, image_nonce FROM saved_copies
         WHERE owner_id = ? AND link_id = ? AND status = 'ok'`,
      )
      .get(owner, id) as
      | { made_at: number; finished_at: number | null; image_nonce: string | null }
      | undefined;
    if (!row) return null;
    if (!this.readable) return "missing";
    const markdown = await this.folder.readMarkdown(linkId);
    if (markdown === null) return "missing";
    const images = this.db
      .prepare(
        `SELECT n, content_type, sha256 FROM saved_copy_images
         WHERE owner_id = ? AND link_id = ? AND status = 'ok' ORDER BY n`,
      )
      .all(owner, id) as { n: number; content_type: ImageType; sha256: string }[];
    return {
      markdown,
      madeAt: new Date(row.made_at),
      finished: row.finished_at !== null,
      nonce: row.image_nonce,
      images: new Map(
        images.map((i) => [i.n, { contentType: i.content_type, version: imageVersion(i.sha256) }]),
      ),
    };
  }

  async copyImage(owner: OwnerId, linkId: string, n: number): Promise<StoredImage | null> {
    const id = parseId(linkId);
    if (id === null || !Number.isInteger(n)) return null;
    const row = this.db
      .prepare(
        `SELECT i.content_type, i.sha256 FROM saved_copy_images i
         JOIN saved_copies c ON c.owner_id = i.owner_id AND c.link_id = i.link_id
         WHERE i.owner_id = ? AND i.link_id = ? AND i.n = ? AND i.status = 'ok' AND c.status = 'ok'`,
      )
      .get(owner, id, n) as { content_type: ImageType; sha256: string } | undefined;
    if (!row || !this.readable) return null;
    const name = `${String(n).padStart(2, "0")}.${IMAGE_EXT[row.content_type]}`;
    const bytes = await this.folder.readImage(linkId, name);
    return bytes
      ? { contentType: row.content_type, bytes, version: imageVersion(row.sha256) }
      : null;
  }

  async usedBytes(): Promise<number> {
    return this.db
      .prepare("SELECT coalesce(sum(bytes), 0) FROM saved_copies")
      .pluck()
      .get() as number;
  }

  async backfillCandidates(
    afterId: string | null,
    limit: number,
    options: { retryNoRoom: boolean },
  ): Promise<CopyCandidate[]> {
    const after = afterId === null ? 0 : parseId(afterId);
    if (after === null) return [];
    const rows = this.db
      .prepare(
        `SELECT l.owner_id, l.id, l.url FROM snapshots s
         JOIN links l ON l.owner_id = s.owner_id AND l.id = s.link_id
         LEFT JOIN saved_copies c ON c.owner_id = l.owner_id AND c.link_id = l.id
         WHERE s.fetch_status = 'ok' AND s.text IS NOT NULL
           AND (c.link_id IS NULL OR (? = 1 AND c.status = 'no_room'))
           AND NOT EXISTS (SELECT 1 FROM link_checks k WHERE k.owner_id = l.owner_id
             AND k.link_id = l.id AND k.flagged_at IS NOT NULL)
           AND l.id > ? ORDER BY l.id LIMIT ?`,
      )
      .all(options.retryNoRoom ? 1 : 0, after, limit) as {
      owner_id: string;
      id: number;
      url: string;
    }[];
    return rows.map((r) => ({ owner: r.owner_id, linkId: String(r.id), url: r.url }));
  }
}
