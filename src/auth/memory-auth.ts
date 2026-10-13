import { hashPassword, verifyPassword } from "better-auth/crypto";
import Database from "better-sqlite3";
import type { PasswordHasher } from "./better-auth.js";
import { buildAuth } from "./build-auth.js";
import type { Identify } from "./caller.js";
import type { JsonFetch } from "./metadata-stash.js";
import { setOwnerLogin } from "./owner-login.js";

export const TEST_BASE_URL = "https://links.example";
export const TEST_EMAIL = "you@example.com";
export const TEST_PASSWORD = "Correct-horse-battery-1";
export const TEST_SECRET = "test-secret-0123456789abcdef0123456789";

/** A metadata network with nothing on it. */
const noNetwork: JsonFetch = async (url) => {
  throw new Error(`no network in this test: ${url}`);
};

/**
 * For tests: a migrated auth, built as the server builds it, whose password hashing is counted.
 * In memory unless `db` is given. `fetch` stands in for the metadata network.
 */
export async function memoryAuth({
  owner = "owner",
  fetch = noNetwork,
  now,
  keys = async () => null,
  db = new Database(":memory:"),
}: {
  owner?: string | null;
  fetch?: JsonFetch;
  now?: () => number;
  keys?: Identify;
  db?: Database.Database;
} = {}) {
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
  const built = await buildAuth({
    db,
    secret: TEST_SECRET,
    baseUrl: TEST_BASE_URL,
    fetch,
    keys,
    password,
    ...(now && { now }),
  });
  if (owner !== null) {
    await setOwnerLogin(built.auth, {
      id: owner,
      name: "Owner",
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
  }
  hashing.hash = 0;
  const count = (table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
  return { db, ...built, hashing, count };
}
