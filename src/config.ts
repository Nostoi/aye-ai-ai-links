export type Env = Record<string, string | undefined>;

const DEFAULT_PORT = 3002;

/** The database file shared by the server and the key CLI. An in-memory one would lose every key. */
export function databasePath(env: Env): string {
  const path = env.AYE_DB;
  if (!path || path === ":memory:") {
    throw new Error("Set AYE_DB to the path of the database file (not :memory:).");
  }
  return path;
}

function port(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > 65535) {
    throw new Error("AYE_PORT must be a whole number from 0 to 65535.");
  }
  return value;
}

/** When AYE_ALLOWED_HOSTS is set, the loopback names stay allowed so local checks keep working. */
function allowedHosts(raw: string | undefined): string[] | undefined {
  const hosts = (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  return hosts.length === 0 ? undefined : [...hosts, "localhost", "127.0.0.1"];
}

export type ServerConfig = { dbPath: string; port: number; allowedHosts?: string[] };

export function serverConfig(env: Env): ServerConfig {
  const hosts = allowedHosts(env.AYE_ALLOWED_HOSTS);
  return {
    dbPath: databasePath(env),
    port: port(env.AYE_PORT),
    ...(hosts && { allowedHosts: hosts }),
  };
}
