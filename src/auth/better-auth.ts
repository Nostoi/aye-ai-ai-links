import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import Database from "better-sqlite3";

/** The password lengths sign-in accepts; the owner CLI checks a new password against them. */
/** Where better-auth's handler is mounted. */
export const AUTH_BASE_PATH = "/api/auth";

export const PASSWORD_LENGTH = { min: 8, max: 128 } as const;

/** Replaces better-auth's password hashing, so tests can count it. */
export type PasswordHasher = {
  hash: (password: string) => Promise<string>;
  verify: (data: { hash: string; password: string }) => Promise<boolean>;
};

/**
 * The one better-auth configuration, shared by the server and the owner CLI: the migrations are
 * derived from it, so both must build it here.
 * - Email and password only, with sign-up closed: the CLI creates the owner.
 * - better-auth's own limiter is off. It trusts a client-sent `X-Forwarded-For`, so the auth
 *   routes use this app's global login limit instead, in tests and production alike.
 * - Cookies are always `Secure`; `SameSite=Lax` is better-auth's default. No cookie cache, so a
 *   revoked or expired session fails on the next request.
 */
export function authOptions({
  db,
  secret,
  baseUrl,
  password,
}: {
  db: Database.Database;
  secret: string;
  baseUrl: string;
  password?: PasswordHasher | undefined;
}) {
  return {
    baseURL: baseUrl,
    basePath: AUTH_BASE_PATH,
    secret,
    database: db,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_LENGTH.min,
      maxPasswordLength: PASSWORD_LENGTH.max,
      ...(password && { password }),
    },
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    advanced: { useSecureCookies: true, disableOriginCheck: false, disableCSRFCheck: false },
    logger: { level: "error" as const },
  };
}

export type AuthOptions = ReturnType<typeof authOptions>;

export function createAuth(options: AuthOptions) {
  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Opens the auth file and holds an exclusive lock on it until the handle closes, so no other
 * process (the owner CLI above all) can read or write it meanwhile. The lock is taken here, not
 * on first use, and a file already held refuses at once with `SQLITE_BUSY`.
 */
export function openAuthDatabase(path: string): Database.Database {
  const db = new Database(path, { timeout: 0 });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("locking_mode = EXCLUSIVE");
    db.pragma("journal_mode = WAL");
    db.exec("BEGIN EXCLUSIVE; COMMIT");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Brings the auth tables up to date. Fails, changing nothing, if the existing schema conflicts. */
export async function migrateAuth(options: AuthOptions): Promise<void> {
  const migrations = await getMigrations(options);
  if (migrations.schemaProblems.length > 0) {
    throw new Error(
      `The auth database schema has problems: ${migrations.schemaProblems.join("; ")}`,
    );
  }
  await migrations.runMigrations();
}
