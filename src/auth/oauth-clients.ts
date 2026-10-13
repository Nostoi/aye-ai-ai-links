import type Database from "better-sqlite3";

/**
 * Plain reads, the startup prune and the disconnect deletes over better-auth's OAuth tables and
 * its `verification` table. They depend on its schema, so their tests re-run on every
 * better-auth upgrade. A client is connected when it has an `oauthClient` row and an
 * `oauthConsent` row.
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
  const listed = db.prepare<
    [string],
    { clientId: string; name: string | null; connectedAt: string }
  >(
    `SELECT c.clientId, c.name, min(k.createdAt) AS connectedAt
     FROM oauthClient c JOIN oauthConsent k ON k.clientId = c.clientId
     WHERE k.userId = ? GROUP BY c.clientId ORDER BY connectedAt, c.clientId`,
  );
  const byOwner = (table: string) =>
    db.prepare<[string, string]>(`DELETE FROM ${table} WHERE clientId = ? AND userId = ?`);
  const deleteAccess = byOwner("oauthAccessToken");
  const deleteRefresh = byOwner("oauthRefreshToken");
  const deleteConsent = byOwner("oauthConsent");
  // Codes are found by their JSON value; the CASE keeps json_extract off a value that is not JSON.
  const deleteCodes = db.prepare<[string, string]>(
    `DELETE FROM verification WHERE CASE WHEN json_valid(value) THEN
       json_extract(value, '$.type') = 'authorization_code'
       AND json_extract(value, '$.query.client_id') = ? AND json_extract(value, '$.userId') = ?
     END`,
  );
  const revoke = db.transaction((owner: string, clientId: string) => {
    deleteAccess.run(clientId, owner);
    deleteRefresh.run(clientId, owner);
    deleteCodes.run(clientId, owner);
    return deleteConsent.run(clientId, owner).changes > 0;
  });
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
    /** The clients `owner` has connected, oldest first, each with when the owner first approved it. */
    connections: (owner: string) =>
      listed.all(owner).map((r) => ({
        clientId: r.clientId,
        name: r.name || null,
        connectedAt: new Date(r.connectedAt),
      })),
    /**
     * Deletes everything that lets `clientId` act for `owner`, in one transaction: its access and
     * refresh tokens, its consent and its unused authorization codes. Keeps the client's row and
     * every other user's grants. Returns whether the owner had consented.
     */
    revokeGrants: (owner: string, clientId: string): boolean => revoke(owner, clientId),
  };
}

export type OAuthClients = ReturnType<typeof oauthClients>;
