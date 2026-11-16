import type { Database } from "better-sqlite3";
import type { OpenCodeStore, Opener } from "../core/open-codes.js";
import type { OwnerId } from "../core/types.js";
import { parseId } from "./sql-values.js";

/** `link_open_codes` (#133). A deleted link's codes resolve to nothing; its purge deletes them. */
export class SqliteOpenCodes implements OpenCodeStore {
  constructor(private readonly db: Database) {}

  /** One transaction: each insert keeps a code already stored, then the stored code is read. */
  async codesFor(
    owner: OwnerId,
    agent: string,
    linkIds: string[],
    newCode: () => string,
    at: Date,
  ): Promise<Map<string, string>> {
    const insert = this.db.prepare(
      `INSERT INTO link_open_codes (owner_id, link_id, agent, code, created_at)
       SELECT owner_id, id, ?, ?, ? FROM links
       WHERE owner_id = ? AND id = ? AND deleted_at IS NULL
       ON CONFLICT (owner_id, link_id, agent) DO NOTHING`,
    );
    const read = this.db
      .prepare(
        `SELECT c.code FROM link_open_codes c
         JOIN links l ON l.owner_id = c.owner_id AND l.id = c.link_id AND l.deleted_at IS NULL
         WHERE c.owner_id = ? AND c.link_id = ? AND c.agent = ?`,
      )
      .pluck();
    return this.db
      .transaction(() => {
        const codes = new Map<string, string>();
        for (const id of linkIds) {
          const linkId = parseId(id);
          if (linkId === null) continue;
          insert.run(agent, newCode(), at.getTime(), owner, linkId);
          const code = read.get(owner, linkId, agent) as string | undefined;
          if (code !== undefined) codes.set(id, code);
        }
        return codes;
      })
      .immediate();
  }

  /**
   * The one read not scoped by an owner: the code is the credential. Only `src/auth/open-code.ts`
   * calls it. Null for an unknown code, or one whose link is deleted.
   */
  findByCode(code: string): Opener | null {
    const row = this.db
      .prepare(
        `SELECT c.owner_id AS owner, c.link_id AS linkId, c.agent FROM link_open_codes c
         JOIN links l ON l.owner_id = c.owner_id AND l.id = c.link_id AND l.deleted_at IS NULL
         WHERE c.code = ?`,
      )
      .get(code) as { owner: string; linkId: number; agent: string } | undefined;
    return row ? { owner: row.owner, linkId: String(row.linkId), agent: row.agent } : null;
  }
}
