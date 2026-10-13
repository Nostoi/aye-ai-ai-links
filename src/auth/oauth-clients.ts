import type Database from "better-sqlite3";

/**
 * Plain reads and one startup delete over better-auth's OAuth tables. They depend on its schema,
 * so their tests re-run on every better-auth upgrade. A client is connected when it has an
 * `oauthClient` row and an `oauthConsent` row.
 */
export function oauthClients(db: Database.Database) {
  const connected = db.prepare<[], { clientId: string }>(
    `SELECT DISTINCT c.clientId FROM oauthClient c JOIN oauthConsent k ON k.clientId = c.clientId
     WHERE c.clientDiscoveryId = 'cimd'`,
  );
  const one = db.prepare<[string], { n: number }>(
    `SELECT count(*) AS n FROM oauthClient c JOIN oauthConsent k ON k.clientId = c.clientId
     WHERE c.clientId = ?`,
  );
  const name = db.prepare<[string], { name: string | null }>(
    "SELECT name FROM oauthClient WHERE clientId = ?",
  );
  const prune = db.prepare<[string, string]>(
    `DELETE FROM oauthClient
     WHERE clientDiscoveryId IS NULL AND clientId != ? AND createdAt < ?
       AND NOT EXISTS (SELECT 1 FROM oauthConsent k WHERE k.clientId = oauthClient.clientId)`,
  );
  return {
    /** The CIMD clients the stash keeps refreshed. */
    connectedCimd: () => new Set(connected.all().map((r) => r.clientId)),
    isConnected: (clientId: string) => (one.get(clientId)?.n ?? 0) > 0,
    /** The client's registered name, or null when it has none or does not exist. */
    name: (clientId: string) => name.get(clientId)?.name || null,
    /**
     * Deletes DCR clients nobody consented to that are older than `cutoff`: registrations and
     * abandoned authorizes. `keep` (the internal client) is never deleted.
     */
    pruneUnconsented: (cutoff: Date, keep: string) => prune.run(keep, cutoff.toISOString()).changes,
  };
}

export type OAuthClients = ReturnType<typeof oauthClients>;
