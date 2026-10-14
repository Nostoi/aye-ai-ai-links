import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import Database from "better-sqlite3";
import { createAuthLock } from "./auth-lock.js";
import { type Admission, clientAdmission, NO_ADMISSION } from "./client-admission.js";
import { OAUTH_ERROR_PATH } from "./oauth-error.js";
import { OFFLINE_ACCESS } from "./offline-access.js";

/** Where better-auth's handler is mounted. */
export const AUTH_BASE_PATH = "/api/auth";

/** The password lengths sign-in accepts; the owner CLI checks a new password against them. */
export const PASSWORD_LENGTH = { min: 8, max: 128 } as const;

/** The scope `/mcp` requires. `offline_access` only lets a client refresh. */
export const LINKS_SCOPE = "links";

/** The exact resource identifier tokens are bound to: the public `/mcp` URL. */
export const mcpResource = (baseUrl: string) => `${baseUrl}/mcp`;

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
 *   routes use this app's own limits instead, in tests and production alike.
 * - Cookies are always `Secure`; `SameSite=Lax` is better-auth's default. No cookie cache, so a
 *   revoked or expired session fails on the next request.
 * - OAuth for `/mcp` (decision record conditions 1, 6, 7 and 8): `mcp()` with opaque tokens, a
 *   refresh reuse window of 0 and no `client_credentials`. CIMD clients resolve through the
 *   admitted discovery; `cimd()` itself is never registered, and neither is `oauthProvider()`.
 *   DCR stays open as the fallback for clients without a metadata document.
 */
export function authOptions({
  db,
  secret,
  baseUrl,
  password,
  admission = NO_ADMISSION,
}: {
  db: Database.Database;
  secret: string;
  baseUrl: string;
  password?: PasswordHasher | undefined;
  admission?: Admission | undefined;
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
    // Authorize errors that cannot go back to the client come to our page, not better-auth's.
    onAPIError: { errorURL: OAUTH_ERROR_PATH },
    plugins: [
      mcp({
        resource: mcpResource(baseUrl),
        loginPage: "/login",
        consentPage: "/consent",
        scopes: [LINKS_SCOPE, OFFLINE_ACCESS],
        grantTypes: ["authorization_code", "refresh_token"],
        refreshTokenReuseInterval: 0,
        disableJwtPlugin: true,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      clientAdmission(admission),
    ],
  };
}

export type AuthOptions = ReturnType<typeof authOptions>;

const makeAuth = (options: AuthOptions) => betterAuth(options);

export type Auth = ReturnType<typeof makeAuth>;

/**
 * better-auth and the one lock every call into it goes through, built together so a second
 * lock for the same auth cannot exist.
 */
export function createAuth(options: AuthOptions) {
  return { auth: makeAuth(options), withAuthLock: createAuthLock() };
}

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
