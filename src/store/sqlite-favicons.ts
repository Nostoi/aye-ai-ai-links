import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import {
  FAVICON_DISCOVERY_VERSION,
  type FaviconReader,
  type FaviconStore,
  type PendingFavicon,
} from "../core/favicon-store.js";
import type { ImageType } from "../core/fetch.js";
import {
  type ImageBytes,
  type ImageEnd,
  imageVersion,
  type StoredImage,
} from "../core/image-store.js";
import type { OwnerId } from "../core/types.js";
import { parseId } from "./sql-values.js";

/**
 * A page was read: its favicon candidates replace the link's, under the next generation, with no
 * stored favicon, pending (or `none` for an empty list). Call it inside the writer's transaction,
 * after the writer's own compare-and-set succeeded, so both land or neither does.
 */
export function rewriteFavicon(db: Database, owner: OwnerId, linkId: number, urls: string[]) {
  db.prepare(
    `INSERT INTO link_favicons (owner_id, link_id, candidates, status, generation, discovery)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT (owner_id, link_id) DO UPDATE SET candidates = excluded.candidates,
       status = excluded.status, generation = link_favicons.generation + 1,
       discovery = excluded.discovery, content_type = NULL, bytes = NULL, sha256 = NULL,
       fetched_at = NULL`,
  ).run(
    owner,
    linkId,
    JSON.stringify(urls),
    urls.length > 0 ? "pending" : "none",
    FAVICON_DISCOVERY_VERSION,
  );
}

/** The row's link exists for this owner and is not deleted. */
const LIVE = `EXISTS (SELECT 1 FROM links l WHERE l.owner_id = link_favicons.owner_id
  AND l.id = link_favicons.link_id AND l.deleted_at IS NULL)`;

/** Site favicons (#272, `link_favicons`): the favicon pass's pending reads and writes, and the web door's reads. */
export class SqliteFaviconStore implements FaviconStore, FaviconReader {
  constructor(private readonly db: Database) {}

  async pendingFavicons(afterId: string | null, limit: number): Promise<PendingFavicon[]> {
    const after = afterId === null ? 0 : (parseId(afterId) ?? 0);
    const rows = this.db
      .prepare(
        `SELECT owner_id, link_id, generation, candidates FROM link_favicons
         WHERE status = 'pending' AND link_id > ? AND ${LIVE} ORDER BY link_id LIMIT ?`,
      )
      .all(after, limit) as {
      owner_id: string;
      link_id: number;
      generation: number;
      candidates: string;
    }[];
    return rows.map((r) => ({
      owner: r.owner_id,
      linkId: String(r.link_id),
      generation: r.generation,
      urls: JSON.parse(r.candidates) as string[],
    }));
  }

  async writeFavicon(
    owner: OwnerId,
    linkId: string,
    generation: number,
    image: ImageBytes,
    at: Date,
  ): Promise<boolean> {
    const n = parseId(linkId);
    if (n === null) return false;
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    const { changes } = this.db
      .prepare(
        `UPDATE link_favicons SET status = 'ok', content_type = ?, bytes = ?, sha256 = ?,
           fetched_at = ?
         WHERE owner_id = ? AND link_id = ? AND generation = ? AND status = 'pending' AND ${LIVE}`,
      )
      .run(image.contentType, Buffer.from(image.bytes), sha256, at.getTime(), owner, n, generation);
    return changes === 1;
  }

  async endFavicon(
    owner: OwnerId,
    linkId: string,
    generation: number,
    end: ImageEnd,
  ): Promise<boolean> {
    const n = parseId(linkId);
    if (n === null) return false;
    const { changes } = this.db
      .prepare(
        `UPDATE link_favicons SET status = ?
         WHERE owner_id = ? AND link_id = ? AND generation = ? AND status = 'pending' AND ${LIVE}`,
      )
      .run(end, owner, n, generation);
    return changes === 1;
  }

  async faviconVersions(owner: OwnerId, linkIds: string[]): Promise<Map<string, string>> {
    const ids = JSON.stringify(linkIds.map(parseId).filter((n): n is number => n !== null));
    const rows = this.db
      .prepare(
        `SELECT link_id, sha256 FROM link_favicons
         WHERE owner_id = ? AND link_id IN (SELECT value FROM json_each(?))
           AND status = 'ok' AND ${LIVE}`,
      )
      .all(owner, ids) as { link_id: number; sha256: string }[];
    return new Map(rows.map((r) => [String(r.link_id), imageVersion(r.sha256)]));
  }

  async favicon(owner: OwnerId, linkId: string): Promise<StoredImage | null> {
    const n = parseId(linkId);
    if (n === null) return null;
    const row = this.db
      .prepare(
        `SELECT content_type, bytes, sha256 FROM link_favicons
         WHERE owner_id = ? AND link_id = ? AND status = 'ok' AND ${LIVE}`,
      )
      .get(owner, n) as { content_type: ImageType; bytes: Buffer; sha256: string } | undefined;
    return row
      ? {
          contentType: row.content_type,
          bytes: new Uint8Array(row.bytes),
          version: imageVersion(row.sha256),
        }
      : null;
  }
}
