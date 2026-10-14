import { createHash } from "node:crypto";
import {
  type ImageBytes,
  type ImageEnd,
  type ImageStore,
  imageVersion,
  type LinkImageReader,
  type PendingImage,
  type StoredImage,
} from "./image-store.js";
import {
  hasConsistentSchedule,
  type SnapshotLease,
  type SnapshotRecord,
  type SnapshotStore,
} from "./snapshot-store.js";
import type { LinkExpectation, LinkStore, SurfacedClaim } from "./store.js";
import type {
  Labelled,
  Link,
  LinkPatch,
  NewLink,
  OwnerId,
  Tag,
  TagKind,
  TagPatch,
} from "./types.js";

type ImageStatus = "pending" | "ok" | ImageEnd;
const imageKey = (owner: OwnerId, linkId: string) => JSON.stringify([owner, linkId]);

/** In-memory LinkStore for tests; honours the same contracts as the real store. */
export class FakeStore implements LinkStore, SnapshotStore, ImageStore, LinkImageReader {
  private snapshots = new Map<OwnerId, Map<string, SnapshotRecord>>();
  /** The lease token of each snapshot, by owner then link id; absent means 0. */
  private tokens = new Map<OwnerId, Map<string, number>>();
  private links = new Map<OwnerId, Map<string, Link>>();
  private tags = new Map<OwnerId, Map<string, Tag>>();
  /** Each link's image status, and its stored image, by `imageKey`. */
  private imageStates = new Map<string, { status: ImageStatus }>();
  private storedImages = new Map<string, StoredImage>();
  private nextId = 1;

  private owned(owner: OwnerId): Map<string, Link> {
    let m = this.links.get(owner);
    if (!m) {
      m = new Map();
      this.links.set(owner, m);
    }
    return m;
  }

  private catalogOf(owner: OwnerId): Map<string, Tag> {
    let m = this.tags.get(owner);
    if (!m) {
      m = new Map();
      this.tags.set(owner, m);
    }
    return m;
  }

  private ensureTags(owner: OwnerId, tags: Link["tags"]): void {
    const catalog = this.catalogOf(owner);
    for (const t of tags) {
      if (!catalog.has(t.key)) {
        catalog.set(t.key, {
          key: t.key,
          name: t.name,
          kind: t.kind,
          kindSource: t.kindSource,
          color: null,
          pinned: false,
          description: null,
          projectStatus: null,
        });
      }
    }
  }

  private view(owner: OwnerId, link: Link): Link {
    const catalog = this.catalogOf(owner);
    const out = structuredClone(link);
    const s = this.snapshots.get(owner)?.get(link.id);
    out.snapshot = s
      ? {
          status: s.status,
          fetchedAt: s.fetchedAt && new Date(s.fetchedAt),
          title: s.title,
          description: s.description,
          imageUrl: s.imageUrl,
        }
      : null;
    for (const t of out.tags) {
      const entry = catalog.get(t.key);
      t.name = entry?.name ?? t.name;
      t.kind = entry?.kind ?? t.kind;
      t.kindSource = entry?.kindSource ?? t.kindSource;
    }
    return out;
  }

  async insertIfAbsent(owner: OwnerId, link: NewLink) {
    const mine = this.owned(owner);
    for (const existing of mine.values()) {
      if (existing.urlKey === link.urlKey) {
        return { link: this.view(owner, existing), created: false };
      }
    }
    this.ensureTags(owner, link.tags);
    const stored: Link = { ...structuredClone(link), id: `link-${this.nextId++}`, snapshot: null };
    mine.set(stored.id, stored);
    this.snapshotsOf(owner).set(stored.id, {
      status: "pending",
      attempts: 0,
      nextFetchAt: new Date(link.savedAt),
      fetchedAt: null,
      title: null,
      description: null,
      imageUrl: null,
      text: null,
      lastError: null,
    });
    return { link: this.view(owner, stored), created: true };
  }

  private snapshotsOf(owner: OwnerId): Map<string, SnapshotRecord> {
    let m = this.snapshots.get(owner);
    if (!m) {
      m = new Map();
      this.snapshots.set(owner, m);
    }
    return m;
  }

  async dueSnapshots(now: Date, limit: number) {
    const due: { owner: OwnerId; linkId: string; at: number }[] = [];
    for (const [owner, mine] of this.snapshots) {
      for (const [linkId, s] of mine) {
        const at = s.nextFetchAt?.getTime();
        if (at !== undefined && at <= now.getTime() && ["pending", "retrying"].includes(s.status)) {
          due.push({ owner, linkId, at });
        }
      }
    }
    due.sort((a, b) => a.at - b.at);
    return due.slice(0, limit).map(({ owner, linkId }) => ({ owner, linkId }));
  }

  async leaseSnapshot(
    owner: OwnerId,
    linkId: string,
    now: Date,
    until: Date,
  ): Promise<SnapshotLease | null> {
    if (until.getTime() <= now.getTime()) throw new RangeError("A lease must end after it starts.");
    const s = this.snapshots.get(owner)?.get(linkId);
    const due = s?.nextFetchAt && s.nextFetchAt.getTime() <= now.getTime();
    if (!s || !due || !["pending", "retrying"].includes(s.status)) return null;
    s.nextFetchAt = new Date(until);
    s.attempts += 1;
    const url = (this.owned(owner).get(linkId) as Link).url;
    return { url, attempts: s.attempts, claim: this.bumpToken(owner, linkId) };
  }

  async recordSnapshot(owner: OwnerId, linkId: string, claim: number, result: SnapshotRecord) {
    const mine = this.snapshotsOf(owner);
    if (!mine.has(linkId) || this.tokenOf(owner, linkId) !== claim) return false;
    if (!hasConsistentSchedule(result)) return false;
    mine.set(linkId, structuredClone(result));
    if (result.imageUrl === null) this.imageStates.delete(imageKey(owner, linkId));
    else this.imageStates.set(imageKey(owner, linkId), { status: "pending" });
    this.bumpToken(owner, linkId);
    return true;
  }

  async releaseSnapshot(owner: OwnerId, linkId: string, claim: number, now: Date) {
    const s = this.snapshots.get(owner)?.get(linkId);
    if (!s || this.tokenOf(owner, linkId) !== claim) return false;
    if (!["pending", "retrying"].includes(s.status)) return false;
    s.attempts -= 1;
    s.nextFetchAt = new Date(now);
    this.bumpToken(owner, linkId);
    return true;
  }

  private tokenOf(owner: OwnerId, linkId: string): number {
    return this.tokens.get(owner)?.get(linkId) ?? 0;
  }

  private bumpToken(owner: OwnerId, linkId: string): number {
    let m = this.tokens.get(owner);
    if (!m) {
      m = new Map();
      this.tokens.set(owner, m);
    }
    const next = this.tokenOf(owner, linkId) + 1;
    m.set(linkId, next);
    return next;
  }

  async getSnapshotText(owner: OwnerId, linkId: string) {
    return this.snapshots.get(owner)?.get(linkId)?.text ?? null;
  }

  async get(owner: OwnerId, id: string) {
    const found = this.owned(owner).get(id);
    return found ? this.view(owner, found) : null;
  }

  async update(owner: OwnerId, id: string, patch: LinkPatch) {
    const found = this.owned(owner).get(id);
    if (!found) return null;
    const fields = structuredClone(patch);
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (found as Record<string, unknown>)[k] = v;
    }
    if (fields.tags) this.ensureTags(owner, fields.tags);
    return this.view(owner, found);
  }

  async fillWhyIfMissing(owner: OwnerId, id: string, why: Labelled) {
    const found = this.owned(owner).get(id);
    if (!found) return null;
    if (found.why === null) found.why = { ...why };
    return this.view(owner, found);
  }

  async listTags(owner: OwnerId) {
    return this.catalog(owner).sort((a, b) =>
      Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)),
    );
  }

  async updateTag(owner: OwnerId, key: string, patch: TagPatch, expectedKind: TagKind) {
    const entry = this.catalogOf(owner).get(key);
    if (!entry || entry.kind !== expectedKind) return null;
    if (patch.kind !== undefined) entry.kind = patch.kind;
    if (patch.kindSource !== undefined) entry.kindSource = patch.kindSource;
    if (patch.projectStatus !== undefined) entry.projectStatus = patch.projectStatus;
    return structuredClone(entry);
  }

  async updateIf(owner: OwnerId, id: string, expected: LinkExpectation, patch: LinkPatch) {
    const found = this.owned(owner).get(id);
    if (!found) return null;
    const matches =
      (expected.state === undefined || found.state === expected.state) &&
      (expected.snoozedUntil === undefined ||
        (found.snoozedUntil?.getTime() ?? null) === (expected.snoozedUntil?.getTime() ?? null)) &&
      (expected.whySource === undefined || expected.whySource.includes(found.why?.source ?? null));
    if (!matches) return { link: this.view(owner, found), applied: false };
    return { link: (await this.update(owner, id, patch)) as Link, applied: true };
  }

  async pinTag(
    owner: OwnerId,
    key: string,
    pin: { pinned: true; color: string } | { pinned: false },
  ) {
    const entry = this.catalogOf(owner).get(key);
    if (!entry) return null;
    entry.pinned = pin.pinned;
    if (pin.pinned) entry.color ??= pin.color;
    return structuredClone(entry);
  }

  async colorTag(owner: OwnerId, key: string, color: string) {
    const entry = this.catalogOf(owner).get(key);
    if (!entry) return null;
    entry.color = color;
    return structuredClone(entry);
  }

  async listLinks(owner: OwnerId) {
    return [...this.owned(owner).values()].map((l) => this.view(owner, l));
  }

  async claimSurfaced(
    owner: OwnerId,
    ids: string[],
    { at, notSurfacedAfter, now }: { at: Date; notSurfacedAfter: Date; now: Date },
  ): Promise<SurfacedClaim[]> {
    const claimed: SurfacedClaim[] = [];
    for (const id of new Set(ids)) {
      const found = this.owned(owner).get(id);
      if (
        found?.state !== "active" ||
        (found.snoozedUntil !== null && found.snoozedUntil > now) ||
        (found.lastSurfacedAt !== null && found.lastSurfacedAt > notSurfacedAfter)
      ) {
        continue;
      }
      const previousSurfacedAt = found.lastSurfacedAt;
      found.lastSurfacedAt = new Date(at);
      claimed.push({ link: this.view(owner, found), previousSurfacedAt });
    }
    return claimed;
  }

  async pendingImages(afterId: string | null, limit: number): Promise<PendingImage[]> {
    const order = (id: string) => Number(id.replace(/^link-/, ""));
    const pending: PendingImage[] = [];
    for (const [owner, mine] of this.snapshots) {
      for (const [linkId, s] of mine) {
        const state = this.imageStates.get(imageKey(owner, linkId));
        if (s.imageUrl === null || state?.status !== "pending") continue;
        if (afterId !== null && order(linkId) <= order(afterId)) continue;
        pending.push({ owner, linkId, imageUrl: s.imageUrl });
      }
    }
    return pending.sort((a, b) => order(a.linkId) - order(b.linkId)).slice(0, limit);
  }

  async writeImage(owner: OwnerId, linkId: string, imageUrl: string, image: ImageBytes) {
    if (!this.settle(owner, linkId, imageUrl, "ok")) return false;
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    this.storedImages.set(imageKey(owner, linkId), {
      contentType: image.contentType,
      bytes: new Uint8Array(image.bytes),
      version: imageVersion(sha256),
    });
    return true;
  }

  async endImage(owner: OwnerId, linkId: string, imageUrl: string, end: ImageEnd) {
    return this.settle(owner, linkId, imageUrl, end);
  }

  async imageVersions(owner: OwnerId, linkIds: string[]) {
    const versions = new Map<string, string>();
    for (const id of linkIds) {
      const stored = this.storedImages.get(imageKey(owner, id));
      if (stored) versions.set(id, stored.version);
    }
    return versions;
  }

  async image(owner: OwnerId, linkId: string): Promise<StoredImage | null> {
    const stored = this.storedImages.get(imageKey(owner, linkId));
    return stored ? structuredClone(stored) : null;
  }

  private settle(owner: OwnerId, linkId: string, imageUrl: string, status: ImageStatus): boolean {
    const key = imageKey(owner, linkId);
    const state = this.imageStates.get(key);
    const url = this.snapshots.get(owner)?.get(linkId)?.imageUrl;
    if (state?.status !== "pending" || url !== imageUrl) return false;
    this.imageStates.set(key, { status });
    return true;
  }

  seedTag(owner: OwnerId, tag: Tag): void {
    this.catalogOf(owner).set(tag.key, structuredClone(tag));
  }

  catalog(owner: OwnerId): Tag[] {
    return [...this.catalogOf(owner).values()].map((t) => structuredClone(t));
  }

  /** Test inspection: all of an owner's links. */
  all(owner: OwnerId): Link[] {
    return [...this.owned(owner).values()].map((l) => this.view(owner, l));
  }
}
