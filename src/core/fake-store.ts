import {
  hasConsistentSchedule,
  type SnapshotLease,
  type SnapshotRecord,
  type SnapshotStore,
} from "./snapshot-store.js";
import type { LinkStore, SurfacedClaim } from "./store.js";
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

/** In-memory LinkStore for tests; honours the same contracts as the real store. */
export class FakeStore implements LinkStore, SnapshotStore {
  private snapshots = new Map<OwnerId, Map<string, SnapshotRecord>>();
  /** The lease token of each snapshot, by owner then link id; absent means 0. */
  private tokens = new Map<OwnerId, Map<string, number>>();
  private links = new Map<OwnerId, Map<string, Link>>();
  private tags = new Map<OwnerId, Map<string, Tag>>();
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
