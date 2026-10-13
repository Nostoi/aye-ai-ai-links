import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { RateLimitOptions } from "../http/rate-limit.js";
import { AUTH_BODY_LIMIT, authApp } from "./http.js";
import { memoryAuth, TEST_BASE_URL, TEST_EMAIL, TEST_PASSWORD } from "./memory-auth.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

async function setup({
  loginLimit,
  wrap,
}: {
  loginLimit?: RateLimitOptions;
  wrap?: (handle: (r: Request) => Promise<Response>) => (r: Request) => Promise<Response>;
} = {}) {
  const t = await memoryAuth();
  const handled: string[] = [];
  const real = (r: Request) => {
    handled.push(new URL(r.url).pathname);
    return t.auth.handler(r);
  };
  const app = new Hono();
  app.route(
    "/api/auth",
    authApp({ handle: wrap ? wrap(real) : real, withAuthLock: t.withAuthLock, loginLimit }),
  );
  const send = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (init.method && init.method !== "GET") headers.set("origin", TEST_BASE_URL);
    return app.fetch(new Request(`${TEST_BASE_URL}/api/auth${path}`, { ...init, headers }));
  };
  const signIn = (password: string, extra: Record<string, unknown> = {}) =>
    send("/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password, ...extra }),
    });
  return { ...t, app, send, signIn, handled };
}

describe("auth routes", () => {
  it("refuses a wrong password with 401, sets no cookie and creates no session", async () => {
    const t = await setup();
    const res = await t.signIn("Wrong-password-1");
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(t.count("session")).toBe(0);
  });

  it("signs in with the right password: one session and a Secure, HttpOnly, SameSite=Lax cookie", async () => {
    const t = await setup();
    const res = await t.signIn(TEST_PASSWORD);
    expect(res.status).toBe(200);
    const [cookie, ...rest] = res.headers.getSetCookie();
    expect(rest).toEqual([]);
    expect(cookie).toMatch(/^__Secure-better-auth\.session_token=[^;]+;/);
    const attrs = (cookie ?? "").split(";").map((a) => a.trim().toLowerCase());
    expect(attrs).toContain("secure");
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("samesite=lax");
    expect(t.count("session")).toBe(1);
  });

  it("signs out: the session row is deleted", async () => {
    const t = await setup();
    const cookie = (await t.signIn(TEST_PASSWORD)).headers.getSetCookie()[0]?.split(";")[0] ?? "";
    expect(t.count("session")).toBe(1);
    const res = await t.send("/sign-out", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(t.count("session")).toBe(0);
  });

  it.each([
    ["POST", "/sign-up/email"],
    ["POST", "/change-password"],
    ["POST", "/verify-password"],
    ["POST", "/set-password"],
    ["POST", "/change-email"],
    ["POST", "/delete-user"],
    ["POST", "/revoke-sessions"],
    ["GET", "/list-sessions"],
    ["GET", "/ok"],
    ["POST", "/sign-in/email/"],
    ["POST", "/Sign-In/email"],
    ["POST", "/sign-in%2Femail"],
    ["POST", "//sign-in/email"],
    ["GET", "/sign-in/email"],
    ["POST", "/get-session"],
  ])(
    "answers %s %s with 404 before better-auth: no hashing, no user created",
    async (method, path) => {
      const t = await setup();
      const res = await t.send(path, {
        method,
        ...(method === "POST" && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "new@example.com",
            name: "New",
            password: "Another-password-2",
            newPassword: "Another-password-2",
            currentPassword: TEST_PASSWORD,
          }),
        }),
      });
      expect(res.status).toBe(404);
      expect(t.handled).toEqual([]);
      expect(t.hashing).toEqual({ hash: 0, verify: 0 });
      expect(t.count("user")).toBe(1);
    },
  );

  it("lets an auth request into better-auth only after the one before it has finished", async () => {
    const release = gate();
    const entered = gate();
    const log: string[] = [];
    let n = 0;
    const t = await setup({
      wrap: (handle) => async (r) => {
        const me = ++n;
        log.push(`in ${me}`);
        if (me === 1) {
          entered.open();
          await release.opened;
        }
        const res = await handle(r);
        log.push(`out ${me}`);
        return res;
      },
    });
    const first = t.send("/get-session");
    await entered.opened;
    const second = t.signIn(TEST_PASSWORD);
    await tick();
    expect(log).toEqual(["in 1"]);
    release.open();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(log).toEqual(["in 1", "out 1", "in 2", "out 2"]);
  });

  it("holds an auth request while a server-side call has the lock", async () => {
    const t = await setup();
    const release = gate();
    const held = t.withAuthLock(() => release.opened);
    const res = t.send("/get-session");
    await tick();
    expect(t.handled).toEqual([]);
    release.open();
    await held;
    expect((await res).status).toBe(200);
  });

  it("once the login limit is used up, answers sign-in with 429 without hashing or reaching better-auth", async () => {
    const t = await setup({ loginLimit: { limit: 2, windowMs: 60_000, now: () => 0 } });
    expect((await t.signIn("Wrong-password-1")).status).toBe(401);
    expect((await t.signIn("Wrong-password-2")).status).toBe(401);
    expect(t.hashing.verify).toBe(2);
    const handled = t.handled.length;
    const limited = await t.signIn(TEST_PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.getSetCookie()).toEqual([]);
    expect(t.hashing.verify).toBe(2);
    expect(t.handled.length).toBe(handled);
    expect(t.count("session")).toBe(0);
  });

  it("does not count other auth routes against the login limit", async () => {
    const t = await setup({ loginLimit: { limit: 1, windowMs: 60_000, now: () => 0 } });
    for (let i = 0; i < 3; i++) expect((await t.send("/get-session")).status).toBe(200);
    expect((await t.signIn(TEST_PASSWORD)).status).toBe(200);
  });

  it("answers a body over the cap with 413 without waiting for the lock or using the limit", async () => {
    const t = await setup({ loginLimit: { limit: 1, windowMs: 60_000, now: () => 0 } });
    const release = gate();
    const held = t.withAuthLock(() => release.opened);
    const big = "x".repeat(AUTH_BODY_LIMIT);
    const res = await t.signIn(TEST_PASSWORD, { pad: big });
    expect(res.status).toBe(413);
    expect(t.handled).toEqual([]);
    release.open();
    await held;
    expect((await t.signIn(TEST_PASSWORD)).status).toBe(200);
  });

  it("answers a streamed body over the cap, sent without Content-Length, with 413", async () => {
    const t = await setup();
    const chunk = new TextEncoder().encode("x".repeat(4096));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.length;
        if (sent > AUTH_BODY_LIMIT * 4) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await t.send("/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(t.handled).toEqual([]);
    expect(sent).toBeLessThanOrEqual(AUTH_BODY_LIMIT + 2 * chunk.length);
  });
});
