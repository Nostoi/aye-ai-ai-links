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
import { createMetadataStash, type JsonFetch } from "./metadata-stash.js";
import { oauthClients } from "./oauth-clients.js";
import { oauthIdentify } from "./oauth-identify.js";

const DAY_MS = 24 * 60 * 60_000;

/**
 * Builds the auth side of the server on an open auth database, in this order:
 * 1. the metadata stash, whose current snapshots are what better-auth may resolve;
 * 2. better-auth and its lock, after the migrations;
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
  const stash = createMetadataStash({ fetch, now });
  const options = authOptions({
    db,
    secret,
    baseUrl,
    password,
    admission: { isAdmitted: stash.isCurrent, transport: stash.transport },
  });
  await wrapMigrations(() => migrateAuth(options));
  const { auth, withAuthLock } = createAuth(options);
  const clients = oauthClients(db);
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
