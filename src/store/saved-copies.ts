import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ImageType } from "../core/fetch.js";
import { type ImageBytes, imageVersion, type StoredImage } from "../core/image-store.js";
import {
  COPY_NONCE,
  type CopyCandidate,
  type CopyDraft,
  type CopyImageEnd,
  type CopyImageResult,
  type CopyInfo,
  type CopyLimits,
  type CopyRef,
  type FinishImage,
  type FolderCheck,
  IMAGE_EXT,
  MAX_COPY_IMAGES,
  type NoCopyStatus,
  type PendingCopyImage,
  type ReadCopy,
  type SaveCopyResult,
  type SavedCopyMaintenance,
  type SavedCopyReader,
  type SavedCopyUsage,
  type SavedCopyWriter,
  type SweepReport,
} from "../core/saved-copy.js";
import type { OwnerId } from "../core/types.js";
import { CopyFolder, TMP } from "./copy-folder.js";
import { parseId, toMs } from "./sqlite-store.js";

const failure = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message;

const imageName = (n: number, type: ImageType) =>
  `${String(n).padStart(2, "0")}.${IMAGE_EXT[type]}`;

/** Saved copies (#135): the `saved_copies*` rows and the folder holding their files. */
export class SqliteSavedCopyStore
  implements
    SavedCopyReader,
    SavedCopyUsage,
    SavedCopyWriter,
    Omit<SavedCopyMaintenance, "purgeRemoved">
{
  private readonly folder: CopyFolder;
  private check: FolderCheck = {
    state: "mismatch",
    detail: "The saved-copy folder is not checked",
  };
  private prepared = false;

  constructor(
    private readonly db: Database,
    private readonly root: string | null,
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
    if (this.usedNow() + md > limits.totalBytes) return this.settle(owner, id, "no_room");
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

  async saveCopyImage(
    owner: OwnerId,
    linkId: string,
    n: number,
    url: string,
    image: ImageBytes,
    limits: CopyLimits,
  ): Promise<CopyImageResult | false> {
    const id = parseId(linkId);
    if (id === null || !Number.isInteger(n)) return false;
    const size = image.bytes.byteLength;
    const name = imageName(n, image.contentType);
    const outcome = this.db
      .transaction((): CopyImageResult | false | "write" => {
        const row = this.db
          .prepare(
            `SELECT c.bytes FROM saved_copy_images i
             JOIN saved_copies c ON c.owner_id = i.owner_id AND c.link_id = i.link_id
             WHERE i.owner_id = ? AND i.link_id = ? AND i.n = ? AND i.url = ?
               AND i.status = 'pending' AND c.status = 'ok'`,
          )
          .get(owner, id, n, url) as { bytes: number } | undefined;
        if (!row) return false;
        if (this.check.state !== "ready") return "unavailable";
        if (row.bytes + size > limits.copyBytes) return this.refuseImage(owner, id, n, "too_large");
        if (this.usedNow() + size > limits.totalBytes) {
          return this.refuseImage(owner, id, n, "no_room");
        }
        this.db
          .prepare(
            `UPDATE saved_copy_images SET status = 'saving', content_type = ?, size = ?, sha256 = ?
             WHERE owner_id = ? AND link_id = ? AND n = ?`,
          )
          .run(
            image.contentType,
            size,
            createHash("sha256").update(image.bytes).digest("hex"),
            owner,
            id,
            n,
          );
        this.db
          .prepare("UPDATE saved_copies SET bytes = bytes + ? WHERE owner_id = ? AND link_id = ?")
          .run(size, owner, id);
        return "write";
      })
      .immediate();
    if (outcome !== "write") return outcome;
    try {
      this.folder.writeImage(linkId, name, image.bytes);
      this.confirmImage(owner, id, n);
    } catch (e) {
      try {
        this.releaseImage(owner, id, n, size);
      } catch {
        // the row stays `saving` until the startup undo
      }
      try {
        this.folder.removeImage(linkId, name);
      } catch {
        // an orphan image is the sweep's
      }
      throw e;
    }
    return "saved";
  }

  /** Undoes what a crash left `saving`; files go only when the folder check is `ready` (R7). */
  async undoUnconfirmed(): Promise<{ copies: number; images: number }> {
    const files = this.owned();
    const attempt = (remove: () => void) => {
      if (!files) return;
      try {
        remove();
      } catch {
        // a file that stays is the sweep's
      }
    };
    const copies = this.db
      .prepare("SELECT owner_id, link_id FROM saved_copies WHERE status = 'saving'")
      .all() as { owner_id: string; link_id: number }[];
    for (const c of copies) {
      this.releaseCopy(c.owner_id, c.link_id);
      attempt(() => this.folder.removeCopy(String(c.link_id)));
    }
    const images = this.db
      .prepare(
        "SELECT owner_id, link_id, n, size, content_type FROM saved_copy_images WHERE status = 'saving'",
      )
      .all() as {
      owner_id: string;
      link_id: number;
      n: number;
      size: number;
      content_type: ImageType;
    }[];
    for (const i of images) {
      this.releaseImage(i.owner_id, i.link_id, i.n, i.size);
      attempt(() => this.folder.removeImage(String(i.link_id), imageName(i.n, i.content_type)));
    }
    return { copies: copies.length, images: images.length };
  }

  /**
   * Deletes what the store left behind that is older than `graceMs` and has no row, and reports
   * what it will not touch. Nothing is awaited, so a row check and its deletion never straddle
   * another save (R12).
   */
  async sweep(graceMs: number, now: Date): Promise<SweepReport> {
    const report: SweepReport = { folders: 0, temp: 0, images: 0, unknown: [] };
    let listing: ReturnType<CopyFolder["list"]>;
    try {
      if (!this.owned()) return report;
      listing = this.folder.list();
    } catch {
      return report;
    }
    const idle = (mtimeMs: number) => now.getTime() - mtimeMs > graceMs;
    const hasCopy = new Set(
      this.db
        .prepare(
          "SELECT DISTINCT link_id FROM saved_copies WHERE status IN ('saving', 'ok', 'removed')",
        )
        .pluck()
        .all() as number[],
    );
    const keep = new Map<number, Set<string>>();
    const kept = this.db
      .prepare(
        "SELECT link_id, n, content_type FROM saved_copy_images WHERE status IN ('saving', 'ok')",
      )
      .all() as { link_id: number; n: number; content_type: ImageType }[];
    for (const i of kept) {
      const names = keep.get(i.link_id) ?? new Set<string>();
      names.add(imageName(i.n, i.content_type));
      keep.set(i.link_id, names);
    }
    for (const { name, mtimeMs } of listing.links) {
      // A name that is not a link id's canonical form (`007`) is never ours to delete.
      if (name !== String(Number(name))) {
        report.unknown.push(name);
        continue;
      }
      try {
        if (hasCopy.has(Number(name))) {
          this.sweepFolder(name, keep.get(Number(name)) ?? new Set(), report);
        } else if (idle(mtimeMs)) {
          const left = this.folder.removeCopy(name);
          report.folders++;
          report.unknown.push(...left.map((n) => `${name}/${n}`));
        }
      } catch {
        report.unknown.push(name);
      }
    }
    for (const { name, mtimeMs } of listing.temp) {
      if (!idle(mtimeMs)) continue;
      try {
        const left = this.folder.removeTemp(name);
        report.temp++;
        report.unknown.push(...left.map((n) => `${TMP}/${n}`));
      } catch {
        report.unknown.push(`${TMP}/${name}`);
      }
    }
    report.unknown.push(...listing.other);
    return report;
  }

  /** The last check was `ready` and the marker still holds this database's library id (R7). */
  private owned(): boolean {
    if (this.check.state !== "ready") return false;
    try {
      const library = this.db.prepare("SELECT id FROM saved_copy_library WHERE only = 1").get() as
        | { id: string }
        | undefined;
      return library !== undefined && this.folder.readMarker() === library.id;
    } catch {
      return false;
    }
  }

  /** A folder with a row: images the ledger does not hold are deleted, other names reported. */
  private sweepFolder(name: string, wanted: Set<string>, report: SweepReport): void {
    for (const file of this.folder.listImages(name)) {
      if (wanted.has(file)) continue;
      this.folder.removeImage(name, file);
      report.images++;
    }
    report.unknown.push(...this.folder.unknownIn(name).map((n) => `${name}/${n}`));
  }

  private usedNow(): number {
    return this.db
      .prepare("SELECT coalesce(sum(bytes), 0) FROM saved_copies")
      .pluck()
      .get() as number;
  }

  /** Settles a pending image as one that will not be stored, and returns the answer for it. */
  private refuseImage(
    owner: OwnerId,
    id: number,
    n: number,
    status: "too_large" | "no_room",
  ): "too_large" | "no_room" {
    this.db
      .prepare(
        "UPDATE saved_copy_images SET status = ? WHERE owner_id = ? AND link_id = ? AND n = ?",
      )
      .run(status, owner, id, n);
    return status;
  }

  /** Moves a `saving` image to `ok`. */
  private confirmImage(owner: OwnerId, id: number, n: number): void {
    const changed = this.db
      .transaction(
        () =>
          this.db
            .prepare(
              `UPDATE saved_copy_images SET status = 'ok'
               WHERE owner_id = ? AND link_id = ? AND n = ? AND status = 'saving'`,
            )
            .run(owner, id, n).changes,
      )
      .immediate();
    if (changed !== 1) throw new Error("The saved image was not waiting to be confirmed");
  }

  /** Puts a `saving` image back to `pending` and gives its bytes back. */
  private releaseImage(owner: OwnerId, id: number, n: number, size: number): void {
    this.db
      .transaction(() => {
        const changed = this.db
          .prepare(
            `UPDATE saved_copy_images SET status = 'pending', content_type = NULL, size = NULL,
               sha256 = NULL WHERE owner_id = ? AND link_id = ? AND n = ? AND status = 'saving'`,
          )
          .run(owner, id, n).changes;
        if (changed === 1) {
          this.db
            .prepare("UPDATE saved_copies SET bytes = bytes - ? WHERE owner_id = ? AND link_id = ?")
            .run(size, owner, id);
        }
      })
      .immediate();
  }

  async endCopyImage(
    owner: OwnerId,
    linkId: string,
    n: number,
    url: string,
    end: CopyImageEnd,
  ): Promise<boolean> {
    const id = parseId(linkId);
    if (id === null || !Number.isInteger(n)) return false;
    return (
      this.db
        .transaction(
          () =>
            this.db
              .prepare(
                `UPDATE saved_copy_images SET status = ?
                 WHERE owner_id = ? AND link_id = ? AND n = ? AND url = ? AND status = 'pending'`,
              )
              .run(end, owner, id, n, url).changes,
        )
        .immediate() === 1
    );
  }

  async pendingCopyImages(
    after: { linkId: string; n: number } | null,
    limit: number,
  ): Promise<PendingCopyImage[]> {
    const from = after === null ? 0 : parseId(after.linkId);
    if (from === null) return [];
    const rows = this.db
      .prepare(
        `SELECT i.owner_id, i.link_id, i.n, i.url FROM saved_copy_images i
         JOIN saved_copies c ON c.owner_id = i.owner_id AND c.link_id = i.link_id
         WHERE i.status = 'pending' AND c.status = 'ok' AND (i.link_id, i.n) > (?, ?)
         ORDER BY i.link_id, i.n LIMIT ?`,
      )
      .all(from, after?.n ?? 0, limit) as {
      owner_id: string;
      link_id: number;
      n: number;
      url: string;
    }[];
    return rows.map((r) => ({
      owner: r.owner_id,
      linkId: String(r.link_id),
      n: r.n,
      url: r.url,
    }));
  }

  async unfinishedCopies(afterId: string | null, limit: number): Promise<CopyRef[]> {
    const after = afterId === null ? 0 : parseId(afterId);
    if (after === null) return [];
    const rows = this.db
      .prepare(
        `SELECT c.owner_id, c.link_id FROM saved_copies c
         WHERE c.status = 'ok' AND c.finished_at IS NULL AND c.link_id > ?
           AND NOT EXISTS (SELECT 1 FROM saved_copy_images i WHERE i.owner_id = c.owner_id
             AND i.link_id = c.link_id AND i.status IN ('pending', 'saving'))
         ORDER BY c.link_id, c.owner_id LIMIT ?`,
      )
      .all(after, limit) as { owner_id: string; link_id: number }[];
    return rows.map((r) => ({ owner: r.owner_id, linkId: String(r.link_id) }));
  }

  async finishCopy(
    owner: OwnerId,
    linkId: string,
    finish: (markdown: string, nonce: string, images: FinishImage[]) => string,
    at: Date,
  ): Promise<boolean> {
    const id = parseId(linkId);
    if (id === null || this.check.state !== "ready") return false;
    const row = this.finishable(owner, id);
    if (!row) return false;
    const markdown = await this.folder.readMarkdown(linkId);
    if (markdown === null) return false;
    const images = (
      this.db
        .prepare(
          `SELECT n, status, content_type FROM saved_copy_images
           WHERE owner_id = ? AND link_id = ? ORDER BY n`,
        )
        .all(owner, id) as { n: number; status: string; content_type: ImageType | null }[]
    ).map((i) => ({
      n: i.n,
      ext: i.status === "ok" && i.content_type ? IMAGE_EXT[i.content_type] : null,
    }));
    const finished = finish(markdown, row.image_nonce, images);
    const length = Buffer.byteLength(finished);
    if (length > row.md_bytes) throw new Error("The finished copy is longer than reserved");
    // No await from here: the recheck and the file replacement see the same rows.
    if (this.check.state !== "ready" || !this.finishable(owner, id)) return false;
    this.folder.replaceMarkdown(linkId, finished);
    return (
      this.db
        .transaction(
          () =>
            this.db
              .prepare(
                `UPDATE saved_copies SET md_bytes = ?, finished_at = ?,
                   bytes = ? + (SELECT coalesce(sum(size), 0) FROM saved_copy_images i
                     WHERE i.owner_id = saved_copies.owner_id
                       AND i.link_id = saved_copies.link_id AND i.status = 'ok')
                 WHERE owner_id = ? AND link_id = ? AND status = 'ok' AND finished_at IS NULL`,
              )
              .run(length, toMs(at), length, owner, id).changes,
        )
        .immediate() === 1
    );
  }

  /** An `ok` copy with an image nonce that is not finished and has no image in flight. */
  private finishable(
    owner: OwnerId,
    id: number,
  ): { image_nonce: string; md_bytes: number } | undefined {
    return this.db
      .prepare(
        `SELECT image_nonce, md_bytes FROM saved_copies c
         WHERE owner_id = ? AND link_id = ? AND status = 'ok' AND finished_at IS NULL
           AND image_nonce IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM saved_copy_images i WHERE i.owner_id = c.owner_id
             AND i.link_id = c.link_id AND i.status IN ('pending', 'saving'))`,
      )
      .get(owner, id) as { image_nonce: string; md_bytes: number } | undefined;
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
    const bytes = await this.folder.readImage(linkId, imageName(n, row.content_type));
    return bytes
      ? { contentType: row.content_type, bytes, version: imageVersion(row.sha256) }
      : null;
  }

  async usedBytes(): Promise<number> {
    return this.usedNow();
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
