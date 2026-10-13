import type { WithAuthLock } from "./auth-lock.js";
import type { MetadataStash } from "./metadata-stash.js";
import type { OAuthClients } from "./oauth-clients.js";

type Deps = { withAuthLock: WithAuthLock; clients: OAuthClients; stash: MetadataStash };

/** The apps `owner` has connected, read under the auth lock. */
export const listConnections =
  ({ withAuthLock, clients }: Omit<Deps, "stash">) =>
  (owner: string) =>
    withAuthLock(async () => clients.connections(owner));

/**
 * Ends `clientId`'s access for `owner`, under the auth lock: its tokens, consent and unused codes
 * go in one transaction. Its metadata snapshot is forgotten too, in the same lock section, unless
 * another user still has it connected. Returns whether the owner had it connected.
 */
export const disconnect =
  ({ withAuthLock, clients, stash }: Deps) =>
  (owner: string, clientId: string) =>
    withAuthLock(async () => {
      const had = clients.revokeGrants(owner, clientId);
      if (had && !clients.isConnected(clientId)) stash.forget(clientId);
      return had;
    });
