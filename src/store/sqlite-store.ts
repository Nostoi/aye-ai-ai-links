import type { Database } from "better-sqlite3";
import { anyChanged, changedFields } from "../core/covered-fields.js";
import {
  hasConsistentSchedule,
  hasValidIcons,
  type SnapshotLease,
  type SnapshotRecord,
  type SnapshotStore,
} from "../core/snapshot-store.js";
import type { LinkExpectation, LinkRemover, LinkStore, SurfacedClaim } from "../core/store.js";
import {
  sameTool,
  type ToolRecord,
  type ToolStore,
  type ToolWrite,
  type WaitDays,
} from "../core/tool-store.js";
import type {
  Labelled,
  Link,
  LinkPatch,
  LinkTag,
  NewLink,
  OwnerId,
  SnapshotStatus,
  Source,
  SummarySource,
  Tag,
  TagKind,
  TagPatch,
  ToolStatus,
} from "../core/types.js";
import { attachTags, readCovered, TAG_SELECT, writeReceipt } from "./link-edit-receipts.js";
import { COPY_MAY_HOLD_FILES, removeCopyWithLink, restoreCopyWithLink } from "./saved-copies.js";
import { fromMs, parseId, toMs } from "./sql-values.js";

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
  summary_source: SummarySource | null;
  why_text: string | null;
  why_source: Labelled["source"] | null;
  saved_at: number;
  saved_by: string;
  last_opened_at: number | null;
  last_surfaced_at: number | null;
  snoozed_until: number | null;
  put_away_at: number | null;
  tidy_kept_at: number | null;
  state: Link["state"];
};

type TagRow = Omit<Tag, "pinned"> & { pinned: number };

const TAG_COLUMNS = `key, name, kind, kind_source AS kindSource, color, pinned, description,
  project_status AS projectStatus`;

type SnapshotRow = {
  fetch_status: SnapshotStatus;
  fetched_at: number | null;
  title: string | null;
  description: string | null;
  image_url: string | null;
};

export class SqliteStore implements LinkStore, LinkRemover, SnapshotStore, ToolStore {
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

  async updateWithReceipt(owner: OwnerId, id: string, patch: LinkPatch, at: Date, extend?: string) {
    const n = parseId(id);
    if (n === null) return null;
    return this.db
      .transaction(() => {
        const before = readCovered(this.db, owner, n);
        const link = this.updateSync(owner, n, patch);
        if (!before || !link) return null;
        const changed = changedFields(before, link);
        const editId = anyChanged(changed)
          ? writeReceipt(this.db, owner, n, changed, before, link, at, extend)
          : null;
        return { link, editId };
      })
      .immediate();
  }

  async fillWhyIfMissing(owner: OwnerId, id: string, why: Labelled) {
    const n = parseId(id);
    return n === null ? null : this.db.transaction(() => this.fillSync(owner, n, why)).immediate();
  }

  async fillWhyWithReceipt(owner: OwnerId, id: string, why: Labelled, at: Date, extend?: string) {
    const n = parseId(id);
    if (n === null) return null;
    return this.db
      .transaction(() => {
        const before = readCovered(this.db, owner, n);
        const filled = this.fillRow(owner, n, why);
        const link = this.read(owner, n);
        if (!before || !link) return null;
        const editId = filled
          ? writeReceipt(this.db, owner, n, changedFields(before, link), before, link, at, extend)
          : null;
        return { link, editId };
      })
      .immediate();
  }

  async markDeleted(owner: OwnerId, id: string, at: Date): Promise<boolean> {
    const n = parseId(id);
    if (n === null) return false;
    const ms = toMs(at);
    return this.db
      .transaction(() => {
        const hidden = this.db
          .prepare(
            "UPDATE links SET deleted_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
          )
          .run(ms, n, owner).changes;
        if (hidden !== 1) return false;
        removeCopyWithLink(this.db, owner, n, ms);
        return true;
      })
      .immediate();
  }

  async unmarkDeleted(owner: OwnerId, id: string, since: Date): Promise<boolean> {
    const n = parseId(id);
    if (n === null) return false;
    const from = toMs(since);
    return this.db
      .transaction(() => {
        const deletedAt = this.db
          .prepare("SELECT deleted_at FROM links WHERE id = ? AND owner_id = ? AND deleted_at >= ?")
          .pluck()
          .get(n, owner, from) as number | undefined;
        if (deletedAt === undefined) return false;
        this.db
          .prepare("UPDATE links SET deleted_at = NULL WHERE id = ? AND owner_id = ?")
          .run(n, owner);
        restoreCopyWithLink(this.db, owner, n, deletedAt);
        return true;
      })
      .immediate();
  }

  async purgeDeleted(before: Date): Promise<number> {
    const cutoff = toMs(before);
    return this.db
      .transaction(
        () =>
          this.db
            .prepare(
              `DELETE FROM links WHERE deleted_at IS NOT NULL AND deleted_at < ?
                 AND NOT EXISTS (SELECT 1 FROM saved_copies c WHERE c.owner_id = links.owner_id
                   AND c.link_id = links.id AND ${COPY_MAY_HOLD_FILES})`,
            )
            .run(cutoff).changes,
      )
      .immediate();
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

  async pinTag(
    owner: OwnerId,
    key: string,
    pin: { pinned: true; color: string } | { pinned: false },
  ) {
    const row = (
      pin.pinned
        ? this.db
            .prepare(
              `UPDATE tags SET pinned = 1, color = COALESCE(color, ?) WHERE owner_id = ? AND key = ?
               RETURNING ${TAG_COLUMNS}`,
            )
            .get(pin.color, owner, key)
        : this.db
            .prepare(
              `UPDATE tags SET pinned = 0 WHERE owner_id = ? AND key = ? RETURNING ${TAG_COLUMNS}`,
            )
            .get(owner, key)
    ) as TagRow | undefined;
    return row ? { ...row, pinned: row.pinned === 1 } : null;
  }

  async colorTag(owner: OwnerId, key: string, color: string) {
    const row = this.db
      .prepare(`UPDATE tags SET color = ? WHERE owner_id = ? AND key = ? RETURNING ${TAG_COLUMNS}`)
      .get(color, owner, key) as TagRow | undefined;
    return row ? { ...row, pinned: row.pinned === 1 } : null;
  }

  async listLinks(owner: OwnerId) {
    return this.db.transaction(() => this.readAll(owner))();
  }

  async claimSurfaced(
    owner: OwnerId,
    ids: string[],
    when: {
      at: Date;
      notSurfacedAfter: Date;
      now: Date;
      exceptKeptTools?: boolean;
      exceptGone?: boolean;
      expectedPutAwayAt?: Date;
    },
  ): Promise<SurfacedClaim[]> {
    const parsed = new Set(ids.map(parseId).filter((n): n is number => n !== null));
    return this.db.transaction(() => this.claimSync(owner, [...parsed], when)).immediate();
  }

  async unclaimSurfaced(owner: OwnerId, id: string, claim: { at: Date; previous: Date | null }) {
    const n = parseId(id);
    if (n === null) return false;
    const { changes } = this.db
      .prepare(
        `UPDATE links SET last_surfaced_at = ?
         WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND last_surfaced_at = ?`,
      )
      .run(toMs(claim.previous), n, owner, toMs(claim.at));
    return changes === 1;
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
    if (n === null || !hasConsistentSchedule(r) || !hasValidIcons(r)) return false;
    return this.db
      .transaction(() => {
        const { changes } = this.db
          .prepare(
            `UPDATE snapshots SET fetch_status = ?, attempts = ?, next_fetch_at = ?, fetched_at = ?,
               title = ?, description = ?, image_url = ?, icon_url = ?, icon_next_url = ?,
               image_status = CASE WHEN coalesce(?, ?) IS NOT NULL THEN 'pending'
                 WHEN ? IS NOT NULL THEN 'none' ELSE NULL END,
               text = ?, last_error = ?, lease_token = lease_token + 1
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
            r.iconUrls[0] ?? null,
            r.iconUrls[1] ?? null,
            r.imageUrl,
            r.iconUrls[0] ?? null,
            toMs(r.fetchedAt),
            r.text,
            r.lastError,
            n,
            owner,
            claim,
          );
        if (changes !== 1) return false;
        if (r.imageUrl !== null) {
          this.db
            .prepare("DELETE FROM link_images WHERE owner_id = ? AND link_id = ? AND role = 'icon'")
            .run(owner, n);
        }
        return true;
      })
      .immediate();
  }

  async getSnapshotText(owner: OwnerId, linkId: string) {
    const n = parseId(linkId);
    if (n === null) return null;
    const row = this.db
      .prepare(
        `SELECT s.text FROM snapshots s
         JOIN links l ON l.id = s.link_id AND l.owner_id = s.owner_id AND l.deleted_at IS NULL
         WHERE s.link_id = ? AND s.owner_id = ?`,
      )
      .get(n, owner) as { text: string | null } | undefined;
    return row?.text ?? null;
  }

  async getTool(owner: OwnerId, linkId: string) {
    const n = parseId(linkId);
    return n === null ? null : this.readTool(owner, n);
  }

  async listTools(owner: OwnerId) {
    const rows = this.db
      .prepare(`${TOOL_SELECT} WHERE owner_id = ? ORDER BY link_id`)
      .all(owner) as ToolRow[];
    return new Map<string, ToolRecord>(rows.map((r) => [String(r.link_id), toTool(r)]));
  }

  async updateToolIf(
    owner: OwnerId,
    linkId: string,
    expected: ToolRecord | null,
    next: ToolRecord | null,
  ): Promise<ToolWrite | null> {
    const n = parseId(linkId);
    if (n === null) return null;
    return this.db
      .transaction((): ToolWrite | null => {
        const link = this.db
          .prepare("SELECT 1 FROM links WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
          .get(n, owner);
        if (!link) return null;
        const current = this.readTool(owner, n);
        if (!sameTool(current, expected)) return { tool: current, applied: false };
        if (next === null) {
          this.db
            .prepare("DELETE FROM link_tools WHERE owner_id = ? AND link_id = ?")
            .run(owner, n);
          return { tool: null, applied: true };
        }
        this.db
          .prepare(
            `INSERT INTO link_tools (owner_id, link_id, status, source, since, answered_at, wait_days)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, link_id) DO UPDATE SET status = excluded.status,
               source = excluded.source, since = excluded.since,
               answered_at = excluded.answered_at, wait_days = excluded.wait_days`,
          )
          .run(
            owner,
            n,
            next.status,
            next.source,
            toMs(next.since),
            toMs(next.answeredAt),
            next.waitDays,
          );
        return { tool: this.readTool(owner, n), applied: true };
      })
      .immediate();
  }

  private insertSync(owner: OwnerId, link: NewLink): { link: Link; created: boolean } {
    this.db
      .prepare("DELETE FROM links WHERE owner_id = ? AND url_key = ? AND deleted_at IS NOT NULL")
      .run(owner, link.urlKey);
    let row: { id: number } | undefined;
    try {
      row = this.db
        .prepare(
          `INSERT INTO links (owner_id, url, url_key, title, summary, summary_source, why_text,
             why_source, saved_at, saved_by, last_opened_at, last_surfaced_at, snoozed_until, put_away_at,
             tidy_kept_at, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, url_key) DO NOTHING RETURNING id`,
        )
        .get(
          owner,
          link.url,
          link.urlKey,
          link.title,
          link.summary,
          link.summarySource,
          link.why?.text ?? null,
          link.why?.source ?? null,
          toMs(link.savedAt),
          link.savedBy,
          toMs(link.lastOpenedAt),
          toMs(link.lastSurfacedAt),
          toMs(link.snoozedUntil),
          toMs(link.putAwayAt),
          toMs(link.tidyKeptAt),
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
    if (patch.summary !== undefined || patch.summarySource !== undefined) {
      const pair: [string, unknown][] = [];
      if (patch.summary !== undefined) pair.push(["summary", patch.summary]);
      pair.push(["summary_source", patch.summarySource ?? null]);
      for (const [column, value] of pair) {
        if (patch.summaryOver === undefined) set(column, value);
        else {
          const guard = sourceIn("summary_source", patch.summaryOver);
          sets.push(`${column} = CASE WHEN ${guard.sql} THEN ? ELSE ${column} END`);
          values.push(...guard.values, value);
        }
      }
    }
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.snoozedUntil !== undefined) set("snoozed_until", toMs(patch.snoozedUntil));
    if (patch.lastOpenedAt !== undefined) set("last_opened_at", toMs(patch.lastOpenedAt));
    if (patch.putAwayAt !== undefined) set("put_away_at", toMs(patch.putAwayAt));
    if (patch.tidyKeptAt !== undefined) set("tidy_kept_at", toMs(patch.tidyKeptAt));
    if (patch.why !== undefined) {
      set("why_text", patch.why?.text ?? null);
      set("why_source", patch.why?.source ?? null);
    }
    if (sets.length === 0) sets.push("id = id");
    const where = ["id = ?", "owner_id = ?", "deleted_at IS NULL"];
    const whereValues: unknown[] = [id, owner];
    if (expected.state !== undefined) {
      where.push("state = ?");
      whereValues.push(expected.state);
    }
    if (expected.snoozedUntil !== undefined) {
      where.push("snoozed_until IS ?");
      whereValues.push(toMs(expected.snoozedUntil));
    }
    if (expected.putAwayAt !== undefined) {
      where.push("put_away_at IS ?");
      whereValues.push(toMs(expected.putAwayAt));
    }
    for (const [column, list] of [
      ["why_source", expected.whySource],
      ["summary_source", expected.summarySource],
    ] as const) {
      if (list === undefined) continue;
      const guard = sourceIn(column, list);
      where.push(guard.sql);
      whereValues.push(...guard.values);
    }
    if (expected.summary !== undefined) {
      where.push("summary IS ?");
      whereValues.push(expected.summary);
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
    this.fillRow(owner, id, why);
    return this.read(owner, id);
  }

  /** True when this call's UPDATE set the why. */
  private fillRow(owner: OwnerId, id: number, why: Labelled): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE links SET why_text = ?, why_source = ?
         WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND why_text IS NULL`,
      )
      .run(why.text, why.source, id, owner);
    return changes === 1;
  }

  private claimSync(
    owner: OwnerId,
    ids: number[],
    {
      at,
      notSurfacedAfter,
      now,
      exceptKeptTools,
      exceptGone,
      expectedPutAwayAt,
    }: {
      at: Date;
      notSurfacedAfter: Date;
      now: Date;
      exceptKeptTools?: boolean;
      exceptGone?: boolean;
      expectedPutAwayAt?: Date;
    },
  ): SurfacedClaim[] {
    // With an expected putAwayAt (a came-back claim) the link must be archived with exactly that marker,
    // and a surfacing before the marker does not count against the cooldown.
    const expected = expectedPutAwayAt ? toMs(expectedPutAwayAt) : null;
    const previous = this.db.prepare(
      `SELECT last_surfaced_at FROM links
       WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
         AND (CASE WHEN ? IS NULL THEN state = 'active'
                   ELSE state = 'archived' AND put_away_at = ? END)
         AND (snoozed_until IS NULL OR snoozed_until <= ?)
         AND (last_surfaced_at IS NULL OR last_surfaced_at <= ?
              OR (? IS NOT NULL AND last_surfaced_at < ?))
         AND (? = 0 OR NOT EXISTS (SELECT 1 FROM link_tools t
           WHERE t.owner_id = links.owner_id AND t.link_id = links.id AND t.status = 'kept'))
         AND (? = 0 OR NOT EXISTS (SELECT 1 FROM link_checks c
           WHERE c.owner_id = links.owner_id AND c.link_id = links.id AND c.flagged_at IS NOT NULL))`,
    );
    const mark = this.db.prepare(
      "UPDATE links SET last_surfaced_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
    );
    const claimed: SurfacedClaim[] = [];
    for (const id of ids) {
      const row = previous.get(
        id,
        owner,
        expected,
        expected,
        toMs(now),
        toMs(notSurfacedAfter),
        expected,
        expected,
        exceptKeptTools ? 1 : 0,
        exceptGone ? 1 : 0,
      ) as { last_surfaced_at: number | null } | undefined;
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
    attachTags(this.db, owner, linkId, tags);
  }

  private mustRead(owner: OwnerId, id: number): Link {
    const link = this.read(owner, id);
    if (!link) throw new Error(`Link ${id} vanished inside its own transaction.`);
    return link;
  }

  private readTool(owner: OwnerId, id: number): ToolRecord | null {
    const row = this.db
      .prepare(`${TOOL_SELECT} WHERE owner_id = ? AND link_id = ?`)
      .get(owner, id) as ToolRow | undefined;
    return row ? toTool(row) : null;
  }

  private read(owner: OwnerId, id: number): Link | null {
    const row = this.db
      .prepare("SELECT * FROM links WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
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
      .prepare("SELECT * FROM links WHERE owner_id = ? AND deleted_at IS NULL ORDER BY id")
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

/** SQL true while `column` holds one of `list`; a null in the list matches NULL. */
function sourceIn(column: string, list: readonly (string | null)[]) {
  const sources = list.filter((s) => s !== null);
  const either = sources.map(() => `${column} = ?`);
  if (list.includes(null)) either.push(`${column} IS NULL`);
  return { sql: either.length > 0 ? `(${either.join(" OR ")})` : "0", values: sources };
}

const SNAPSHOT_SELECT = `SELECT link_id, fetch_status, fetched_at, title, description, image_url
  FROM snapshots`;

type ToolRow = {
  link_id: number;
  status: ToolStatus;
  source: Source;
  since: number;
  answered_at: number | null;
  wait_days: WaitDays;
};

const TOOL_SELECT = "SELECT link_id, status, source, since, answered_at, wait_days FROM link_tools";

function toTool(r: ToolRow): ToolRecord {
  return {
    status: r.status,
    source: r.source,
    since: new Date(r.since),
    answeredAt: fromMs(r.answered_at),
    waitDays: r.wait_days,
  };
}

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
    summarySource: row.summary_source,
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
    putAwayAt: fromMs(row.put_away_at),
    tidyKeptAt: fromMs(row.tidy_kept_at),
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
