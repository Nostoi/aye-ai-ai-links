import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { type Changed, type Covered, holdsWritten } from "../core/covered-fields.js";
import type { LinkTag, OwnerId, Source } from "../core/types.js";

/** A link's tags joined to the catalog; `WHERE` and `ORDER BY` are the caller's. */
export const TAG_SELECT = `SELECT lt.link_id AS linkId, t.key AS key, t.name AS name, lt.source AS source,
    t.kind AS kind, t.kind_source AS kindSource
  FROM link_tags lt JOIN tags t ON t.id = lt.tag_id AND t.owner_id = lt.owner_id`;

/** The `link_edits` columns a receipt reads back. */
export type ReceiptRow = {
  edit_id: string;
  title_changed: number;
  summary_changed: number;
  why_changed: number;
  tags_changed: number;
  prior_title: string | null;
  written_title: string | null;
  prior_summary: string | null;
  written_summary: string | null;
  prior_why_text: string | null;
  prior_why_source: Source | null;
  written_why_text: string | null;
  written_why_source: Source | null;
  prior_tags: string | null;
  written_tags: string | null;
};

const why = (text: string | null, source: Source | null) =>
  text === null || source === null ? null : { text, source };

/** The covered values of a live link of the owner, or null when it is absent or hidden. */
export function readCovered(db: Database, owner: OwnerId, linkId: number): Covered | null {
  const row = db
    .prepare(
      `SELECT title, summary, why_text, why_source FROM links
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .get(owner, linkId) as
    | {
        title: string | null;
        summary: string | null;
        why_text: string | null;
        why_source: Source | null;
      }
    | undefined;
  if (!row) return null;
  const tags = db
    .prepare(`${TAG_SELECT} WHERE lt.link_id = ? AND lt.owner_id = ? ORDER BY lt.position`)
    .all(linkId, owner) as (LinkTag & { linkId: number })[];
  return {
    title: row.title,
    summary: row.summary,
    why: why(row.why_text, row.why_source),
    tags: tags.map(({ key, name, source, kind, kindSource }) => ({
      key,
      name,
      source,
      kind,
      kindSource,
    })),
  };
}

/** Adds each tag to the catalog if it is new, then attaches it in this order with this source. */
export function attachTags(db: Database, owner: OwnerId, linkId: number, tags: LinkTag[]): void {
  const create = db.prepare(
    `INSERT INTO tags (owner_id, key, name, kind, kind_source, pinned) VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT (owner_id, key) DO NOTHING`,
  );
  const attach = db.prepare(
    `INSERT INTO link_tags (owner_id, link_id, tag_id, source, position)
     SELECT ?, ?, id, ?, ? FROM tags WHERE owner_id = ? AND key = ?`,
  );
  tags.forEach((t, position) => {
    create.run(owner, t.key, t.name, t.kind, t.kindSource);
    attach.run(owner, linkId, t.source, position, owner, t.key);
  });
}

/** Replaces the link's receipt with what `before` held and `after` holds in the changed fields. Returns its edit id. */
export function writeReceipt(
  db: Database,
  owner: OwnerId,
  linkId: number,
  changed: Changed,
  before: Covered,
  after: Covered,
  at: Date,
): string {
  const editId = randomUUID();
  db.prepare(
    `INSERT OR REPLACE INTO link_edits (owner_id, link_id, edit_id, title_changed, picture_changed,
       prior_title, written_title, summary_changed, prior_summary, written_summary, why_changed,
       prior_why_text, prior_why_source, written_why_text, written_why_source, tags_changed,
       prior_tags, written_tags, at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    owner,
    linkId,
    editId,
    changed.title ? 1 : 0,
    changed.title ? before.title : null,
    changed.title ? after.title : null,
    changed.summary ? 1 : 0,
    changed.summary ? before.summary : null,
    changed.summary ? after.summary : null,
    changed.why ? 1 : 0,
    changed.why ? (before.why?.text ?? null) : null,
    changed.why ? (before.why?.source ?? null) : null,
    changed.why ? (after.why?.text ?? null) : null,
    changed.why ? (after.why?.source ?? null) : null,
    changed.tags ? 1 : 0,
    changed.tags ? JSON.stringify(before.tags) : null,
    changed.tags ? JSON.stringify(after.tags) : null,
    at.getTime(),
  );
  return editId;
}

const flagged = (row: ReceiptRow): Changed => ({
  title: row.title_changed === 1,
  summary: row.summary_changed === 1,
  why: row.why_changed === 1,
  tags: row.tags_changed === 1,
});

/** True while the link still holds what the receipt wrote, in every field the receipt changed. */
export function receiptHolds(row: ReceiptRow, current: Covered): boolean {
  return holdsWritten(
    flagged(row),
    {
      title: row.written_title,
      summary: row.written_summary,
      why: why(row.written_why_text, row.written_why_source),
      tags: JSON.parse(row.written_tags ?? "[]") as LinkTag[],
    },
    current,
  );
}

/**
 * Puts back the summary, why and tags the receipt replaced. The title is the caller's. Tags are
 * re-attached through `attachTags`: a catalog row that exists keeps its kind, and none is deleted.
 */
export function restoreCovered(db: Database, owner: OwnerId, linkId: number, row: ReceiptRow) {
  const changed = flagged(row);
  if (changed.summary) {
    db.prepare("UPDATE links SET summary = ? WHERE owner_id = ? AND id = ?").run(
      row.prior_summary,
      owner,
      linkId,
    );
  }
  if (changed.why) {
    db.prepare("UPDATE links SET why_text = ?, why_source = ? WHERE owner_id = ? AND id = ?").run(
      row.prior_why_text,
      row.prior_why_source,
      owner,
      linkId,
    );
  }
  if (changed.tags) {
    db.prepare("DELETE FROM link_tags WHERE link_id = ? AND owner_id = ?").run(linkId, owner);
    attachTags(db, owner, linkId, JSON.parse(row.prior_tags ?? "[]") as LinkTag[]);
  }
}
