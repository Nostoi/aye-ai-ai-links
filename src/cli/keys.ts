import { pathToFileURL } from "node:url";
import { createAgentKey, listAgentKeys, revokeAgentKey } from "../auth/agent-keys.js";
import { openDatabase } from "../store/database.js";
import { SqliteKeyStore } from "../store/key-store.js";

const USAGE = "Usage: keys <create <agent> | list | revoke <agent>>";

type Env = Record<string, string | undefined>;

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
  const path = env.AYE_DB;
  if (!path || path === ":memory:") {
    err("Set AYE_DB to the path of the database file (not :memory:).");
    return 1;
  }
  const owner = env.AYE_OWNER || "owner";
  const ownerName = env.AYE_OWNER_NAME || "Owner";
  try {
    const db = openDatabase(path);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2), process.env, console.log, console.error);
}
