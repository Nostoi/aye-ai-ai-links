import type { Database } from "better-sqlite3";
import {
  type CheckCutoffs,
  type CheckResult,
  type CheckWrite,
  type DueCheck,
  type LinkCheck,
  type LinkCheckStore,
  sameCheck,
} from "../core/link-check-store.js";
import type { OwnerId } from "../core/types.js";
import { fromMs, parseId, toMs } from "./sqlite-store.js";

type CheckRow = {
  link_id: number;
  checked_at: number;
  result: CheckResult;
  detail: string | null;
  first_dead_at: number | null;
  flagged_at: number | null;
  still_works_at: number | null;
};

const CHECK_SELECT = `SELECT link_id, checked_at, result, detail, first_dead_at, flagged_at,
  still_works_at FROM link_checks`;

function toCheck(r: CheckRow): LinkCheck {
  return {
    checkedAt: new Date(r.checked_at),
    result: r.result,
    detail: r.detail,
    firstDeadAt: fromMs(r.first_dead_at),
    flaggedAt: fromMs(r.flagged_at),
    stillWorksAt: fromMs(r.still_works_at),
  };
}

/** Dead-link check rows (`link_checks`, #128). */
export class SqliteLinkCheckStore implements LinkCheckStore {
  constructor(private readonly db: Database) {}

  async dueChecks(cutoffs: CheckCutoffs, limit: number): Promise<DueCheck[]> {
    const rows = this.db
      .prepare(
        `SELECT l.owner_id, l.id, l.url FROM links l
         LEFT JOIN link_checks c ON c.owner_id = l.owner_id AND c.link_id = l.id
         WHERE l.deleted_at IS NULL
           AND coalesce(c.checked_at, l.saved_at) <= CASE l.state WHEN 'active' THEN ? ELSE ? END
         ORDER BY coalesce(c.checked_at, l.saved_at), l.id LIMIT ?`,
      )
      .all(toMs(cutoffs.active), toMs(cutoffs.archived), limit) as {
      owner_id: string;
      id: number;
      url: string;
    }[];
    return rows.map((r) => ({ owner: r.owner_id, linkId: String(r.id), url: r.url }));
  }

  async getCheck(owner: OwnerId, linkId: string) {
    const n = parseId(linkId);
    return n === null ? null : this.read(owner, n);
  }

  async listChecks(owner: OwnerId) {
    const rows = this.db
      .prepare(`${CHECK_SELECT} WHERE owner_id = ? ORDER BY link_id`)
      .all(owner) as CheckRow[];
    return new Map<string, LinkCheck>(rows.map((r) => [String(r.link_id), toCheck(r)]));
  }

  async updateCheckIf(
    owner: OwnerId,
    linkId: string,
    expected: LinkCheck | null,
    next: LinkCheck,
  ): Promise<CheckWrite | null> {
    const n = parseId(linkId);
    if (n === null) return null;
    return this.db
      .transaction((): CheckWrite | null => {
        const link = this.db
          .prepare("SELECT 1 FROM links WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
          .get(n, owner);
        if (!link) return null;
        const current = this.read(owner, n);
        if (!sameCheck(current, expected)) return { check: current, applied: false };
        this.db
          .prepare(
            `INSERT INTO link_checks (owner_id, link_id, checked_at, result, detail, first_dead_at,
               flagged_at, still_works_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (owner_id, link_id) DO UPDATE SET checked_at = excluded.checked_at,
               result = excluded.result, detail = excluded.detail,
               first_dead_at = excluded.first_dead_at, flagged_at = excluded.flagged_at,
               still_works_at = excluded.still_works_at`,
          )
          .run(
            owner,
            n,
            toMs(next.checkedAt),
            next.result,
            next.detail,
            toMs(next.firstDeadAt),
            toMs(next.flaggedAt),
            toMs(next.stillWorksAt),
          );
        return { check: this.read(owner, n), applied: true };
      })
      .immediate();
  }

  private read(owner: OwnerId, n: number): LinkCheck | null {
    const row = this.db
      .prepare(`${CHECK_SELECT} WHERE owner_id = ? AND link_id = ?`)
      .get(owner, n) as CheckRow | undefined;
    return row ? toCheck(row) : null;
  }
}
