import { createHash } from "node:crypto";
import { FAVICON_DISCOVERY_VERSION, type PendingFavicon } from "./favicon-store.js";
import type { FaviconRow } from "./favicon-store-contract.js";
import { type ImageBytes, type ImageEnd, imageVersion, type StoredImage } from "./image-store.js";
import type { OwnerId } from "./types.js";

type Row = {
  candidates: string[];
  status: "pending" | "ok" | "none" | "refused";
  generation: number;
  discovery: number;
  image: StoredImage | null;
};

/** Whether the link exists for its owner and is not deleted. */
type Live = (owner: OwnerId, linkId: string) => boolean;

const keyOf = (owner: OwnerId, linkId: string) => JSON.stringify([owner, linkId]);
const order = (id: string) => Number(id.replace(/^link-/, ""));

/** FakeStore's `link_favicons` (#272): the same rules as `SqliteFaviconStore`, in memory. */
export class FakeFavicons {
  private rows = new Map<string, Row>();

  /** A page was read: its candidates replace the old ones, under the next generation. */
  rewrite(owner: OwnerId, linkId: string, urls: string[]): void {
    const key = keyOf(owner, linkId);
    this.rows.set(key, {
      candidates: [...urls],
      status: urls.length > 0 ? "pending" : "none",
      generation: (this.rows.get(key)?.generation ?? 0) + 1,
      discovery: FAVICON_DISCOVERY_VERSION,
      image: null,
    });
  }

  /** The link is gone for good, as the table's ON DELETE CASCADE does. */
  drop(owner: OwnerId, linkId: string): void {
    this.rows.delete(keyOf(owner, linkId));
  }

  pending(afterId: string | null, limit: number, live: Live): PendingFavicon[] {
    const found: PendingFavicon[] = [];
    for (const [key, row] of this.rows) {
      const [owner, linkId] = JSON.parse(key) as [OwnerId, string];
      if (row.status !== "pending" || !live(owner, linkId)) continue;
      if (afterId !== null && order(linkId) <= order(afterId)) continue;
      found.push({ owner, linkId, generation: row.generation, urls: [...row.candidates] });
    }
    return found.sort((a, b) => order(a.linkId) - order(b.linkId)).slice(0, limit);
  }

  write(owner: OwnerId, linkId: string, generation: number, image: ImageBytes, live: Live) {
    const row = this.claimed(owner, linkId, generation, live);
    if (!row) return false;
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    row.status = "ok";
    row.image = {
      contentType: image.contentType,
      bytes: new Uint8Array(image.bytes),
      version: imageVersion(sha256),
    };
    return true;
  }

  end(owner: OwnerId, linkId: string, generation: number, end: ImageEnd, live: Live) {
    const row = this.claimed(owner, linkId, generation, live);
    if (!row) return false;
    row.status = end;
    return true;
  }

  versions(owner: OwnerId, linkIds: string[], live: Live): Map<string, string> {
    const out = new Map<string, string>();
    for (const id of linkIds) {
      const image = this.read(owner, id, live);
      if (image) out.set(id, image.version);
    }
    return out;
  }

  read(owner: OwnerId, linkId: string, live: Live): StoredImage | null {
    const image = live(owner, linkId) ? this.rows.get(keyOf(owner, linkId))?.image : null;
    return image ? { ...image, bytes: new Uint8Array(image.bytes) } : null;
  }

  /** Test inspection: the row as `link_favicons` would hold it. */
  row(owner: OwnerId, linkId: string): FaviconRow | null {
    const row = this.rows.get(keyOf(owner, linkId));
    if (!row) return null;
    const { image, candidates, ...rest } = row;
    return { ...rest, candidates: [...candidates], stored: image !== null };
  }

  /** The row, while the live link's favicon is pending at `generation`. */
  private claimed(owner: OwnerId, linkId: string, generation: number, live: Live) {
    const row = this.rows.get(keyOf(owner, linkId));
    const ok = row?.status === "pending" && row.generation === generation && live(owner, linkId);
    return ok ? row : undefined;
  }
}
