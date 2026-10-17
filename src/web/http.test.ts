import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createAgentKey, hashKey } from "../auth/agent-keys.js";
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
import { SqliteKeyStore } from "../store/key-store.js";

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
    auth: { ...a, keys: new SqliteKeyStore(db) },
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
  return { ...a, linksDb: db, deps, app, get, signIn };
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

  // #95 changed home from no links to the owner's "Worth a look today" picks.
  it("after login, home asks the question as the search field's label, shows only the owner's picks, and menus only existing pages", async () => {
    const t = await setup();
    const res = await t.get("/", await t.signIn());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toMatch(/<label[^>]*for="q"[^>]*>What are you trying to remember\?<\/label>/);
    expect(html).toMatch(/<input[^>]*id="q"[^>]*name="q"[^>]*>/);
    expect(html).toContain('action="/search"');
    expect(html).toContain(OWN);
    expect(html).toContain("Own &lt;b&gt;link&lt;/b&gt;");
    expect(html).not.toContain(OTHER);
    expect(html).toContain('href="/connections"');
    expect(html).toContain('href="/tags"');
    expect(html).toContain('href="/profile"');
    expect(html).toContain('<button id="sign-out"');
    // #37 added All links.
    expect(html).toContain('href="/all"');
    for (const path of ["/connections", "/tags", "/profile", "/all"]) {
      expect((await t.get(path, await t.signIn())).status, path).toBe(200);
    }
  });

  it("after login, /search shows owner `owner`'s link and not another owner's, escaped, uncached", async () => {
    const t = await setup();
    const res = await t.get("/search?q=link", await t.signIn());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(
      `<a href="${OWN}" target="_blank" rel="noopener noreferrer" data-open>Own &lt;b&gt;link&lt;/b&gt;</a>`,
    );
    expect(html).not.toContain(OTHER);
    expect(html).not.toContain("Other owner");
    expect(html).not.toContain("<b>link");
  });

  it("sends a /search request without a session to /login", async () => {
    const t = await setup();
    expectLoginRedirect(await t.get("/search?q=link"));
  });

  it("lists the newest links under their own heading for a blank search", async () => {
    const t = await setup();
    const html = await (await t.get("/search?q=%20", await t.signIn())).text();
    expect(html).toContain("Your newest links");
    expect(html).not.toContain("Best matches first");
    expect(html).toContain(OWN);
    expect(html).not.toContain(OTHER);
  });

  it("keep mode: a blank search is headed to keep, with the hint, autofocus and a hidden keep field", async () => {
    const t = await setup();
    const html = await (await t.get("/search?q=&keep=1", await t.signIn())).text();
    expect(html).toContain("Find the link to keep handy");
    expect(html).not.toContain("Your newest links");
    expect(html).toContain(
      '<p class="small hint">Find the link you use regularly, then press <strong>Keep handy</strong>.</p>',
    );
    expect(html).toContain('<input id="q" name="q" type="search" value="" autofocus>');
    expect(html).toContain('<input type="hidden" name="keep" value="1">');
  });

  it("keep mode: a word search stays 'Best matches first' with the hint and the hidden keep field", async () => {
    const t = await setup();
    const html = await (await t.get("/search?q=lunch&keep=1", await t.signIn())).text();
    expect(html).toContain("Best matches first");
    expect(html).not.toContain("Find the link to keep handy");
    expect(html).toContain("Find the link you use regularly");
    expect(html).toContain('<input type="hidden" name="keep" value="1">');
  });

  it("keep mode lists only active links, for a blank and a word search; ordinary search lists archived ones too", async () => {
    const t = await setup();
    const { link } = await saveLink(t.deps, "owner", {
      url: "https://example.com/done",
      savedBy: "codex",
      title: "Finished lunch notes",
    });
    await t.deps.store.update("owner", link.id, { state: "archived" });
    const cookie = await t.signIn();
    const page = async (path: string) => (await t.get(path, cookie)).text();
    for (const q of ["", "lunch"]) {
      expect(await page(`/search?q=${q}&keep=1`), q).not.toContain("Finished lunch notes");
      expect(await page(`/search?q=${q}`), q).toContain("Finished lunch notes");
    }
    expect(await page("/search?q=&keep=1")).toContain("Own &lt;b&gt;link&lt;/b&gt;");
  });

  it("keep mode with every link archived says none can be kept, not that none are saved", async () => {
    const t = await setup();
    const [own] = await t.deps.store.listLinks("owner");
    await t.deps.store.update("owner", own?.id ?? "", { state: "archived" });
    const cookie = await t.signIn();
    const keep = await (await t.get("/search?q=&keep=1", cookie)).text();
    expect(keep).toContain("No active links to keep handy.");
    expect(keep).not.toContain("No links saved yet.");
    expect(await (await t.get("/search?q=", cookie)).text()).not.toContain("No links saved yet.");
  });

  it("keep mode's 'Not it?' link to the newest links stays in keep mode", async () => {
    const t = await setup();
    const cookie = await t.signIn();
    const keep = await (await t.get("/search?q=&keep=1", cookie)).text();
    expect(keep).toContain('see <a href="/search?q=&keep=1">your newest links</a>');
    const plain = await (await t.get("/search?q=", cookie)).text();
    expect(plain).toContain('see <a href="/search?q=">your newest links</a>');
  });

  it("keep mode is on only for keep=1; ordinary search has none of its markup", async () => {
    const t = await setup();
    const cookie = await t.signIn();
    for (const path of ["/search?q=", "/search?q=&keep=0", "/search?q=&keep=true"]) {
      const html = await (await t.get(path, cookie)).text();
      expect(html, path).toContain("Your newest links");
      expect(html, path).not.toContain("Find the link you use regularly");
      expect(html, path).not.toContain("autofocus");
      expect(html, path).not.toContain('name="keep"');
    }
  });

  it("titles a word search 'Best matches first' and shows an inferred why as a guess", async () => {
    const t = await setup();
    await saveLink(t.deps, "owner", {
      url: "https://example.com/guessed",
      savedBy: "codex",
      title: "Quokka habitat",
      why: { text: "for the zoo trip", source: "inferred" },
    });
    const html = await (await t.get("/search?q=quokka", await t.signIn())).text();
    expect(html).toContain("Best matches first");
    expect(html).toContain("Why (a guess): for the zoo trip");
    expect(html).not.toContain('Why: "for the zoo trip"');
  });

  it("does not make a stored non-web URL clickable", async () => {
    const t = await setup();
    t.linksDb
      .prepare("UPDATE links SET url = ? WHERE owner_id = 'owner'")
      .run("javascript:alert(1)");
    const html = await (await t.get("/search?q=link", await t.signIn())).text();
    expect(html).toContain("Own &lt;b&gt;link&lt;/b&gt;");
    expect(html).not.toContain('href="javascript:');
  });

  it("echoes the query escaped in the field", async () => {
    const t = await setup();
    const q = encodeURIComponent('"><script>x');
    const html = await (await t.get(`/search?q=${q}`, await t.signIn())).text();
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;x"');
    expect(html).not.toContain("<script>x");
  });

  it("writes no search log row for a web word search", async () => {
    const t = await setup();
    expect((await t.get("/search?q=link", await t.signIn())).status).toBe(200);
    expect(t.linksDb.prepare("SELECT count(*) AS n FROM search_log").get()).toEqual({ n: 0 });
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

  it("is linked from the menu of the home page and of /search", async () => {
    const world = await oauthWorld();
    const browser = await signedIn(world);
    for (const path of ["/", "/search?q=x"]) {
      expect(String((await browser.send(path)).body), path).toContain('href="/connections"');
    }
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

  it.each(["/connections", "/oauth-error", "/search?q=x"])(
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
    ["GET", "/search?q=x"],
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

/** Every agent-key row and every user, so a refusal can be shown to have changed none. */
const keyRows = (world: World) => ({
  keys: world.links.prepare("SELECT * FROM agent_keys ORDER BY id").all(),
  users: world.links.prepare("SELECT * FROM users ORDER BY id").all(),
});

/** A key of the owner's, made as the CLI makes one. */
const ownerKey = (world: World, agent = "Codex on laptop") =>
  createAgentKey(world.keyStore, { owner: "owner", ownerName: "Owner", agent });

const MAKE = "/connections/keys";
const TURN_OFF = "/connections/keys/turn-off";
const TURN_ON = "/connections/keys/turn-on";
const posting = (json: unknown) => ({ method: "POST", json });
const works = async (world: World, key: string) =>
  (await saveLinkWith(world, key, `https://example.com/${Math.random()}`)).status;

describe("agent keys on the connections page", () => {
  it("lists the owner's keys that are on, by name and date, never a key or hash", async () => {
    const world = await oauthWorld();
    const on = ownerKey(world, "Codex <on> laptop");
    const off = ownerKey(world, "Old agent");
    world.keyStore.revokeById("owner", off.id, new Date());
    const res = await (await signedIn(world)).send("/connections");
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("Agent keys");
    expect(html).toContain("<strong>Codex &lt;on&gt; laptop</strong>");
    expect(html).toContain(`data-key-id="${on.id}"`);
    expect(html).toMatch(/Made [A-Z][a-z]+ \d{1,2}</);
    expect(html).not.toContain("Old agent");
    expect(html).not.toContain(`data-key-id="${off.id}"`);
    for (const secret of [on.key, hashKey(on.key), off.key]) expect(html).not.toContain(secret);
  });

  it("makes a key: uncached JSON with its id, name and key, which works on /mcp and is not on the page after", async () => {
    const world = await oauthWorld();
    const browser = await signedIn(world);
    const res = await browser.send(MAKE, posting({ name: "  Codex on desktop " }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const key = field(res, "key");
    expect(res.body).toEqual({ id: expect.any(Number), name: "Codex on desktop", key });
    expect(await works(world, key)).toBe(200);
    expect(world.savedBy()).toEqual(["Codex on desktop"]);
    const page = await browser.send("/connections");
    expect(String(page.body)).toContain("<strong>Codex on desktop</strong>");
    expect(page.bytes.includes(key)).toBe(false);
  });

  it.each([
    ["a blank name", "  ", /Give the agent a name/],
    ["a name over 60 characters", "a".repeat(61), /60 characters/],
    ["web", "web", /"web"/],
    ["Web with spaces", " Web ", /"web"/],
    ["a name that already has a key", "Codex on laptop", /already has a live key/],
  ])("refuses to make a key with %s, writing no row", async (_, name, message) => {
    const world = await oauthWorld();
    ownerKey(world);
    const before = keyRows(world);
    const res = await (await signedIn(world)).send(MAKE, posting({ name }));
    expect(res.status).toBe(400);
    expect(field(res, "message")).toMatch(message);
    expect(keyRows(world)).toEqual(before);
  });

  it("turns a key off by id: 204 uncached, its next request gets 401, and it leaves the list", async () => {
    const world = await oauthWorld();
    const made = ownerKey(world);
    expect(await works(world, made.key)).toBe(200);
    const browser = await signedIn(world);
    const res = await browser.send(TURN_OFF, posting({ id: made.id }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await works(world, made.key)).toBe(401);
    const after = String((await browser.send("/connections")).body);
    expect(after).not.toContain("<strong>Codex on laptop</strong>");
    expect(after).not.toContain(`data-key-id="${made.id}"`);
  });

  it.each([
    ["an id that is no key", () => 9999],
    [
      "a key that is already off",
      (world: World) => {
        const made = ownerKey(world, "Old agent");
        world.keyStore.revokeById("owner", made.id, new Date());
        return made.id;
      },
    ],
  ])("refuses to turn off %s with 400, and every key row stays", async (_, id) => {
    const world = await oauthWorld();
    const live = ownerKey(world);
    const target = id(world);
    const before = keyRows(world);
    const res = await (await signedIn(world)).send(TURN_OFF, posting({ id: target }));
    expect(res.status).toBe(400);
    expect(keyRows(world)).toEqual(before);
    expect(await works(world, live.key)).toBe(200);
  });

  it("undoes a turn-off within 60 seconds: 204 and the key works again", async () => {
    const world = await oauthWorld();
    const made = ownerKey(world);
    const browser = await signedIn(world);
    expect((await browser.send(TURN_OFF, posting({ id: made.id }))).status).toBe(204);
    expect(await works(world, made.key)).toBe(401);
    const res = await browser.send(TURN_ON, posting({ id: made.id }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await works(world, made.key)).toBe(200);
  });

  it("refuses an undo more than 60 seconds after the turn-off, and the key stays off", async () => {
    const world = await oauthWorld();
    const made = ownerKey(world);
    const browser = await signedIn(world);
    await browser.send(TURN_OFF, posting({ id: made.id }));
    world.links
      .prepare("UPDATE agent_keys SET revoked_at = revoked_at - 61000 WHERE id = ?")
      .run(made.id);
    const before = keyRows(world);
    const res = await browser.send(TURN_ON, posting({ id: made.id }));
    expect(res.status).toBe(400);
    expect(field(res, "message")).toMatch(/too late/);
    expect(keyRows(world)).toEqual(before);
    expect(await works(world, made.key)).toBe(401);
  });

  it("refuses an undo once a new key with the same name was made; the old stays off and the new works", async () => {
    const world = await oauthWorld();
    const old = ownerKey(world);
    const browser = await signedIn(world);
    await browser.send(TURN_OFF, posting({ id: old.id }));
    const fresh = await browser.send(MAKE, posting({ name: "Codex on laptop" }));
    expect(fresh.status).toBe(200);
    const before = keyRows(world);
    const res = await browser.send(TURN_ON, posting({ id: old.id }));
    expect(res.status).toBe(400);
    expect(field(res, "message")).toMatch(/was made since/);
    expect(keyRows(world)).toEqual(before);
    expect(await works(world, old.key)).toBe(401);
    expect(await works(world, field(fresh, "key"))).toBe(200);
  });

  it("refuses an undo once a new key with the same name was made, even after that one is turned off too", async () => {
    const world = await oauthWorld();
    const old = ownerKey(world);
    const browser = await signedIn(world);
    await browser.send(TURN_OFF, posting({ id: old.id }));
    const fresh = await browser.send(MAKE, posting({ name: "Codex on laptop" }));
    const freshId = (fresh.body as { id: number }).id;
    expect((await browser.send(TURN_OFF, posting({ id: freshId }))).status).toBe(204);
    const before = keyRows(world);
    const res = await browser.send(TURN_ON, posting({ id: old.id }));
    expect(res.status).toBe(400);
    expect(field(res, "message")).toMatch(/was made since/);
    expect(keyRows(world)).toEqual(before);
    expect(await works(world, old.key)).toBe(401);
    expect(await works(world, field(fresh, "key"))).toBe(401);
  });

  it("undoes the turn-off of the newest key with a name, though an older one with it is off", async () => {
    const world = await oauthWorld();
    const old = ownerKey(world);
    const browser = await signedIn(world);
    await browser.send(TURN_OFF, posting({ id: old.id }));
    const fresh = ownerKey(world);
    expect((await browser.send(TURN_OFF, posting({ id: fresh.id }))).status).toBe(204);
    expect((await browser.send(TURN_ON, posting({ id: fresh.id }))).status).toBe(204);
    expect(await works(world, fresh.key)).toBe(200);
    expect(await works(world, old.key)).toBe(401);
  });

  it("refuses a second user's undo of the owner's key as it refuses an id that is no key, naming nothing of the owner's", async () => {
    const world = await oauthWorld();
    const old = ownerKey(world, "codex");
    world.keyStore.revokeById("owner", old.id, new Date());
    const fresh = ownerKey(world, "codex");
    const bBrowser = await addSecondUser(world);
    const before = keyRows(world);
    const theirs = await bBrowser.send(TURN_ON, posting({ id: old.id }));
    const none = await bBrowser.send(TURN_ON, posting({ id: 9999 }));
    expect(theirs.status).toBe(400);
    expect(theirs.body).toEqual(none.body);
    expect(String(theirs.bytes)).not.toContain("codex");
    expect(keyRows(world)).toEqual(before);
    expect(await works(world, old.key)).toBe(401);
    expect(await works(world, fresh.key)).toBe(200);
  });

  it("a stale turn-off of the old key's id leaves the new key with the same name on", async () => {
    const world = await oauthWorld();
    const old = ownerKey(world);
    const browser = await signedIn(world);
    await browser.send(TURN_OFF, posting({ id: old.id }));
    const fresh = ownerKey(world);
    const before = keyRows(world);
    expect((await browser.send(TURN_OFF, posting({ id: old.id }))).status).toBe(400);
    expect(keyRows(world)).toEqual(before);
    expect(await works(world, fresh.key)).toBe(200);
  });

  it("acts for the signed-in user: a second user's list, make, turn-off and undo leave the owner's keys alone", async () => {
    const world = await oauthWorld();
    const live = ownerKey(world, "agent-a");
    const off = ownerKey(world, "agent-a-old");
    world.keyStore.revokeById("owner", off.id, new Date());
    const bBrowser = await addSecondUser(world);
    const ownerRows = () =>
      world.links.prepare("SELECT * FROM agent_keys WHERE owner_id = 'owner' ORDER BY id").all();
    const before = ownerRows();

    const listed = String((await bBrowser.send("/connections")).body);
    const turnOff = await bBrowser.send(TURN_OFF, posting({ id: live.id }));
    const turnOn = await bBrowser.send(TURN_ON, posting({ id: off.id }));
    const made = await bBrowser.send(MAKE, posting({ name: "agent-a" }));

    expect(listed).not.toContain("agent-a");
    expect(listed).not.toContain(`data-key-id="${live.id}"`);
    expect(turnOff.status).toBe(400);
    expect(turnOn.status).toBe(400);
    expect(made.status).toBe(200);
    expect(ownerRows()).toEqual(before);
    expect(await works(world, live.key)).toBe(200);
    expect(await works(world, off.key)).toBe(401);
    expect(world.keyStore.findLiveByHash(hashKey(field(made, "key")))).toEqual({
      owner: SECOND_USER.id,
      name: "agent-a",
    });
  });

  const OVER = "x".repeat(AUTH_BODY_LIMIT);
  describe.each([
    [MAKE, { name: "New agent" }, "name"],
    [TURN_OFF, "live", "id"],
    [TURN_ON, "off", "id"],
  ] as const)("POST %s", (path, sample, name) => {
    /** The owner's live key, and one turned off just now, which an undo could bring back. */
    async function keysWorld() {
      const world = await oauthWorld();
      const live = ownerKey(world);
      const off = ownerKey(world, "Off agent");
      world.keyStore.revokeById("owner", off.id, new Date());
      const body = sample === "live" ? { id: live.id } : sample === "off" ? { id: off.id } : sample;
      return { world, live, off, body };
    }

    const refusals: [string, (body: Record<string, unknown>) => object, number][] = [
      ["without an Origin", (json) => ({ json, origin: false }), 403],
      [
        "with a foreign Origin",
        (json) => ({ json, headers: { origin: "https://evil.example" } }),
        403,
      ],
      ["with a foreign Host", (json) => ({ json, headers: { host: "evil.example" } }), 403],
      ["without a session", (json) => ({ json, anonymous: true }), 302],
      ["with a body over the cap", (json) => ({ json: { ...json, pad: OVER } }), 413],
      [
        "with a body over the cap, before reading any session",
        (json) => ({ json: { ...json, pad: OVER }, anonymous: true }),
        413,
      ],
      [
        "with a body that is not JSON",
        (json) => ({ rawForm: new URLSearchParams(json as Record<string, string>).toString() }),
        400,
      ],
      [`without its field`, () => ({ json: { other: 1 } }), 400],
      ...(name === "id"
        ? ([
            ["with the id as a string", (json) => ({ json: { id: String(json.id) } }), 400],
            ["with a fractional id", (json) => ({ json: { id: Number(json.id) + 0.5 } }), 400],
            ["with id 0", () => ({ json: { id: 0 } }), 400],
          ] as typeof refusals)
        : ([["with the name as a number", () => ({ json: { name: 7 } }), 400]] as typeof refusals)),
    ];

    it.each(refusals)("refuses a request %s, and every key row stays", async (_, how, status) => {
      const { world, live, off, body } = await keysWorld();
      const before = keyRows(world);
      const { anonymous, ...options } = how(body) as { anonymous?: true };
      const browser = anonymous ? world.agent() : await signedIn(world);
      const res = await browser.send(path, { method: "POST", ...options });
      expect(res.status).toBe(status);
      expect(keyRows(world)).toEqual(before);
      expect(await works(world, live.key)).toBe(200);
      expect(await works(world, off.key)).toBe(401);
    });

    it("succeeds with the same body from a signed-in page, so each refusal is down to what it changed", async () => {
      const { world, body } = await keysWorld();
      const res = await (await signedIn(world)).send(path, posting(body));
      expect(res.status).toBeLessThan(300);
    });
  });
});
