import type { Database } from "better-sqlite3";
import type { LinkStore } from "../core/store.js";
import type {
  Labelled,
  Link,
  LinkPatch,
  LinkTag,
  NewLink,
  OwnerId,
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

function toMs(d: Date | null): number | null {
  if (d === null) return null;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("Cannot store an invalid date.");
  return ms;
}

const fromMs = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/** Canonical decimal ids in 1..MAX_SAFE_INTEGER; anything else was never issued. */
function parseId(id: string): number | null {
  if (!/^[1-9][0-9]*$/.test(id)) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : null;
}

export class SqliteStore implements LinkStore {
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
      .prepare(
        `SELECT key, name, kind, color, pinned, description, project_status AS projectStatus
         FROM tags WHERE owner_id = ? ORDER BY key`,
      )
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
    if (patch.projectStatus !== undefined) {
      sets.push("project_status = ?");
      values.push(patch.projectStatus);
    }
    if (sets.length === 0) sets.push("key = key");
    const row = this.db
      .prepare(
        `UPDATE tags SET ${sets.join(", ")} WHERE owner_id = ? AND key = ? AND kind = ?
         RETURNING key, name, kind, color, pinned, description, project_status AS projectStatus`,
      )
      .get(...values, owner, key, expectedKind) as TagRow | undefined;
    return row ? { ...row, pinned: row.pinned === 1 } : null;
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
      this.attachTags(owner, row.id, link.tags);
      return { link: this.mustRead(owner, row.id), created: true };
    }
    const existing = this.db
      .prepare("SELECT id FROM links WHERE owner_id = ? AND url_key = ?")
      .get(owner, link.urlKey) as { id: number };
    return { link: this.mustRead(owner, existing.id), created: false };
  }

  private updateSync(owner: OwnerId, id: number, patch: LinkPatch): Link | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.summary !== undefined) set("summary", patch.summary);
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.snoozedUntil !== undefined) set("snoozed_until", toMs(patch.snoozedUntil));
    if (patch.lastOpenedAt !== undefined) set("last_opened_at", toMs(patch.lastOpenedAt));
    if (patch.why !== undefined) {
      set("why_text", patch.why?.text ?? null);
      set("why_source", patch.why?.source ?? null);
    }
    if (sets.length === 0) sets.push("id = id");
    const matched = this.db
      .prepare(`UPDATE links SET ${sets.join(", ")} WHERE id = ? AND owner_id = ? RETURNING id`)
      .get(...values, id, owner);
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

  private attachTags(owner: OwnerId, linkId: number, tags: LinkTag[]): void {
    const create = this.db.prepare(
      `INSERT INTO tags (owner_id, key, name, kind, pinned) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (owner_id, key) DO NOTHING`,
    );
    const attach = this.db.prepare(
      `INSERT INTO link_tags (owner_id, link_id, tag_id, source, position)
       SELECT ?, ?, id, ?, ? FROM tags WHERE owner_id = ? AND key = ?`,
    );
    tags.forEach((t, position) => {
      create.run(owner, t.key, t.name, t.kind);
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
      .prepare(
        `SELECT t.key AS key, t.name AS name, lt.source AS source, t.kind AS kind
         FROM link_tags lt JOIN tags t ON t.id = lt.tag_id AND t.owner_id = lt.owner_id
         WHERE lt.link_id = ? AND lt.owner_id = ? ORDER BY lt.position`,
      )
      .all(id, owner) as LinkTag[];
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
    };
  }
}
