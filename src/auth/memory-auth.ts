import { hashPassword, verifyPassword } from "better-auth/crypto";
import Database from "better-sqlite3";
import { createAuthLock } from "./auth-lock.js";
import { authOptions, createAuth, migrateAuth, type PasswordHasher } from "./better-auth.js";
import { setOwnerLogin } from "./owner-login.js";

export const TEST_BASE_URL = "https://links.example";
export const TEST_EMAIL = "you@example.com";
export const TEST_PASSWORD = "Correct-horse-battery-1";

/** For tests: a migrated in-memory auth whose password hashing is counted. */
export async function memoryAuth({ owner = "owner" }: { owner?: string | null } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const hashing = { hash: 0, verify: 0 };
  const password: PasswordHasher = {
    hash: (p) => {
      hashing.hash++;
      return hashPassword(p);
    },
    verify: (data) => {
      hashing.verify++;
      return verifyPassword(data);
    },
  };
  const options = authOptions({
    db,
    secret: "test-secret-0123456789abcdef0123456789",
    baseUrl: TEST_BASE_URL,
    password,
  });
  await migrateAuth(options);
  const auth = createAuth(options);
  if (owner !== null) {
    await setOwnerLogin(auth, {
      id: owner,
      name: "Owner",
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
  }
  hashing.hash = 0;
  const count = (table: "user" | "session" | "account") =>
    (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
  return { db, auth, withAuthLock: createAuthLock(), hashing, count };
}
