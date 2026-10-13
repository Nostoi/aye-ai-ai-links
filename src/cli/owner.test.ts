import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAuthLock } from "../auth/auth-lock.js";
import { authOptions, createAuth, openAuthDatabase, PASSWORD_LENGTH } from "../auth/better-auth.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import { run } from "./owner.js";

const BASE = "https://links.example";
const SECRET = "test-secret-0123456789abcdef0123456789";
const EMAIL = "you@example.com";
const FIRST = "First-password-123";
const SECOND = "Second-password-456";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "aye-owner-"));
  dirs.push(dir);
  return {
    AYE_DB: join(dir, "links.db"),
    AYE_AUTH_DB: join(dir, "auth.db"),
    AYE_AUTH_SECRET: SECRET,
    AYE_BASE_URL: BASE,
    ...extra,
  };
}

async function exec(argv: string[], vars: Record<string, string | undefined>, stdin: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    argv,
    vars,
    async () => stdin,
    (s) => out.push(s),
    (s) => err.push(s),
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** Every row of every table, by table name, read through a plain connection. */
function dump(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true, timeout: 0 });
  try {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    return Object.fromEntries(
      names.map((n) => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]),
    );
  } finally {
    db.close();
  }
}

const schema = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  } finally {
    db.close();
  }
};

/** The real composition on the CLI's file: sign in, then ask `/` with a cookie. */
async function server(vars: Record<string, string | undefined>) {
  const authDb = openAuthDatabase(vars.AYE_AUTH_DB as string);
  const db = openDatabase(":memory:");
  const deps = createDeps(db, new FakeEmbedder(DIMS));
  deps.store.ensureUser("owner", "Owner");
  await saveLink(deps, "owner", { url: "https://example.com/mine", savedBy: "codex" });
  const auth = createAuth(authOptions({ db: authDb, secret: SECRET, baseUrl: BASE }));
  const { app } = createApp({
    deps,
    identify: async () => null,
    auth: { auth, withAuthLock: createAuthLock() },
  });
  const signIn = async (password: string) => {
    const res = await app.fetch(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: EMAIL, password }),
      }),
    );
    return {
      status: res.status,
      cookie: res.headers.getSetCookie()[0]?.split(";")[0] ?? "",
      user: res.status === 200 ? ((await res.json()) as { user: { id: string } }).user : null,
    };
  };
  const home = async (cookie: string) =>
    (await app.fetch(new Request(`${BASE}/`, { headers: { cookie }, redirect: "manual" }))).status;
  return {
    signIn,
    home,
    close: () => {
      authDb.close();
      db.close();
    },
  };
}

describe("owner CLI", () => {
  it("creates the owner on a first run, and that password signs in as owner `owner`", async () => {
    const vars = env();
    const r = await exec(["set", EMAIL], vars, `${FIRST}\n`);
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toMatch(/Created/);
    const s = await server(vars);
    try {
      const login = await s.signIn(FIRST);
      expect(login.status).toBe(200);
      expect(login.user?.id).toBe("owner");
      expect(await s.home(login.cookie)).toBe(200);
    } finally {
      s.close();
    }
  });

  it("strips exactly one trailing newline from the password", async () => {
    const vars = env();
    expect((await exec(["set", EMAIL], vars, `${FIRST}\n\n`)).code).toBe(0);
    const s = await server(vars);
    try {
      expect((await s.signIn(FIRST)).status).toBe(401);
      expect((await s.signIn(`${FIRST}\n`)).status).toBe(200);
    } finally {
      s.close();
    }
  });

  it("on a re-run changes the password and deletes the owner's sessions, so the old cookie is refused at /", async () => {
    const vars = env();
    await exec(["set", EMAIL], vars, FIRST);
    const s1 = await server(vars);
    const before = await s1.signIn(FIRST);
    expect(await s1.home(before.cookie)).toBe(200);
    s1.close();
    expect(dump(vars.AYE_AUTH_DB as string).session).toHaveLength(1);

    const r = await exec(["set", EMAIL], vars, SECOND);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Changed/);
    expect(dump(vars.AYE_AUTH_DB as string).session).toEqual([]);

    const s2 = await server(vars);
    try {
      expect(await s2.home(before.cookie)).toBe(302);
      expect((await s2.signIn(FIRST)).status).toBe(401);
      expect((await s2.signIn(SECOND)).status).toBe(200);
    } finally {
      s2.close();
    }
  });

  it("writes only the user, account and session tables", async () => {
    const vars = env();
    const path = vars.AYE_AUTH_DB as string;
    await exec(["set", EMAIL], vars, FIRST);
    const s = await server(vars);
    await s.signIn(FIRST);
    s.close();
    const seeded = new Database(path);
    const at = new Date().toISOString();
    seeded
      .prepare(
        "INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES ('v1', 'id', 'kept', ?, ?, ?)",
      )
      .run(at, at, at);
    seeded.close();
    const before = dump(path);
    const shape = schema(path);

    expect((await exec(["set", "new@example.com"], vars, SECOND)).code).toBe(0);
    const after = dump(path);
    const { user: u0, account: a0, session: s0, ...rest0 } = before;
    const { user: u1, account: a1, session: s1, ...rest1 } = after;
    expect(rest1).toEqual(rest0);
    expect(rest1.verification).toHaveLength(1);
    expect(u1).not.toEqual(u0);
    expect(a1).not.toEqual(a0);
    expect(s1).not.toEqual(s0);
    expect(schema(path)).toEqual(shape);
  });

  it("refuses, changing nothing, while another connection holds the auth database", async () => {
    const vars = env();
    const path = vars.AYE_AUTH_DB as string;
    await exec(["set", EMAIL], vars, FIRST);
    const before = dump(path);
    const holder = openAuthDatabase(path);
    let r: Awaited<ReturnType<typeof exec>>;
    try {
      r = await exec(["set", "new@example.com"], vars, SECOND);
    } finally {
      holder.close();
    }
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Stop the server first/);
    expect(r.err).toContain("launchctl bootout");
    expect(r.out).toBe("");
    expect(dump(path)).toEqual(before);
  });

  it.each([
    ["too short", "x".repeat(PASSWORD_LENGTH.min - 1)],
    ["too long", "x".repeat(PASSWORD_LENGTH.max + 1)],
  ])("refuses a password that is %s, changing nothing", async (_, password) => {
    const vars = env();
    const path = vars.AYE_AUTH_DB as string;
    await exec(["set", EMAIL], vars, FIRST);
    const before = dump(path);
    const r = await exec(["set", EMAIL], vars, password);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters`);
    expect(dump(path)).toEqual(before);
    const s = await server(vars);
    try {
      expect((await s.signIn(FIRST)).status).toBe(200);
    } finally {
      s.close();
    }
  });

  it("accepts passwords at both length limits, and sign-in accepts them too", async () => {
    for (const password of ["x".repeat(PASSWORD_LENGTH.min), "y".repeat(PASSWORD_LENGTH.max)]) {
      const vars = env();
      expect((await exec(["set", EMAIL], vars, password)).code).toBe(0);
      const s = await server(vars);
      try {
        expect((await s.signIn(password)).status).toBe(200);
      } finally {
        s.close();
      }
    }
  });

  it("refuses a bad password or email on a fresh install without creating the file", async () => {
    for (const [email, password] of [
      [EMAIL, "short"],
      ["not-an-email", FIRST],
    ] as const) {
      const vars = env();
      expect((await exec(["set", email], vars, password)).code).toBe(1);
      expect(existsSync(vars.AYE_AUTH_DB as string)).toBe(false);
    }
  });

  it("refuses to run with a BETTER_AUTH_ variable set, without creating the file", async () => {
    const vars = env({ BETTER_AUTH_TRUSTED_ORIGINS: "https://other.example" });
    const r = await exec(["set", EMAIL], vars, FIRST);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Unset BETTER_AUTH_TRUSTED_ORIGINS/);
    expect(existsSync(vars.AYE_AUTH_DB as string)).toBe(false);
  });

  it("uses AYE_OWNER as the user id", async () => {
    const vars = env({ AYE_OWNER: "mark" });
    await exec(["set", EMAIL], vars, FIRST);
    expect(dump(vars.AYE_AUTH_DB as string).user).toMatchObject([{ id: "mark", email: EMAIL }]);
  });

  it("prints usage and exits 1 for a missing or unknown command or a missing email", async () => {
    const vars = env();
    for (const argv of [[], ["frobnicate"], ["set"], ["set", EMAIL, "extra"]]) {
      const r = await exec(argv, vars, FIRST);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toMatch(/Usage/);
    }
    expect(existsSync(vars.AYE_AUTH_DB as string)).toBe(false);
  });

  describe("as a script", () => {
    const root = resolve(import.meta.dirname, "../..");

    beforeAll(() => {
      execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
    }, 60_000);

    it("reads the password from stdin", async () => {
      const vars = env();
      const { BETTER_AUTH_URL: _, ...parent } = process.env;
      const stdout = execFileSync("node", [join(root, "dist/cli/owner-main.js"), "set", EMAIL], {
        env: { ...parent, ...vars },
        input: `${FIRST}\n`,
        encoding: "utf8",
      });
      expect(stdout).toMatch(/Created/);
      const s = await server(vars);
      try {
        expect((await s.signIn(FIRST)).status).toBe(200);
      } finally {
        s.close();
      }
    });
  });
});
