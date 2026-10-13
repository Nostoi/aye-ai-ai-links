import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  authOptions,
  createAuth,
  migrateAuth,
  openAuthDatabase,
  PASSWORD_LENGTH,
} from "./better-auth.js";

const BASE = "https://links.example";
const SECRET = "test-secret-0123456789abcdef0123456789";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempPath = () => {
  const d = mkdtempSync(join(tmpdir(), "aye-auth-"));
  dirs.push(d);
  return join(d, "auth.db");
};

const tables = (db: Database.Database) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);

describe("authOptions", () => {
  it("closes sign-up, turns off better-auth's limiter, telemetry and cookie cache, and has no social or plugins", () => {
    const db = new Database(":memory:");
    const o = authOptions({ db, secret: SECRET, baseUrl: BASE });
    expect(o.emailAndPassword).toMatchObject({ enabled: true, disableSignUp: true });
    expect(o.rateLimit).toEqual({ enabled: false });
    expect(o.telemetry).toEqual({ enabled: false });
    expect(o.advanced).toMatchObject({ useSecureCookies: true });
    expect(o).not.toHaveProperty("socialProviders");
    expect(o).not.toHaveProperty("plugins");
    expect(o).not.toHaveProperty("session.cookieCache");
    db.close();
  });

  it("gives better-auth the password lengths the CLI checks, and the base URL as the only trusted origin", async () => {
    const db = new Database(":memory:");
    const ctx = await createAuth(authOptions({ db, secret: SECRET, baseUrl: BASE })).$context;
    expect(ctx.password.config).toEqual({
      minPasswordLength: PASSWORD_LENGTH.min,
      maxPasswordLength: PASSWORD_LENGTH.max,
    });
    expect(ctx.trustedOrigins).toEqual([BASE]);
    expect(ctx.rateLimit.enabled).toBe(false);
    db.close();
  });

  it("refuses sign-up through the API, so no user is created", async () => {
    const db = new Database(":memory:");
    const options = authOptions({ db, secret: SECRET, baseUrl: BASE });
    await migrateAuth(options);
    const auth = createAuth(options);
    await expect(
      auth.api.signUpEmail({
        body: { email: "new@example.com", password: "Correct-horse-1", name: "New" },
      }),
    ).rejects.toMatchObject({ body: { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" } });
    expect(db.prepare("SELECT count(*) AS n FROM user").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("openAuthDatabase", () => {
  it("turns on foreign keys and WAL, and holds the file so no other connection can read it", () => {
    const path = tempPath();
    const db = openAuthDatabase(path);
    try {
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      const other = new Database(path, { timeout: 0 });
      try {
        expect(() => other.prepare("SELECT count(*) FROM sqlite_master").get()).toThrow(
          expect.objectContaining({ code: "SQLITE_BUSY" }),
        );
      } finally {
        other.close();
      }
    } finally {
      db.close();
    }
  });

  it("takes the lock at once on a file that is already in WAL mode", () => {
    const path = tempPath();
    const before = new Database(path);
    before.pragma("journal_mode = WAL");
    before.exec("CREATE TABLE kept (a)");
    before.close();
    const db = openAuthDatabase(path);
    const other = new Database(path, { timeout: 0 });
    try {
      expect(() => other.prepare("SELECT * FROM kept").all()).toThrow(
        expect.objectContaining({ code: "SQLITE_BUSY" }),
      );
    } finally {
      other.close();
      db.close();
    }
  });

  it("refuses at once, with SQLITE_BUSY, while another connection holds the file", () => {
    const path = tempPath();
    const holder = openAuthDatabase(path);
    try {
      const started = Date.now();
      expect(() => openAuthDatabase(path)).toThrow(
        expect.objectContaining({ code: "SQLITE_BUSY" }),
      );
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      holder.close();
    }
  });

  it("releases the file when closed", () => {
    const path = tempPath();
    openAuthDatabase(path).close();
    const other = new Database(path, { timeout: 0 });
    expect(() => other.prepare("SELECT count(*) FROM sqlite_master").get()).not.toThrow();
    other.close();
  });
});

describe("migrateAuth", () => {
  it("creates better-auth's tables, and a second run changes nothing", async () => {
    const db = new Database(":memory:");
    const options = authOptions({ db, secret: SECRET, baseUrl: BASE });
    await migrateAuth(options);
    expect(tables(db)).toEqual(["account", "session", "user", "verification"]);
    const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    await migrateAuth(options);
    expect(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    db.close();
  });

  it("fails, naming the problem, when the schema has a required column better-auth does not know", async () => {
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE "user" (id text primary key, name text not null, email text not null unique,
        emailVerified integer not null, image text, createdAt date not null, updatedAt date not null,
        surprise text not null)`,
    );
    const options = authOptions({ db, secret: SECRET, baseUrl: BASE });
    await expect(migrateAuth(options)).rejects.toThrow(/surprise/);
    expect(tables(db)).toEqual(["user"]);
    db.close();
  });
});
