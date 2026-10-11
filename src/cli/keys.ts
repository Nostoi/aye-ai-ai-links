import { createAgentKey, listAgentKeys, revokeAgentKey } from "../auth/agent-keys.js";
import { databasePath, type Env } from "../config.js";
import { openDatabase } from "../store/database.js";
import { SqliteKeyStore } from "../store/key-store.js";

const USAGE = "Usage: keys <create <agent> | list | revoke <agent>>";

/** Manage agent keys. Returns the exit status; the key is printed once, on create. */
export function run(
  argv: string[],
  env: Env,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const [command, agent] = argv;
  const needsAgent = command === "create" || command === "revoke";
  if (!(command === "list" || needsAgent) || (needsAgent && agent === undefined)) {
    err(USAGE);
    return 1;
  }
  const owner = env.AYE_OWNER || "owner";
  const ownerName = env.AYE_OWNER_NAME || "Owner";
  try {
    const db = openDatabase(databasePath(env));
    try {
      const keys = new SqliteKeyStore(db);
      if (command === "create") {
        out(createAgentKey(keys, { owner, ownerName, agent: agent ?? "" }));
      } else if (command === "revoke") {
        revokeAgentKey(keys, owner, agent ?? "");
        out(`Revoked the key for ${agent}.`);
      } else {
        for (const k of listAgentKeys(keys, owner)) {
          const state = k.revokedAt ? `revoked ${k.revokedAt.toISOString()}` : "live";
          out(`${k.name}\tcreated ${k.createdAt.toISOString()}\t${state}`);
        }
      }
    } finally {
      db.close();
    }
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
