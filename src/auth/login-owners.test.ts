import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authOptions, createAuth, migrateAuth, openAuthDatabase } from "./better-auth.js";
import { loginOwners } from "./login-owners.js";
import { setOwnerLogin } from "./owner-login.js";

const SECRET = "test-secret-0123456789abcdef0123456789";

describe("loginOwners", () => {
  let dir: string;
  let db: Database;
  let options: ReturnType<typeof authOptions>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "aye-login-owners-"));
    db = openAuthDatabase(join(dir, "auth.db"));
    options = authOptions({ db, secret: SECRET, baseUrl: "https://links.example" });
    await migrateAuth(options);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is empty on a fresh auth database", () => {
    expect(loginOwners(db)).toEqual([]);
  });

  it("returns each login's id and name", async () => {
    await setOwnerLogin(createAuth(options).auth, {
      id: "reader-42",
      name: "Reader",
      email: "you@example.com",
      password: "Correct-horse-battery-1",
    });
    expect(loginOwners(db)).toEqual([{ id: "reader-42", name: "Reader" }]);
  });
});
