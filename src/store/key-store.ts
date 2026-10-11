import type { Database } from "better-sqlite3";
import type { OwnerId } from "../core/types.js";
import { SqliteStore } from "./sqlite-store.js";

export class KeyStoreError extends Error {
  constructor(
    readonly code: "key_exists",
    message: string,
  ) {
    super(message);
    this.name = "KeyStoreError";
  }
}

/** What may be shown about a key: never its hash. */
export type KeyInfo = { name: string; createdAt: Date; revokedAt: Date | null };

/** Agent-key persistence. Every call except `findLiveByHash` takes the owner. */
export class SqliteKeyStore {
  constructor(private readonly db: Database) {}

  /** Ensures the owner and stores the key's hash in one transaction; one live key per agent. */
  create(owner: OwnerId, ownerName: string, agent: string, hash: string, now: Date): void {
    this.db
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
            `Agent "${agent}" already has a live key; revoke it first.`,
          );
        }
        this.db
          .prepare("INSERT INTO agent_keys (owner_id, name, hash, created_at) VALUES (?, ?, ?, ?)")
          .run(owner, agent, hash, now.getTime());
      })
      .immediate();
  }

  list(owner: OwnerId): KeyInfo[] {
    const rows = this.db
      .prepare("SELECT name, created_at, revoked_at FROM agent_keys WHERE owner_id = ? ORDER BY id")
      .all(owner) as { name: string; created_at: number; revoked_at: number | null }[];
    return rows.map((r) => ({
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

  /** The one lookup that is not owner-scoped: it is how a request finds its owner. */
  findLiveByHash(hash: string): { owner: OwnerId; name: string } | null {
    const row = this.db
      .prepare("SELECT owner_id, name FROM agent_keys WHERE hash = ? AND revoked_at IS NULL")
      .get(hash) as { owner_id: string; name: string } | undefined;
    return row ? { owner: row.owner_id, name: row.name } : null;
  }
}
