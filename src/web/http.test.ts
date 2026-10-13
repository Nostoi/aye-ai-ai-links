import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { memoryAuth, TEST_BASE_URL, TEST_EMAIL, TEST_PASSWORD } from "../auth/memory-auth.js";
import {
  addSecondUser,
  approve,
  CLAUDE_ID,
  connectClaude,
  connectClaudeAs,
  DCR_REDIRECT,
  exchange,
  field,
  oauthWorld,
  pkce,
  SECOND_USER,
  saveLinkWith,
  type World,
} from "../auth/oauth-test-kit.js";
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
    expect(html).toContain('<form id="login" data-next="/">');
    expect(html).toContain('fetch("/api/auth/sign-in/email"');
    expect(html).toContain("body.oauth_query = query.toString()");
    expect(t.hashing.verify).toBe(0);
  });

  it("renders data-next as home for a next that is not the authorize path", async () => {
    const t = await setup();
    const next = encodeURIComponent("https://evil.example/api/auth/oauth2/authorize?x=1");
    const html = await (await t.get(`/login?next=${next}`)).text();
    expect(html).toContain('data-next="/"');
    expect(html).not.toContain("evil.example");
  });

  it("renders an authorize next escaped in data-next", async () => {
    const t = await setup();
    const next = encodeURIComponent('/api/auth/oauth2/authorize?client_id=c&state="x"');
    const html = await (await t.get(`/login?next=${next}`)).text();
    expect(html).toContain('data-next="/api/auth/oauth2/authorize?client_id=c&amp;state=%22x%22"');
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

/** Every token, consent and code row, so a refusal can be shown to have changed none. */
const grantRows = (world: World) =>
  world.db
    .prepare(
      `SELECT 'access' AS t, id FROM oauthAccessToken UNION ALL
       SELECT 'refresh', id FROM oauthRefreshToken UNION ALL
       SELECT 'consent', id FROM oauthConsent UNION ALL
       SELECT 'code', id FROM verification ORDER BY 1, 2`,
    )
    .all() as { t: string; id: string }[];

/** Connects a DCR client named `name` and returns its id. */
async function connectNamed(world: World, name: string) {
  const registered = await world.agent().send("/api/auth/oauth2/register", {
    method: "POST",
    origin: false,
    json: { client_name: name, redirect_uris: [DCR_REDIRECT], token_endpoint_auth_method: "none" },
  });
  const clientId = field(registered, "client_id");
  await approve(world, clientId, DCR_REDIRECT);
  return clientId;
}

async function signedIn(world: World) {
  const browser = world.agent();
  await browser.signIn();
  return browser;
}

const disconnecting = (clientId: string) => ({ method: "POST", json: { clientId } });

describe("the connections page", () => {
  it("sends a browser without a session to /login", async () => {
    const world = await oauthWorld();
    const res = await world.agent().send("/connections");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("lists the owner's apps, escaped, uncached, each with a disconnect button", async () => {
    const world = await oauthWorld();
    await connectClaude(world);
    const dcrId = await connectNamed(world, "<script>x</script>");
    const res = await (await signedIn(world)).send("/connections");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = String(res.body);
    expect(html).toContain("Claude");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain(`data-client-id="${CLAUDE_ID}"`);
    expect(html).toContain(`data-client-id="${dcrId}"`);
    expect(html).toContain('fetch("/connections/disconnect"');
  });

  it("escapes a client id holding a quote and an angle bracket, and the attribute reads back as the id", async () => {
    const world = await oauthWorld();
    const id = 'https://evil.example/x"onmouseover=alert(1)<b/metadata.json';
    const redirect = "https://evil.example/cb";
    world.net.json(id, {
      client_id: id,
      client_name: "Evil",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const p = pkce();
    const { code } = await approve(world, id, redirect, { challenge: p.challenge });
    const tokens = await exchange(world, code, p.verifier, {
      client_id: id,
      redirect_uri: redirect,
    });
    expect(tokens.status).toBe(200);

    const res = await (await signedIn(world)).send("/connections");

    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).not.toContain('x"onmouseover');
    expect(html).not.toContain("<b/metadata.json");
    const values = [...html.matchAll(/data-client-id="([^"]*)"/g)].map((m) =>
      (m[1] ?? "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&amp;", "&"),
    );
    expect(values).toEqual([id]);
  });

  it("is linked from the home page", async () => {
    const world = await oauthWorld();
    const res = await (await signedIn(world)).send("/");
    expect(String(res.body)).toContain('href="/connections"');
  });

  it("disconnects an app: 204, its token stops working and it leaves the list", async () => {
    const world = await oauthWorld();
    const claude = await connectClaude(world);
    const browser = await signedIn(world);
    const res = await browser.send("/connections/disconnect", disconnecting(CLAUDE_ID));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await saveLinkWith(world, claude.access, "https://example.com/a")).status).toBe(401);
    expect(String((await browser.send("/connections")).body)).not.toContain(CLAUDE_ID);
  });

  it("disconnects an app whose client id is over 1 KiB", async () => {
    const world = await oauthWorld();
    const id = `https://long.example/${"a".repeat(1100)}/metadata.json`;
    const redirect = "https://long.example/cb";
    world.net.json(id, {
      client_id: id,
      client_name: "Long",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const p = pkce();
    const { code } = await approve(world, id, redirect, { challenge: p.challenge });
    const tokens = await exchange(world, code, p.verifier, {
      client_id: id,
      redirect_uri: redirect,
    });
    expect(tokens.status).toBe(200);
    expect(grantRows(world).length).toBeGreaterThan(0);
    const res = await (await signedIn(world)).send("/connections/disconnect", disconnecting(id));
    expect(res.status).toBe(204);
    expect(grantRows(world)).toEqual([]);
  });

  it("acts for the signed-in user: a second user's disconnect and list leave the owner's grants alone", async () => {
    const world = await oauthWorld();
    await connectClaude(world);
    const dcrId = await connectNamed(world, "Owner Only");
    const bBrowser = await addSecondUser(world);
    await connectClaudeAs(world, bBrowser);
    const held = (userId: string) =>
      ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"].map(
        (table) =>
          world.db.prepare(`SELECT id FROM ${table} WHERE userId = ? ORDER BY id`).all(userId) as {
            id: string;
          }[],
      );
    const ownerBefore = held("owner");
    expect(ownerBefore.every((r) => r.length > 0)).toBe(true);
    expect(held(SECOND_USER.id).every((r) => r.length > 0)).toBe(true);
    const listed = String((await bBrowser.send("/connections")).body);
    expect(listed).toContain(`data-client-id="${CLAUDE_ID}"`);
    expect(listed).not.toContain(dcrId);

    const res = await bBrowser.send("/connections/disconnect", disconnecting(CLAUDE_ID));

    expect(res.status).toBe(204);
    expect(held("owner")).toEqual(ownerBefore);
    expect(held(SECOND_USER.id)).toEqual([[], [], []]);
    const after = String((await bBrowser.send("/connections")).body);
    expect(after).not.toContain(CLAUDE_ID);
    expect(after).not.toContain(dcrId);
    expect(after).toContain("No apps are connected");
  });

  it("answers 204 for an app that is not connected, changing nothing", async () => {
    const world = await oauthWorld();
    await connectClaude(world);
    const before = grantRows(world);
    const res = await (await signedIn(world)).send(
      "/connections/disconnect",
      disconnecting("https://never.example/metadata.json"),
    );
    expect(res.status).toBe(204);
    expect(grantRows(world)).toEqual(before);
  });

  const claudeBody = { clientId: CLAUDE_ID };
  it.each([
    ["without an Origin", { json: claudeBody, origin: false }, 403],
    [
      "with a foreign Origin",
      { json: claudeBody, headers: { origin: "https://evil.example" } },
      403,
    ],
    ["without a session", { json: claudeBody, anonymous: true }, 302],
    [
      "with a body over the cap",
      { json: { ...claudeBody, pad: "x".repeat(AUTH_BODY_LIMIT) } },
      413,
    ],
    [
      "with a body over the cap, before reading any session",
      { json: { ...claudeBody, pad: "x".repeat(AUTH_BODY_LIMIT) }, anonymous: true },
      413,
    ],
    ["with a body that is not JSON", { form: claudeBody }, 400],
    ["without a clientId", { json: { client: CLAUDE_ID } }, 400],
  ])("refuses a disconnect %s, and every grant row stays", async (_, how, status) => {
    const world = await oauthWorld();
    const claude = await connectClaude(world);
    const before = grantRows(world);
    expect(before.length).toBeGreaterThan(0);
    const { anonymous, ...options } = how as typeof how & { anonymous?: true };
    const browser = anonymous ? world.agent() : await signedIn(world);
    const res = await browser.send("/connections/disconnect", { method: "POST", ...options });
    expect(res.status).toBe(status);
    expect(grantRows(world)).toEqual(before);
    expect((await saveLinkWith(world, claude.access, "https://example.com/a")).status).toBe(200);
  });

  it.each(["/connections", "/oauth-error"])(
    "refuses GET %s with a foreign Origin, and serves it without one",
    async (path) => {
      const world = await oauthWorld();
      const browser = await signedIn(world);
      const foreign = await browser.send(path, { headers: { origin: "https://evil.example" } });
      expect(foreign.status).toBe(403);
      expect((await browser.send(path)).status).toBe(200);
    },
  );

  it.each([
    ["GET", "/connections"],
    ["POST", "/connections/disconnect"],
    ["GET", "/oauth-error"],
  ])("refuses %s %s with a foreign Host", async (method, path) => {
    const world = await oauthWorld();
    await connectClaude(world);
    const before = grantRows(world);
    const browser = await signedIn(world);
    const res = await browser.send(path, {
      method,
      headers: { host: "evil.example" },
      ...(method === "POST" && { json: claudeBody }),
    });
    expect(res.status).toBe(403);
    expect(grantRows(world)).toEqual(before);
  });
});
