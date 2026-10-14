import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ImageType } from "../core/fetch.js";
import {
  type ImageBytes,
  type ImageEnd,
  type ImageStore,
  imageVersion,
  type LinkImageReader,
  type PendingImage,
  type StoredImage,
} from "../core/image-store.js";
import type { OwnerId } from "../core/types.js";
import { parseId } from "./sqlite-store.js";

/** Preview images in `link_images`, and their pending state in `snapshots.image_status`. */
export class SqliteImageStore implements ImageStore, LinkImageReader {
  constructor(private readonly db: Database) {}

  async pendingImages(afterId: string | null, limit: number): Promise<PendingImage[]> {
    const after = afterId === null ? 0 : (parseId(afterId) ?? 0);
    const rows = this.db
      .prepare(
        `SELECT owner_id, link_id, image_url FROM snapshots
         WHERE image_status = 'pending' AND link_id > ? ORDER BY link_id LIMIT ?`,
      )
      .all(after, limit) as { owner_id: string; link_id: number; image_url: string }[];
    return rows.map((r) => ({
      owner: r.owner_id,
      linkId: String(r.link_id),
      imageUrl: r.image_url,
    }));
  }

  async writeImage(
    owner: OwnerId,
    linkId: string,
    imageUrl: string,
    image: ImageBytes,
    at: Date,
  ): Promise<boolean> {
    const n = parseId(linkId);
    if (n === null) return false;
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    return this.db
      .transaction(() => {
        if (!this.settle(owner, n, imageUrl, "ok")) return false;
        this.db
          .prepare(
            `INSERT INTO link_images (owner_id, link_id, content_type, bytes, sha256, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, link_id) DO UPDATE SET content_type = excluded.content_type,
               bytes = excluded.bytes, sha256 = excluded.sha256, fetched_at = excluded.fetched_at`,
          )
          .run(owner, n, image.contentType, Buffer.from(image.bytes), sha256, at.getTime());
        return true;
      })
      .immediate();
  }

  async endImage(owner: OwnerId, linkId: string, imageUrl: string, end: ImageEnd) {
    const n = parseId(linkId);
    return n !== null && this.settle(owner, n, imageUrl, end);
  }

  async imageVersions(owner: OwnerId, linkIds: string[]): Promise<Map<string, string>> {
    const ids = linkIds.map(parseId).filter((n): n is number => n !== null);
    const rows = this.db
      .prepare(
        `SELECT link_id, sha256 FROM link_images
         WHERE owner_id = ? AND link_id IN (SELECT value FROM json_each(?))`,
      )
      .all(owner, JSON.stringify(ids)) as { link_id: number; sha256: string }[];
    return new Map(rows.map((r) => [String(r.link_id), imageVersion(r.sha256)]));
  }

  async image(owner: OwnerId, linkId: string): Promise<StoredImage | null> {
    const n = parseId(linkId);
    if (n === null) return null;
    const row = this.db
      .prepare(
        "SELECT content_type, bytes, sha256 FROM link_images WHERE owner_id = ? AND link_id = ?",
      )
      .get(owner, n) as { content_type: ImageType; bytes: Buffer; sha256: string } | undefined;
    if (!row) return null;
    return {
      contentType: row.content_type,
      bytes: new Uint8Array(row.bytes),
      version: imageVersion(row.sha256),
    };
  }

  /** Moves a still-pending image for `imageUrl` to `status`; false when it was not pending. */
  private settle(owner: OwnerId, linkId: number, imageUrl: string, status: string): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE snapshots SET image_status = ?
         WHERE link_id = ? AND owner_id = ? AND image_status = 'pending' AND image_url = ?`,
      )
      .run(status, linkId, owner, imageUrl);
    return changes === 1;
  }
}
