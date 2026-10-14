import type { Database } from "better-sqlite3";
import {
  hasConsistentSchedule,
  type SnapshotLease,
  type SnapshotRecord,
  type SnapshotStore,
} from "../core/snapshot-store.js";
import type { LinkExpectation, LinkStore, SurfacedClaim } from "../core/store.js";
import type {
  Labelled,
  Link,
  LinkPatch,
  LinkTag,
  NewLink,
  OwnerId,
  SnapshotStatus,
  Tag,
  TagKind,
  TagPatch,
} from "../core/types.js";

export class StoreError extends Error {
  constructor(
    readonly code: "unknown_owner",
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

type LinkRow = {
  id: number;
  url: string;
  url_key: string;
  title: string | null;
  summary: string | null;
  why_text: string | null;
  why_source: Labelled["source"] | null;
  saved_at: number;
  saved_by: string;
  last_opened_at: number | null;
  last_surfaced_at: number | null;
  snoozed_until: number | null;
  state: Link["state"];
};

type TagRow = Omit<Tag, "pinned"> & { pinned: number };

const TAG_COLUMNS = `key, name, kind, kind_source AS kindSource, color, pinned, description,
  project_status AS projectStatus`;

function toMs(d: Date | null): number | null {
  if (d === null) return null;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("Cannot store an invalid date.");
  return ms;
}

const fromMs = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/** Canonical decimal ids in 1..MAX_SAFE_INTEGER; anything else was never issued. */
export function parseId(id: string): number | null {
  if (!/^[1-9][0-9]*$/.test(id)) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : null;
}

type SnapshotRow = {
  fetch_status: SnapshotStatus;
  fetched_at: number | null;
  title: string | null;
  description: string | null;
  image_url: string | null;
};

export class SqliteStore implements LinkStore, SnapshotStore {
  constructor(private readonly db: Database) {}

  /** Idempotent. Owners are created here, outside LinkStore. */
  ensureUser(id: OwnerId, displayName: string): void {
    this.db
      .prepare(
        "INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, displayName, Date.now());
  }

  async insertIfAbsent(owner: OwnerId, link: NewLink) {
    return this.db.transaction(() => this.insertSync(owner, link)).immediate();
  }

  async get(owner: OwnerId, id: string) {
    const n = parseId(id);
    return n === null ? null : this.read(owner, n);
  }

  async update(owner: OwnerId, id: string, patch: LinkPatch) {
    const n = parseId(id);
    return n === null
      ? null
      : this.db.transaction(() => this.updateSync(owner, n, patch)).immediate();
  }

  async fillWhyIfMissing(owner: OwnerId, id: string, why: Labelled) {
    const n = parseId(id);
    return n === null ? null : this.db.transaction(() => this.fillSync(owner, n, why)).immediate();
  }

  async listTags(owner: OwnerId) {
    const rows = this.db
      .prepare(`SELECT ${TAG_COLUMNS} FROM tags WHERE owner_id = ? ORDER BY key`)
      .all(owner) as TagRow[];
    return rows.map((r): Tag => ({ ...r, pinned: r.pinned === 1 }));
  }

  async updateTag(owner: OwnerId, key: string, patch: TagPatch, expectedKind: TagKind) {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.kind !== undefined) {
      sets.push("kind = ?");
      values.push(patch.kind);
    }
    if (patch.kindSource !== undefined) {
      sets.push("kind_source = ?");
      values.push(patch.kindSource);
    }
    if (patch.projectStatus !== undefined) {
      sets.push("project_status = ?");
      values.push(patch.projectStatus);
    }
    if (sets.length === 0) sets.push("key = key");
    const row = this.db
      .prepare(
        `UPDATE tags SET ${sets.join(", ")} WHERE owner_id = ? AND key = ? AND kind = ?
         RETURNING ${TAG_COLUMNS}`,
      )
      .get(...values, owner, key, expectedKind) as TagRow | undefined;
    return row ? { ...row, pinned: row.pinned === 1 } : null;
  }

  async updateIf(owner: OwnerId, id: string, expected: LinkExpectation, patch: LinkPatch) {
    const n = parseId(id);
    if (n === null) return null;
    return this.db
      .transaction(() => {
        const link = this.updateSync(owner, n, patch, expected);
        if (link) return { link, applied: true };
        const current = this.read(owner, n);
        return current ? { link: current, applied: false } : null;
      })
      .immediate();
  }

  async listLinks(owner: OwnerId) {
    return this.db.transaction(() => this.readAll(owner))();
  }

  async claimSurfaced(
    owner: OwnerId,
    ids: string[],
    when: { at: Date; notSurfacedAfter: Date; now: Date },
  ): Promise<SurfacedClaim[]> {
    const parsed = new Set(ids.map(parseId).filter((n): n is number => n !== null));
    return this.db.transaction(() => this.claimSync(owner, [...parsed], when)).immediate();
  }

  async dueSnapshots(now: Date, limit: number) {
    const rows = this.db
      .prepare(
        `SELECT owner_id, link_id FROM snapshots
         WHERE fetch_status IN ('pending', 'retrying') AND next_fetch_at <= ?
         ORDER BY next_fetch_at, link_id LIMIT ?`,
      )
      .all(toMs(now), limit) as { owner_id: string; link_id: number }[];
    return rows.map((r) => ({ owner: r.owner_id, linkId: String(r.link_id) }));
  }

  async leaseSnapshot(
    owner: OwnerId,
    linkId: string,
    now: Date,
    until: Date,
  ): Promise<SnapshotLease | null> {
    if ((toMs(until) as number) <= (toMs(now) as number)) {
      throw new RangeError("A lease must end after it starts.");
    }
    const n = parseId(linkId);
    if (n === null) return null;
    const row = this.db
      .prepare(
        `UPDATE snapshots SET next_fetch_at = ?, attempts = attempts + 1, lease_token = lease_token + 1
         WHERE link_id = ? AND owner_id = ? AND fetch_status IN ('pending', 'retrying')
           AND next_fetch_at <= ?
         RETURNING attempts, lease_token`,
      )
      .get(toMs(until), n, owner, toMs(now)) as
      | { attempts: number; lease_token: number }
      | undefined;
    if (!row) return null;
    const { url } = this.db.prepare("SELECT url FROM links WHERE id = ?").get(n) as { url: string };
    return { url, attempts: row.attempts, claim: row.lease_token };
  }

  async releaseSnapshot(owner: OwnerId, linkId: string, claim: number, now: Date) {
    const n = parseId(linkId);
    if (n === null) return false;
    const { changes } = this.db
      .prepare(
        `UPDATE snapshots SET attempts = attempts - 1, next_fetch_at = ?, lease_token = lease_token + 1
         WHERE link_id = ? AND owner_id = ? AND lease_token = ?
           AND fetch_status IN ('pending', 'retrying')`,
      )
      .run(toMs(now), n, owner, claim);
    return changes === 1;
  }

  async recordSnapshot(owner: OwnerId, linkId: string, claim: number, r: SnapshotRecord) {
    const n = parseId(linkId);
    if (n === null || !hasConsistentSchedule(r)) return false;
    const { changes } = this.db
      .prepare(
        `UPDATE snapshots SET fetch_status = ?, attempts = ?, next_fetch_at = ?, fetched_at = ?,
           title = ?, description = ?, image_url = ?,
           image_status = CASE WHEN ? IS NULL THEN NULL ELSE 'pending' END, text = ?, last_error = ?,
           lease_token = lease_token + 1
         WHERE link_id = ? AND owner_id = ? AND lease_token = ?`,
      )
      .run(
        r.status,
        r.attempts,
        toMs(r.nextFetchAt),
        toMs(r.fetchedAt),
        r.title,
        r.description,
        r.imageUrl,
        r.imageUrl,
        r.text,
        r.lastError,
        n,
        owner,
        claim,
      );
    return changes === 1;
  }

  async getSnapshotText(owner: OwnerId, linkId: string) {
    const n = parseId(linkId);
    if (n === null) return null;
    const row = this.db
      .prepare("SELECT text FROM snapshots WHERE link_id = ? AND owner_id = ?")
      .get(n, owner) as { text: string | null } | undefined;
    return row?.text ?? null;
  }

  private insertSync(owner: OwnerId, link: NewLink): { link: Link; created: boolean } {
    let row: { id: number } | undefined;
    try {
      row = this.db
        .prepare(
          `INSERT INTO links (owner_id, url, url_key, title, summary, why_text, why_source, saved_at,
             saved_by, last_opened_at, last_surfaced_at, snoozed_until, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, url_key) DO NOTHING RETURNING id`,
        )
        .get(
          owner,
          link.url,
          link.urlKey,
          link.title,
          link.summary,
          link.why?.text ?? null,
          link.why?.source ?? null,
          toMs(link.savedAt),
          link.savedBy,
          toMs(link.lastOpenedAt),
          toMs(link.lastSurfacedAt),
          toMs(link.snoozedUntil),
          link.state,
        ) as { id: number } | undefined;
    } catch (e) {
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        throw new StoreError(
          "unknown_owner",
          `Owner "${owner}" does not exist. Create it with ensureUser first.`,
        );
      }
      throw e;
    }
    if (row) {
      this.db
        .prepare(
          "INSERT INTO snapshots (link_id, owner_id, fetch_status, next_fetch_at) VALUES (?, ?, 'pending', ?)",
        )
        .run(row.id, owner, toMs(link.savedAt));
      this.attachTags(owner, row.id, link.tags);
      return { link: this.mustRead(owner, row.id), created: true };
    }
    const existing = this.db
      .prepare("SELECT id FROM links WHERE owner_id = ? AND url_key = ?")
      .get(owner, link.urlKey) as { id: number };
    return { link: this.mustRead(owner, existing.id), created: false };
  }

  /** With `expected`, the row is written only while it matches (see `LinkStore.updateIf`). */
  private updateSync(
    owner: OwnerId,
    id: number,
    patch: LinkPatch,
    expected: LinkExpectation = {},
  ): Link | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.title !== undefined) set("title", patch.title);
    if (patch.summary !== undefined) set("summary", patch.summary);
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.snoozedUntil !== undefined) set("snoozed_until", toMs(patch.snoozedUntil));
    if (patch.lastOpenedAt !== undefined) set("last_opened_at", toMs(patch.lastOpenedAt));
    if (patch.why !== undefined) {
      set("why_text", patch.why?.text ?? null);
      set("why_source", patch.why?.source ?? null);
    }
    if (sets.length === 0) sets.push("id = id");
    const where = ["id = ?", "owner_id = ?"];
    const whereValues: unknown[] = [id, owner];
    if (expected.state !== undefined) {
      where.push("state = ?");
      whereValues.push(expected.state);
    }
    if (expected.snoozedUntil !== undefined) {
      where.push("snoozed_until IS ?");
      whereValues.push(toMs(expected.snoozedUntil));
    }
    if (expected.whySource !== undefined) {
      const sources = expected.whySource.filter((s) => s !== null);
      const either = sources.map(() => "why_source = ?");
      if (expected.whySource.includes(null)) either.push("why_source IS NULL");
      where.push(either.length > 0 ? `(${either.join(" OR ")})` : "0");
      whereValues.push(...sources);
    }
    const matched = this.db
      .prepare(`UPDATE links SET ${sets.join(", ")} WHERE ${where.join(" AND ")} RETURNING id`)
      .get(...values, ...whereValues);
    if (!matched) return null;
    if (patch.tags !== undefined) {
      this.db.prepare("DELETE FROM link_tags WHERE link_id = ? AND owner_id = ?").run(id, owner);
      this.attachTags(owner, id, patch.tags);
    }
    return this.read(owner, id);
  }

  private fillSync(owner: OwnerId, id: number, why: Labelled): Link | null {
    this.db
      .prepare(
        "UPDATE links SET why_text = ?, why_source = ? WHERE id = ? AND owner_id = ? AND why_text IS NULL",
      )
      .run(why.text, why.source, id, owner);
    return this.read(owner, id);
  }

  private claimSync(
    owner: OwnerId,
    ids: number[],
    { at, notSurfacedAfter, now }: { at: Date; notSurfacedAfter: Date; now: Date },
  ): SurfacedClaim[] {
    const previous = this.db.prepare(
      `SELECT last_surfaced_at FROM links
       WHERE id = ? AND owner_id = ? AND state = 'active'
         AND (snoozed_until IS NULL OR snoozed_until <= ?)
         AND (last_surfaced_at IS NULL OR last_surfaced_at <= ?)`,
    );
    const mark = this.db.prepare(
      "UPDATE links SET last_surfaced_at = ? WHERE id = ? AND owner_id = ?",
    );
    const claimed: SurfacedClaim[] = [];
    for (const id of ids) {
      const row = previous.get(id, owner, toMs(now), toMs(notSurfacedAfter)) as
        | { last_surfaced_at: number | null }
        | undefined;
      if (!row) continue;
      mark.run(toMs(at), id, owner);
      claimed.push({
        link: this.mustRead(owner, id),
        previousSurfacedAt: fromMs(row.last_surfaced_at),
      });
    }
    return claimed;
  }

  private attachTags(owner: OwnerId, linkId: number, tags: LinkTag[]): void {
    const create = this.db.prepare(
      `INSERT INTO tags (owner_id, key, name, kind, kind_source, pinned) VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT (owner_id, key) DO NOTHING`,
    );
    const attach = this.db.prepare(
      `INSERT INTO link_tags (owner_id, link_id, tag_id, source, position)
       SELECT ?, ?, id, ?, ? FROM tags WHERE owner_id = ? AND key = ?`,
    );
    tags.forEach((t, position) => {
      create.run(owner, t.key, t.name, t.kind, t.kindSource);
      attach.run(owner, linkId, t.source, position, owner, t.key);
    });
  }

  private mustRead(owner: OwnerId, id: number): Link {
    const link = this.read(owner, id);
    if (!link) throw new Error(`Link ${id} vanished inside its own transaction.`);
    return link;
  }

  private read(owner: OwnerId, id: number): Link | null {
    const row = this.db
      .prepare("SELECT * FROM links WHERE id = ? AND owner_id = ?")
      .get(id, owner) as LinkRow | undefined;
    if (!row) return null;
    const tags = this.db
      .prepare(`${TAG_SELECT} WHERE lt.link_id = ? AND lt.owner_id = ? ORDER BY lt.position`)
      .all(id, owner) as LinkTag[];
    const snap = this.db
      .prepare(`${SNAPSHOT_SELECT} WHERE link_id = ? AND owner_id = ?`)
      .get(id, owner) as SnapshotRow | undefined;
    return toLink(row, tags, snap);
  }

  /** The owner's links in three queries, not three per link. */
  private readAll(owner: OwnerId): Link[] {
    const rows = this.db
      .prepare("SELECT * FROM links WHERE owner_id = ? ORDER BY id")
      .all(owner) as LinkRow[];
    const tags = new Map<number, LinkTag[]>();
    const tagRows = this.db
      .prepare(`${TAG_SELECT} WHERE lt.owner_id = ? ORDER BY lt.link_id, lt.position`)
      .all(owner) as (LinkTag & { linkId: number })[];
    for (const tag of tagRows) {
      const list = tags.get(tag.linkId) ?? [];
      list.push(tag);
      tags.set(tag.linkId, list);
    }
    const snaps = new Map(
      (
        this.db.prepare(`${SNAPSHOT_SELECT} WHERE owner_id = ?`).all(owner) as (SnapshotRow & {
          link_id: number;
        })[]
      ).map((s) => [s.link_id, s]),
    );
    return rows.map((row) => toLink(row, tags.get(row.id) ?? [], snaps.get(row.id)));
  }
}

const TAG_SELECT = `SELECT lt.link_id AS linkId, t.key AS key, t.name AS name, lt.source AS source,
    t.kind AS kind, t.kind_source AS kindSource
  FROM link_tags lt JOIN tags t ON t.id = lt.tag_id AND t.owner_id = lt.owner_id`;

const SNAPSHOT_SELECT = `SELECT link_id, fetch_status, fetched_at, title, description, image_url
  FROM snapshots`;

/** Only the LinkTag fields of `tagRows` are kept; TAG_SELECT also reads the link id. */
function toLink(row: LinkRow, tagRows: LinkTag[], snap: SnapshotRow | undefined): Link {
  const tags = tagRows.map(({ key, name, source, kind, kindSource }) => ({
    key,
    name,
    source,
    kind,
    kindSource,
  }));
  return {
    id: String(row.id),
    url: row.url,
    urlKey: row.url_key,
    title: row.title,
    summary: row.summary,
    why:
      row.why_text !== null && row.why_source !== null
        ? { text: row.why_text, source: row.why_source }
        : null,
    tags,
    savedAt: new Date(row.saved_at),
    savedBy: row.saved_by,
    lastOpenedAt: fromMs(row.last_opened_at),
    lastSurfacedAt: fromMs(row.last_surfaced_at),
    snoozedUntil: fromMs(row.snoozed_until),
    state: row.state,
    snapshot: snap
      ? {
          status: snap.fetch_status,
          fetchedAt: fromMs(snap.fetched_at),
          title: snap.title,
          description: snap.description,
          imageUrl: snap.image_url,
        }
      : null,
  };
}
