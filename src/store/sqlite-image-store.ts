import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ImageType } from "../core/fetch.js";
import type { IconBackfillStore, IconCandidate } from "../core/icon-backfill-store.js";
import {
  type ImageBytes,
  type ImageEnd,
  type ImageRole,
  type ImageStore,
  imageVersion,
  type LinkImageReader,
  type PendingImage,
  type PictureFit,
  type PictureInfo,
  type ShownPicture,
  type StoredImage,
} from "../core/image-store.js";
import { MAX_ICON_URLS } from "../core/snapshot-store.js";
import type { OwnerId } from "../core/types.js";
import { parseId } from "./sqlite-store.js";

/** Fetched pictures, a page's preview or a site's icon (`link_images`, pending in `snapshots.image_status`), the one-time icon check of links snapshotted before icons were looked for, and the reads of whichever picture shows: the owner's (`owner_images`), else the fetched one. */
export class SqliteImageStore implements ImageStore, LinkImageReader, IconBackfillStore {
  constructor(private readonly db: Database) {}

  async pendingImages(afterId: string | null, limit: number): Promise<PendingImage[]> {
    const after = afterId === null ? 0 : (parseId(afterId) ?? 0);
    const rows = this.db
      .prepare(
        `SELECT owner_id, link_id, coalesce(image_url, icon_url) AS url, image_url IS NULL AS icon
         FROM snapshots WHERE image_status = 'pending' AND link_id > ? ORDER BY link_id LIMIT ?`,
      )
      .all(after, limit) as { owner_id: string; link_id: number; url: string; icon: number }[];
    return rows.map((r) => ({
      owner: r.owner_id,
      linkId: String(r.link_id),
      imageUrl: r.url,
      role: r.icon === 1 ? "icon" : "preview",
    }));
  }

  async writeImage(
    owner: OwnerId,
    linkId: string,
    imageUrl: string,
    role: ImageRole,
    image: ImageBytes,
    at: Date,
  ): Promise<boolean> {
    const n = parseId(linkId);
    if (n === null) return false;
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    return this.db
      .transaction(() => {
        if (!this.settle(owner, n, imageUrl, role, "ok")) return false;
        this.db
          .prepare(
            `INSERT INTO link_images (owner_id, link_id, content_type, bytes, sha256, fetched_at, role)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, link_id) DO UPDATE SET content_type = excluded.content_type,
               bytes = excluded.bytes, sha256 = excluded.sha256, fetched_at = excluded.fetched_at,
               role = excluded.role`,
          )
          .run(owner, n, image.contentType, Buffer.from(image.bytes), sha256, at.getTime(), role);
        return true;
      })
      .immediate();
  }

  async endImage(owner: OwnerId, linkId: string, imageUrl: string, role: ImageRole, end: ImageEnd) {
    const n = parseId(linkId);
    if (n === null) return false;
    if (role === "preview") return this.settle(owner, n, imageUrl, role, end);
    const { changes } = this.db
      .prepare(
        `UPDATE snapshots SET icon_url = coalesce(icon_next_url, icon_url), icon_next_url = NULL,
           image_status = CASE WHEN icon_next_url IS NULL THEN ? ELSE 'pending' END
         WHERE link_id = ? AND owner_id = ? AND image_status = 'pending'
           AND image_url IS NULL AND icon_url = ?`,
      )
      .run(end, n, owner, imageUrl);
    return changes === 1;
  }

  /** Link ids as the JSON array `json_each` reads; ids never issued are dropped. */
  private static ids(linkIds: string[]): string {
    return JSON.stringify(linkIds.map(parseId).filter((n): n is number => n !== null));
  }

  async imageVersions(owner: OwnerId, linkIds: string[]): Promise<Map<string, ShownPicture>> {
    const rows = this.db
      .prepare(
        `SELECT j.value AS link_id, coalesce(o.sha256, f.sha256) AS sha256,
           CASE WHEN o.sha256 IS NULL AND f.role = 'icon' THEN 'contain' ELSE 'cover' END AS fit
         FROM json_each(?) j
         JOIN links l ON l.owner_id = ? AND l.id = j.value AND l.deleted_at IS NULL
         LEFT JOIN owner_images o ON o.owner_id = ? AND o.link_id = j.value
         LEFT JOIN link_images f ON f.owner_id = ? AND f.link_id = j.value
         WHERE coalesce(o.sha256, f.sha256) IS NOT NULL`,
      )
      .all(SqliteImageStore.ids(linkIds), owner, owner, owner) as {
      link_id: number;
      sha256: string;
      fit: PictureFit;
    }[];
    return new Map(
      rows.map((r) => [String(r.link_id), { version: imageVersion(r.sha256), fit: r.fit }]),
    );
  }

  async image(
    owner: OwnerId,
    linkId: string,
    which?: "page" | "own",
  ): Promise<(StoredImage & { role?: ImageRole }) | null> {
    const n = parseId(linkId);
    if (n === null) return null;
    const live = this.db
      .prepare("SELECT 1 FROM links WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
      .get(n, owner);
    if (!live) return null;
    const read = (table: "owner_images" | "link_images") =>
      this.db
        .prepare(
          `SELECT content_type, bytes, sha256${table === "link_images" ? ", role" : ""}
           FROM ${table} WHERE owner_id = ? AND link_id = ?`,
        )
        .get(owner, n) as
        | { content_type: ImageType; bytes: Buffer; sha256: string; role?: ImageRole }
        | undefined;
    const row =
      which === "own"
        ? read("owner_images")
        : ((which === "page" ? undefined : read("owner_images")) ?? read("link_images"));
    if (!row) return null;
    return {
      contentType: row.content_type,
      bytes: new Uint8Array(row.bytes),
      version: imageVersion(row.sha256),
      ...(which === "page" && row.role ? { role: row.role } : {}),
    };
  }

  async pictureInfo(owner: OwnerId, linkIds: string[]): Promise<Map<string, PictureInfo>> {
    const rows = this.db
      .prepare(
        `SELECT j.value AS link_id, o.link_id IS NOT NULL AS own, f.sha256 AS page,
           CASE WHEN f.link_id IS NULL THEN NULL WHEN f.role = 'icon' THEN 'contain' ELSE 'cover' END AS page_fit
         FROM json_each(?) j
         JOIN links l ON l.owner_id = ? AND l.id = j.value AND l.deleted_at IS NULL
         LEFT JOIN owner_images o ON o.owner_id = ? AND o.link_id = j.value
         LEFT JOIN link_images f ON f.owner_id = ? AND f.link_id = j.value
         WHERE o.link_id IS NOT NULL OR f.link_id IS NOT NULL`,
      )
      .all(SqliteImageStore.ids(linkIds), owner, owner, owner) as {
      link_id: number;
      own: number;
      page: string | null;
      page_fit: PictureFit | null;
    }[];
    return new Map(
      rows.map((r) => [
        String(r.link_id),
        {
          own: r.own === 1,
          pageVersion: r.page === null ? null : imageVersion(r.page),
          pageFit: r.page_fit,
        },
      ]),
    );
  }

  async iconCandidates(afterId: string | null, limit: number): Promise<IconCandidate[]> {
    const after = afterId === null ? 0 : parseId(afterId);
    if (after === null) return [];
    const rows = this.db
      .prepare(
        `SELECT l.owner_id, l.id, l.url FROM snapshots s
         JOIN links l ON l.owner_id = s.owner_id AND l.id = s.link_id
         WHERE l.deleted_at IS NULL AND s.fetch_status = 'ok' AND s.image_url IS NULL
           AND s.image_status IS NULL
           AND NOT EXISTS (SELECT 1 FROM link_images f
             WHERE f.owner_id = l.owner_id AND f.link_id = l.id)
           AND NOT EXISTS (SELECT 1 FROM link_checks k WHERE k.owner_id = l.owner_id
             AND k.link_id = l.id AND k.flagged_at IS NOT NULL)
           AND l.id > ? ORDER BY l.id LIMIT ?`,
      )
      .all(after, limit) as { owner_id: string; id: number; url: string }[];
    return rows.map((r) => ({ owner: r.owner_id, linkId: String(r.id), url: r.url }));
  }

  async recordIconCheck(owner: OwnerId, linkId: string, iconUrls: string[]): Promise<boolean> {
    const n = parseId(linkId);
    if (n === null || iconUrls.length > MAX_ICON_URLS) return false;
    const first = iconUrls[0] ?? null;
    const { changes } = this.db
      .prepare(
        `UPDATE snapshots SET icon_url = ?, icon_next_url = ?,
           image_status = CASE WHEN ? IS NULL THEN 'none' ELSE 'pending' END
         WHERE owner_id = ? AND link_id = ? AND fetch_status = 'ok'
           AND image_url IS NULL AND image_status IS NULL
           AND NOT EXISTS (SELECT 1 FROM link_images f
             WHERE f.owner_id = snapshots.owner_id AND f.link_id = snapshots.link_id)
           AND NOT EXISTS (SELECT 1 FROM link_checks k WHERE k.owner_id = snapshots.owner_id
             AND k.link_id = snapshots.link_id AND k.flagged_at IS NOT NULL)`,
      )
      .run(first, iconUrls[1] ?? null, first, owner, n);
    return changes === 1;
  }

  /** Moves a still-pending picture for this URL and role to `status`; false when it was not pending. */
  private settle(
    owner: OwnerId,
    linkId: number,
    imageUrl: string,
    role: ImageRole,
    status: string,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE snapshots SET image_status = ?
         WHERE link_id = ? AND owner_id = ? AND image_status = 'pending'
           AND coalesce(image_url, icon_url) = ? AND (image_url IS NULL) = ?`,
      )
      .run(status, linkId, owner, imageUrl, role === "icon" ? 1 : 0);
    return changes === 1;
  }
}
