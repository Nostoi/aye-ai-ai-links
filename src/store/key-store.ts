import type { Database } from "better-sqlite3";
import type { OwnerId } from "../core/types.js";
import { SqliteStore } from "./sqlite-store.js";

export class KeyStoreError extends Error {
  constructor(
    readonly code: "key_exists" | "name_taken",
    message: string,
  ) {
    super(message);
    this.name = "KeyStoreError";
  }
}

/** What may be shown about a key: never its hash. */
export type KeyInfo = { id: number; name: string; createdAt: Date; revokedAt: Date | null };

/** Agent-key persistence. Every call except `findLiveByHash` takes the owner. */
export class SqliteKeyStore {
  constructor(private readonly db: Database) {}

  /**
   * Ensures the owner and stores the key's hash in one transaction; one live key per agent.
   * Returns the new key's id.
   */
  create(owner: OwnerId, ownerName: string, agent: string, hash: string, now: Date): number {
    return this.db
      .transaction(() => {
        new SqliteStore(this.db).ensureUser(owner, ownerName);
        const live = this.db
          .prepare(
            "SELECT 1 FROM agent_keys WHERE owner_id = ? AND name = ? AND revoked_at IS NULL",
          )
          .get(owner, agent);
        if (live) {
          throw new KeyStoreError(
            "key_exists",
            `Agent "${agent}" already has a live key; turn it off first.`,
          );
        }
        const inserted = this.db
          .prepare("INSERT INTO agent_keys (owner_id, name, hash, created_at) VALUES (?, ?, ?, ?)")
          .run(owner, agent, hash, now.getTime());
        return Number(inserted.lastInsertRowid);
      })
      .immediate();
  }

  list(owner: OwnerId): KeyInfo[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, created_at, revoked_at FROM agent_keys WHERE owner_id = ? ORDER BY id",
      )
      .all(owner) as { id: number; name: string; created_at: number; revoked_at: number | null }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: new Date(r.created_at),
      revokedAt: r.revoked_at === null ? null : new Date(r.revoked_at),
    }));
  }

  /** True when a live key was revoked; false when the agent had none. */
  revoke(owner: OwnerId, agent: string, now: Date): boolean {
    const result = this.db
      .prepare(
        "UPDATE agent_keys SET revoked_at = ? WHERE owner_id = ? AND name = ? AND revoked_at IS NULL",
      )
      .run(now.getTime(), owner, agent);
    return result.changes > 0;
  }

  /** True when the owner's key `id` was live and is now revoked. */
  revokeById(owner: OwnerId, id: number, now: Date): boolean {
    const result = this.db
      .prepare(
        "UPDATE agent_keys SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
      )
      .run(now.getTime(), owner, id);
    return result.changes > 0;
  }

  /**
   * Makes the owner's key `id` live again if it was revoked at or after `since`. True when it
   * was. The live-name index refuses it when a key with its name was made since: `name_taken`.
   */
  restore(owner: OwnerId, id: number, since: Date): boolean {
    try {
      const result = this.db
        .prepare(
          "UPDATE agent_keys SET revoked_at = NULL WHERE owner_id = ? AND id = ? AND revoked_at >= ?",
        )
        .run(owner, id, since.getTime());
      return result.changes > 0;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "SQLITE_CONSTRAINT_UNIQUE") throw error;
      const { name } = this.db
        .prepare("SELECT name FROM agent_keys WHERE owner_id = ? AND id = ?")
        .get(owner, id) as { name: string };
      throw new KeyStoreError(
        "name_taken",
        `A new key for "${name}" was made since, so this one stays off.`,
      );
    }
  }

  /** The one lookup that is not owner-scoped: it is how a request finds its owner. */
  findLiveByHash(hash: string): { owner: OwnerId; name: string } | null {
    const row = this.db
      .prepare("SELECT owner_id, name FROM agent_keys WHERE hash = ? AND revoked_at IS NULL")
      .get(hash) as { owner_id: string; name: string } | undefined;
    return row ? { owner: row.owner_id, name: row.name } : null;
  }
}
