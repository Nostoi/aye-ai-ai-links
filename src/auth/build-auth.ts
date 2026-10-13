import type Database from "better-sqlite3";
import {
  authOptions,
  createAuth,
  mcpResource,
  migrateAuth,
  type PasswordHasher,
} from "./better-auth.js";
import type { Identify } from "./caller.js";
import { INTERNAL_CLIENT_ID, installInternalClient } from "./internal-client.js";
import { createMetadataRefresher } from "./metadata-refresher.js";
import { createMetadataStash, type JsonFetch, type MetadataStash } from "./metadata-stash.js";
import { oauthClients } from "./oauth-clients.js";
import { oauthIdentify } from "./oauth-identify.js";

const DAY_MS = 24 * 60 * 60_000;

/**
 * Builds the auth side of the server on an open auth database, in this order:
 * 1. better-auth and its lock, after the migrations;
 * 2. the metadata stash, on that lock and the OAuth tables. Its current snapshots are what
 *    better-auth may resolve; until it exists, admission throws;
 * 3. the startup prune of stale unconsented DCR clients, then the internal client with a new
 *    secret;
 * 4. one refresher cycle, so connected clients resolve as soon as the server listens.
 * `/mcp` identifies agent keys through `keys` and everything else as OAuth tokens.
 */
export async function buildAuth({
  db,
  secret,
  baseUrl,
  fetch,
  keys,
  password,
  now = Date.now,
  wrapMigrations = (migrate) => migrate(),
  refresherOptions,
}: {
  db: Database.Database;
  secret: string;
  baseUrl: string;
  /** Network for client metadata: PR A's guarded JSON fetcher in production. */
  fetch: JsonFetch;
  keys: Identify;
  password?: PasswordHasher | undefined;
  now?: () => number;
  wrapMigrations?: (migrate: () => Promise<void>) => Promise<void>;
  refresherOptions?: { intervalMs?: number; fillBoundMs?: number } | undefined;
}) {
  let built: MetadataStash | undefined;
  const stashed = () => {
    if (!built) throw new Error("admission was asked before the metadata stash exists");
    return built;
  };
  const options = authOptions({
    db,
    secret,
    baseUrl,
    password,
    admission: {
      isAdmitted: (clientId) => stashed().isCurrent(clientId),
      transport: (input) => stashed().transport(input),
    },
  });
  await wrapMigrations(() => migrateAuth(options));
  const { auth, withAuthLock } = createAuth(options);
  const clients = oauthClients(db);
  const stash = createMetadataStash({ fetch, now, withAuthLock, isConnected: clients.isConnected });
  built = stash;
  const resource = mcpResource(baseUrl);
  clients.pruneUnconsented(new Date(now() - DAY_MS), INTERNAL_CLIENT_ID);
  const internal = await installInternalClient(auth, resource, new Date(now()));
  const refresher = createMetadataRefresher({
    stash,
    readConnected: () => withAuthLock(async () => clients.connectedCimd()),
    ...refresherOptions,
  });
  await refresher.fill();
  const identify = oauthIdentify({ auth, withAuthLock, keys, internal, clients, resource });
  return { auth, withAuthLock, stash, clients, refresher, internal, identify };
}

export type BuiltAuth = Awaited<ReturnType<typeof buildAuth>>;
