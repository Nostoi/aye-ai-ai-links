import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export type Env = Record<string, string | undefined>;

/**
 * Where model files live. Fixed, not a setting: it sits beside `releases/`, never inside it,
 * so pruning old releases cannot reach it.
 */
export function modelRoot(): string {
  return join(homedir(), ".aye-links", "models");
}

/** `deploy.sh` writes the release's version here, at the package root; found from this file, not the working directory. */
export const VERSION_FILE = new URL("../VERSION", import.meta.url);

/** The deployed version, or `dev` when no `VERSION` file was written. Any other read error refuses the start. */
export function appVersion(file: string | URL = VERSION_FILE): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "dev";
    throw error;
  }
  const version = text.trim();
  if (version === "") throw new Error(`${file} is empty.`);
  return version;
}

const DEFAULT_PORT = 3002;

/** The database file shared by the server and the key CLI. An in-memory one would lose every key. */
export function databasePath(env: Env): string {
  const path = env.AYE_DB;
  if (!path || !isAbsolute(path)) {
    throw new Error("Set AYE_DB to the absolute path of the database file (not :memory:).");
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

export type AuthConfig = { dbPath: string; secret: string; baseUrl: string };

const MIN_SECRET = 32;

/**
 * Two paths name the same file when they share an inode, or, when either is missing, the same
 * real path (the folder resolved through its symlinks, then the name).
 */
function sameFile(a: string, b: string): boolean {
  try {
    const [sa, sb] = [statSync(a), statSync(b)];
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return canonical(a) === canonical(b);
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const dir = dirname(path);
    return dir === path ? path : join(canonical(dir), basename(path));
  }
}

function baseUrl(raw: string | undefined): string {
  let url: URL | undefined;
  try {
    url = new URL(raw ?? "");
  } catch {}
  if (url?.protocol !== "https:" || url.origin !== raw) {
    throw new Error(
      "Set AYE_BASE_URL to the https origin the browser uses, such as https://links.example.com, with no path or trailing slash.",
    );
  }
  return raw;
}

/**
 * The auth settings, shared by the server and the owner CLI. better-auth also reads
 * `BETTER_AUTH_*` variables (one adds trusted origins), so any of them refuses the start.
 */
export function authConfig(env: Env): AuthConfig {
  const stray = Object.keys(env).find((name) => name.startsWith("BETTER_AUTH_"));
  if (stray) {
    throw new Error(
      `Unset ${stray}: better-auth reads BETTER_AUTH_* variables, and this server takes its auth settings only from AYE_ variables.`,
    );
  }
  const dbPath = env.AYE_AUTH_DB;
  if (!dbPath || !isAbsolute(dbPath)) {
    throw new Error(
      "Set AYE_AUTH_DB to the absolute path of the auth database file (not :memory:).",
    );
  }
  if (sameFile(dbPath, databasePath(env))) {
    throw new Error("AYE_AUTH_DB must be a different file from AYE_DB.");
  }
  const secret = env.AYE_AUTH_SECRET ?? "";
  if (secret.length < MIN_SECRET) {
    throw new Error("Set AYE_AUTH_SECRET to a random string of at least 32 characters.");
  }
  return { dbPath, secret, baseUrl: baseUrl(env.AYE_BASE_URL) };
}

export type ServerConfig = {
  dbPath: string;
  port: number;
  allowedHosts?: string[];
  auth: AuthConfig;
  version: string;
};

export function serverConfig(env: Env): ServerConfig {
  const hosts = allowedHosts(env.AYE_ALLOWED_HOSTS);
  return {
    dbPath: databasePath(env),
    port: port(env.AYE_PORT),
    ...(hosts && { allowedHosts: hosts }),
    auth: authConfig(env),
    version: appVersion(),
  };
}
