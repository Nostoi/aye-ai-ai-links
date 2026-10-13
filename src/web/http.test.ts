import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { memoryAuth, TEST_BASE_URL, TEST_EMAIL, TEST_PASSWORD } from "../auth/memory-auth.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";

const OWN = "https://example.com/own-link";
const OTHER = "https://example.com/other-owners-link";

async function setup() {
  const a = await memoryAuth();
  const db = openDatabase(":memory:");
  const deps = createDeps(db, new FakeEmbedder(DIMS));
  for (const o of ["owner", "other"]) deps.store.ensureUser(o, o);
  await saveLink(deps, "owner", { url: OWN, savedBy: "codex", title: "Own <b>link</b>" });
  await saveLink(deps, "other", { url: OTHER, savedBy: "codex", title: "Other owner's link" });
  const { app } = createApp({
    deps,
    identify: async () => null,
    auth: a,
  });
  const get = (path: string, cookie?: string) =>
    app.fetch(
      new Request(`${TEST_BASE_URL}${path}`, {
        headers: cookie ? { cookie } : {},
        redirect: "manual",
      }),
    );
  const signIn = async () => {
    const res = await app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_BASE_URL },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
    return res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  };
  return { ...a, app, get, signIn };
}

const expectLoginRedirect = (res: Response) => {
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login");
  expect(res.headers.get("cache-control")).toBe("no-store");
};

describe("web door", () => {
  it("serves the login page to anyone, uncached, with a form that posts to better-auth's sign-in", async () => {
    const t = await setup();
    const res = await t.get("/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('<form id="login">');
    expect(html).toContain('fetch("/api/auth/sign-in/email"');
    expect(html).toContain("body.oauth_query = query.toString()");
    expect(t.hashing.verify).toBe(0);
  });

  it("sends a request without a session from / to /login", async () => {
    const t = await setup();
    expectLoginRedirect(await t.get("/"));
    expectLoginRedirect(await t.get("/", "__Secure-better-auth.session_token=forged.value"));
  });

  it("after login, shows owner `owner`'s link and not another owner's, escaped, uncached, with sign-out", async () => {
    const t = await setup();
    const res = await t.get("/", await t.signIn());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(`<a href="${OWN}" rel="noreferrer">Own &lt;b&gt;link&lt;/b&gt;</a>`);
    expect(html).not.toContain(OTHER);
    expect(html).not.toContain("Other owner");
    expect(html).toContain('<button id="sign-out"');
  });

  it("refuses an expired session on the next request; the same session unexpired is accepted", async () => {
    const t = await setup();
    const cookie = await t.signIn();
    const setExpiry = (d: Date) =>
      t.db.prepare(`UPDATE "session" SET expiresAt = ?`).run(d.toISOString());
    setExpiry(new Date(Date.now() + 6 * 86_400_000));
    expect((await t.get("/", cookie)).status).toBe(200);
    setExpiry(new Date(Date.now() - 1000));
    expectLoginRedirect(await t.get("/", cookie));
  });

  it("refuses a signed-out session on the next request", async () => {
    const t = await setup();
    const cookie = await t.signIn();
    expect((await t.get("/", cookie)).status).toBe(200);
    const out = await t.app.fetch(
      new Request(`${TEST_BASE_URL}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, origin: TEST_BASE_URL },
      }),
    );
    expect(out.status).toBe(200);
    expect(t.count("session")).toBe(0);
    expectLoginRedirect(await t.get("/", cookie));
  });

  it("forwards the refreshed session cookie that getSession sets", async () => {
    const t = await setup();
    const cookie = await t.signIn();
    // A session more than a day old is extended on its next use.
    const soon = new Date(Date.now() + 3_600_000);
    t.db.prepare(`UPDATE "session" SET expiresAt = ?`).run(soon.toISOString());
    const res = await t.get("/", cookie);
    expect(res.status).toBe(200);
    const [refreshed] = res.headers.getSetCookie();
    expect(refreshed).toMatch(/^__Secure-better-auth\.session_token=/);
    const row = t.db.prepare(`SELECT expiresAt FROM "session"`).get() as { expiresAt: string };
    expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(soon.getTime());
  });

  it("reads the session under the auth lock", async () => {
    const t = await setup();
    const cookie = await t.signIn();
    let release!: () => void;
    const held = t.withAuthLock(() => new Promise<void>((r) => (release = r)));
    let answered = false;
    const res = Promise.resolve(t.get("/", cookie)).then((r) => {
      answered = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toBe(false);
    release();
    await held;
    expect((await res).status).toBe(200);
  });

  it("leaves /mcp to agent keys: no session redirect there", async () => {
    const t = await setup();
    const res = await t.app.fetch(
      new Request(`${TEST_BASE_URL}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost",
          cookie: await t.signIn(),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
