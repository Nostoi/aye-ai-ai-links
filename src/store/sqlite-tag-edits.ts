import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { receiptsMeet, type TagEditStore, type TagSettings } from "../core/tag-edit-store.js";
import { strongerSource } from "../core/tags.js";
import type { OwnerId, Source, Tag } from "../core/types.js";
import { TAG_COLUMNS } from "./sqlite-store.js";

type TagRow = Omit<Tag, "pinned"> & { id: number; pinned: number };
type Mark = { key: string; source: Source; position: number };

/** What `tag_changes.receipt` holds: enough to check and put back a merge or delete exactly. */
type Receipt = {
  removed: Tag;
  /** The old keys that reached the removed tag, leaving out any a live tag shadowed. */
  aliases: string[];
  /** A delete's: the live key the removed key's own old address reached then, if any. */
  address?: string | null;
  /** A merge's kept tag: its key, settings before and after, and every link with it afterwards. */
  kept?: { key: string; before: TagSettings; after: TagSettings; links: number[] };
  /** Each link the removed tag was on, hidden included, with its ordered tags before and after. */
  links: { id: number; before: Mark[]; after: Mark[] }[];
};

const toTag = ({ id: _, pinned, ...rest }: TagRow): Tag => ({ ...rest, pinned: pinned === 1 });

const settingsOf = (t: Tag): TagSettings => ({
  kind: t.kind,
  kindSource: t.kindSource,
  color: t.color,
  pinned: t.pinned,
  description: t.description,
  projectStatus: t.projectStatus,
});

const sameSettings = (a: TagSettings, b: TagSettings) =>
  a.kind === b.kind &&
  a.kindSource === b.kindSource &&
  a.color === b.color &&
  a.pinned === b.pinned &&
  a.description === b.description &&
  a.projectStatus === b.projectStatus;

const sameTag = (a: Tag, b: Tag) => a.key === b.key && a.name === b.name && sameSettings(a, b);

const sameMarks = (a: Mark[], b: Mark[]) =>
  a.length === b.length && a.every((m, i) => m.key === b[i]?.key && m.source === b[i]?.source);

/** The owner's tag renames, merges and deletes (`tag_aliases`, `tag_changes`) and their Undo. */
export class SqliteTagEditStore implements TagEditStore {
  constructor(private readonly db: Database) {}

  async tagLinkCounts(owner: OwnerId) {
    const rows = this.db
      .prepare(
        `SELECT t.key AS key, count(*) AS n FROM link_tags lt
         JOIN tags t ON t.id = lt.tag_id AND t.owner_id = lt.owner_id
         JOIN links l ON l.id = lt.link_id AND l.owner_id = lt.owner_id
         WHERE lt.owner_id = ? AND l.deleted_at IS NULL GROUP BY t.key`,
      )
      .all(owner) as { key: string; n: number }[];
    return new Map(rows.map((r) => [r.key, r.n]));
  }

  async renameTag(owner: OwnerId, key: string, name: string, newKey: string) {
    return this.db
      .transaction((): Tag | "taken" | null => {
        const row = this.tagRow(owner, key);
        if (!row) return null;
        if (newKey !== key && this.tagRow(owner, newKey)) return "taken";
        this.db
          .prepare("UPDATE tags SET name = ?, key = ? WHERE owner_id = ? AND id = ?")
          .run(name, newKey, owner, row.id);
        if (newKey !== key) {
          this.setAlias(owner, key, row.id);
          this.cancelLinkEdits(owner, key);
        }
        return toTag(this.mustTag(owner, newKey));
      })
      .immediate();
  }

  async mergeTag(
    owner: OwnerId,
    m: { from: Tag; into: Tag; set: TagSettings; at: Date; pruneBefore: Date },
  ) {
    if (m.from.key === m.into.key) throw new Error("A tag cannot be merged into itself.");
    return this.db
      .transaction(() => {
        this.prune(owner, m.pruneBefore);
        const from = this.tagRow(owner, m.from.key);
        const into = this.tagRow(owner, m.into.key);
        if (!from || !into) return null;
        if (!sameTag(toTag(from), m.from) || !sameTag(toTag(into), m.into)) return "conflict";
        const moved = this.liveCount(owner, from.id);
        const linkIds = this.linksWith(owner, from.id);
        const before = linkIds.map((id) => this.marks(owner, id));
        const aliases = this.reachingAliases(owner, from.id);
        const both = this.db
          .prepare(
            `SELECT o.link_id AS linkId, o.source AS old, k.source AS kept FROM link_tags o
             JOIN link_tags k ON k.owner_id = o.owner_id AND k.link_id = o.link_id AND k.tag_id = ?
             WHERE o.owner_id = ? AND o.tag_id = ?`,
          )
          .all(into.id, owner, from.id) as { linkId: number; old: Source; kept: Source }[];
        for (const b of both) {
          this.db
            .prepare("DELETE FROM link_tags WHERE owner_id = ? AND link_id = ? AND tag_id = ?")
            .run(owner, b.linkId, from.id);
          this.db
            .prepare(
              "UPDATE link_tags SET source = ? WHERE owner_id = ? AND link_id = ? AND tag_id = ?",
            )
            .run(strongerSource(b.kept, b.old), owner, b.linkId, into.id);
        }
        this.db
          .prepare("UPDATE link_tags SET tag_id = ? WHERE owner_id = ? AND tag_id = ?")
          .run(into.id, owner, from.id);
        this.db
          .prepare("UPDATE tag_aliases SET tag_id = ? WHERE owner_id = ? AND tag_id = ?")
          .run(into.id, owner, from.id);
        this.cancelLinkEdits(owner, from.key);
        this.db.prepare("DELETE FROM tags WHERE owner_id = ? AND id = ?").run(owner, from.id);
        this.setAlias(owner, from.key, into.id);
        this.writeSettings(owner, into.id, m.set);
        const kept = toTag(this.mustTag(owner, into.key));
        const changeId = this.writeReceipt(owner, "merge", m.at, {
          removed: toTag(from),
          aliases,
          kept: {
            key: into.key,
            before: settingsOf(toTag(into)),
            after: settingsOf(kept),
            links: this.linksWith(owner, into.id),
          },
          links: linkIds.map((id, i) => ({
            id,
            before: before[i] ?? [],
            after: this.marks(owner, id),
          })),
        });
        return { tag: kept, changeId, moved, links: this.liveCount(owner, into.id) };
      })
      .immediate();
  }

  async deleteTag(owner: OwnerId, d: { tag: Tag; at: Date; pruneBefore: Date }) {
    return this.db
      .transaction(() => {
        this.prune(owner, d.pruneBefore);
        const row = this.tagRow(owner, d.tag.key);
        if (!row) return null;
        if (!sameTag(toTag(row), d.tag)) return "conflict";
        const moved = this.liveCount(owner, row.id);
        const linkIds = this.linksWith(owner, row.id);
        const before = linkIds.map((id) => this.marks(owner, id));
        const aliases = this.reachingAliases(owner, row.id);
        const address = this.addressOf(owner, row.key);
        this.db
          .prepare("DELETE FROM link_tags WHERE owner_id = ? AND tag_id = ?")
          .run(owner, row.id);
        this.cancelLinkEdits(owner, row.key);
        this.db.prepare("DELETE FROM tags WHERE owner_id = ? AND id = ?").run(owner, row.id);
        const changeId = this.writeReceipt(owner, "delete", d.at, {
          removed: toTag(row),
          aliases,
          address,
          links: linkIds.map((id, i) => ({
            id,
            before: before[i] ?? [],
            after: this.marks(owner, id),
          })),
        });
        return { changeId, moved };
      })
      .immediate();
  }

  async undoTagChange(owner: OwnerId, changeId: string, since: Date) {
    return this.db
      .transaction((): { tags: { tag: Tag; links: number }[] } | "conflict" | "blocked" | null => {
        const found = this.db
          .prepare(
            "SELECT receipt FROM tag_changes WHERE owner_id = ? AND change_id = ? AND at >= ?",
          )
          .get(owner, changeId, since.getTime()) as { receipt: string } | undefined;
        if (!found) return null;
        const r = JSON.parse(found.receipt) as Receipt;
        if (!this.unchangedSince(owner, r)) return "conflict";
        if (this.newerReceiptMeets(owner, changeId, since, r)) return "blocked";
        const kept = r.kept && this.mustTag(owner, r.kept.key);
        const links = r.links.filter((l) => this.linkExists(owner, l.id));

        const t = r.removed;
        const restoredId = Number(
          this.db
            .prepare(
              `INSERT INTO tags (owner_id, key, name, kind, kind_source, color, pinned, description,
                 project_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              owner,
              t.key,
              t.name,
              t.kind,
              t.kindSource,
              t.color,
              t.pinned ? 1 : 0,
              t.description,
              t.projectStatus,
            ).lastInsertRowid,
        );
        for (const key of r.aliases) this.setAlias(owner, key, restoredId);
        if (r.kept && kept) {
          this.db
            .prepare("DELETE FROM tag_aliases WHERE owner_id = ? AND old_key = ?")
            .run(owner, t.key);
          this.writeSettings(owner, kept.id, r.kept.before);
        }
        const attach = this.db.prepare(
          `INSERT INTO link_tags (owner_id, link_id, tag_id, source, position)
           SELECT ?, ?, id, ?, ? FROM tags WHERE owner_id = ? AND key = ?`,
        );
        for (const l of links) {
          this.db
            .prepare("DELETE FROM link_tags WHERE owner_id = ? AND link_id = ?")
            .run(owner, l.id);
          for (const mark of l.before) {
            const { changes } = attach.run(
              owner,
              l.id,
              mark.source,
              mark.position,
              owner,
              mark.key,
            );
            if (changes !== 1) throw new Error(`Undo found no tag ${mark.key} to put back.`);
          }
        }
        this.db
          .prepare("DELETE FROM tag_changes WHERE owner_id = ? AND change_id = ?")
          .run(owner, changeId);
        const restored = [
          this.mustTag(owner, t.key),
          ...(r.kept ? [this.mustTag(owner, r.kept.key)] : []),
        ];
        return {
          tags: restored.map((row) => ({ tag: toTag(row), links: this.liveCount(owner, row.id) })),
        };
      })
      .immediate();
  }

  async currentKey(owner: OwnerId, key: string) {
    if (this.tagRow(owner, key)) return key;
    const row = this.db
      .prepare(
        `SELECT t.key AS key FROM tag_aliases a JOIN tags t ON t.id = a.tag_id AND t.owner_id = a.owner_id
         WHERE a.owner_id = ? AND a.old_key = ?`,
      )
      .get(owner, key) as { key: string } | undefined;
    return row?.key ?? null;
  }

  private tagRow(owner: OwnerId, key: string): TagRow | undefined {
    return this.db
      .prepare(`SELECT id, ${TAG_COLUMNS} FROM tags WHERE owner_id = ? AND key = ?`)
      .get(owner, key) as TagRow | undefined;
  }

  private mustTag(owner: OwnerId, key: string): TagRow {
    const row = this.tagRow(owner, key);
    if (!row) throw new Error(`Tag ${key} vanished inside its own transaction.`);
    return row;
  }

  private writeSettings(owner: OwnerId, id: number, s: TagSettings): void {
    this.db
      .prepare(
        `UPDATE tags SET kind = ?, kind_source = ?, color = ?, pinned = ?, description = ?,
           project_status = ? WHERE owner_id = ? AND id = ?`,
      )
      .run(
        s.kind,
        s.kindSource,
        s.color,
        s.pinned ? 1 : 0,
        s.description,
        s.projectStatus,
        owner,
        id,
      );
  }

  /** Live links with the tag, every state. */
  private liveCount(owner: OwnerId, tagId: number): number {
    return this.db
      .prepare(
        `SELECT count(*) FROM link_tags lt JOIN links l ON l.id = lt.link_id AND l.owner_id = lt.owner_id
         WHERE lt.owner_id = ? AND lt.tag_id = ? AND l.deleted_at IS NULL`,
      )
      .pluck()
      .get(owner, tagId) as number;
  }

  /** Every link with the tag, hidden included, by id. */
  private linksWith(owner: OwnerId, tagId: number): number[] {
    return this.db
      .prepare("SELECT link_id FROM link_tags WHERE owner_id = ? AND tag_id = ? ORDER BY link_id")
      .pluck()
      .all(owner, tagId) as number[];
  }

  /** The link's ordered tags, hidden or not. */
  private marks(owner: OwnerId, linkId: number): Mark[] {
    return this.db
      .prepare(
        `SELECT t.key AS key, lt.source AS source, lt.position AS position FROM link_tags lt
         JOIN tags t ON t.id = lt.tag_id AND t.owner_id = lt.owner_id
         WHERE lt.owner_id = ? AND lt.link_id = ? ORDER BY lt.position`,
      )
      .all(owner, linkId) as Mark[];
  }

  private linkExists(owner: OwnerId, linkId: number): boolean {
    return (
      this.db.prepare("SELECT 1 FROM links WHERE owner_id = ? AND id = ?").get(owner, linkId) !==
      undefined
    );
  }

  /** The old keys that reach the tag: its aliases that no live tag shadows. */
  private reachingAliases(owner: OwnerId, tagId: number): string[] {
    return this.db
      .prepare(
        `SELECT old_key FROM tag_aliases a WHERE owner_id = ? AND tag_id = ?
           AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.owner_id = a.owner_id AND t.key = a.old_key)
         ORDER BY old_key`,
      )
      .pluck()
      .all(owner, tagId) as string[];
  }

  private aliasOf(owner: OwnerId, key: string): number | null {
    const id = this.db
      .prepare("SELECT tag_id FROM tag_aliases WHERE owner_id = ? AND old_key = ?")
      .pluck()
      .get(owner, key) as number | undefined;
    return id ?? null;
  }

  /** The live key the old key's alias reaches, or null. */
  private addressOf(owner: OwnerId, key: string): string | null {
    const found = this.db
      .prepare(
        `SELECT t.key FROM tag_aliases a JOIN tags t ON t.id = a.tag_id AND t.owner_id = a.owner_id
         WHERE a.owner_id = ? AND a.old_key = ?`,
      )
      .pluck()
      .get(owner, key) as string | undefined;
    return found ?? null;
  }

  /** Whether everything the receipt's Undo would put back is still as the change left it. */
  private unchangedSince(owner: OwnerId, r: Receipt): boolean {
    if (this.tagRow(owner, r.removed.key)) return false;
    if (!r.kept && this.addressOf(owner, r.removed.key) !== (r.address ?? null)) return false;
    const kept = r.kept && this.tagRow(owner, r.kept.key);
    if (r.kept) {
      if (!kept || !sameSettings(toTag(kept), r.kept.after)) return false;
      const recorded = r.kept.links.filter((id) => this.linkExists(owner, id));
      const now = this.linksWith(owner, kept.id);
      if (recorded.length !== now.length || recorded.some((id) => !now.includes(id))) return false;
      if (this.aliasOf(owner, r.removed.key) !== kept.id) return false;
    }
    const links = r.links.filter((l) => this.linkExists(owner, l.id));
    if (links.some((l) => !sameMarks(this.marks(owner, l.id), l.after))) return false;
    return r.aliases.every(
      (key) => !this.tagRow(owner, key) && this.aliasOf(owner, key) === (kept ? kept.id : null),
    );
  }

  /** Whether a newer receipt still in its window, and itself unchanged since, shares a key or link with it. */
  private newerReceiptMeets(owner: OwnerId, changeId: string, since: Date, r: Receipt): boolean {
    const newer = this.db
      .prepare(
        `SELECT receipt FROM tag_changes WHERE owner_id = ? AND at >= ?
           AND rowid > (SELECT rowid FROM tag_changes WHERE owner_id = ? AND change_id = ?)`,
      )
      .pluck()
      .all(owner, since.getTime(), owner, changeId) as string[];
    return newer.some((json) => {
      const n = JSON.parse(json) as Receipt;
      return receiptsMeet(r, n) && this.unchangedSince(owner, n);
    });
  }

  private setAlias(owner: OwnerId, key: string, tagId: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO tag_aliases (owner_id, old_key, tag_id) VALUES (?, ?, ?)")
      .run(owner, key, tagId);
  }

  /** Removes the owner's link-edit receipts whose tags, before or after, name `key`. */
  private cancelLinkEdits(owner: OwnerId, key: string): void {
    const names = (column: string) =>
      `EXISTS (SELECT 1 FROM json_each(coalesce(${column}, '[]')) WHERE json_extract(value, '$.key') = ?)`;
    this.db
      .prepare(
        `DELETE FROM link_edits WHERE owner_id = ? AND tags_changed = 1
           AND (${names("prior_tags")} OR ${names("written_tags")})`,
      )
      .run(owner, key, key);
  }

  private prune(owner: OwnerId, before: Date): void {
    this.db
      .prepare("DELETE FROM tag_changes WHERE owner_id = ? AND at < ?")
      .run(owner, before.getTime());
  }

  private writeReceipt(owner: OwnerId, action: "merge" | "delete", at: Date, r: Receipt): string {
    const changeId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tag_changes (owner_id, change_id, action, at, receipt) VALUES (?, ?, ?, ?, ?)",
      )
      .run(owner, changeId, action, at.getTime(), JSON.stringify(r));
    return changeId;
  }
}
