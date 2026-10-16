import { afterEach, describe, expect, it, vi } from "vitest";
import { FRESHNESS_MS, MAX_PENDING, PENDING_MS } from "./metadata-stash.js";
import {
  approve,
  authorizePath,
  CHATGPT_ID,
  CHATGPT_REDIRECT,
  CLAUDE_ID,
  CLAUDE_REDIRECT,
  chatgptDocument,
  clientAssertion,
  connectClaude,
  exchange,
  field,
  oauthWorld,
  otherClientDocument as otherClient,
  pkce,
  refresh,
  saveLinkWith,
  signingKey,
  type World,
} from "./oauth-test-kit.js";

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const HIGH = { limit: 1_000_000, windowMs: 60_000 };
const HIGH_LIMITS = { authorize: HIGH, token: HIGH, revoke: HIGH, register: HIGH };

/** A clock for the stash alone: better-auth keeps real time, so signed queries and tokens stay valid. */
function stashClock() {
  let offset = 0;
  return { now: () => Date.now() + offset, advance: (ms: number) => (offset += ms) };
}

const unsignedJwt = (claims: object) =>
  `${Buffer.from('{"alg":"ES256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;

afterEach(() => {
  vi.useRealTimers();
});

describe("client admission", () => {
  it("floods of unknown and malformed client ids on every route reach no network and leave the owner's token working", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world = await oauthWorld({ limits: HIGH_LIMITS });
    const claude = await connectClaude(world);
    // Past cimd's 60-second accounting window, so its state for Claude's origin could be evicted.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const anon = world.agent();
    const post = (
      path: string,
      form: Record<string, string>,
      headers: Record<string, string> = {},
    ) => anon.send(path, { method: "POST", origin: false, form, headers });
    const statuses = new Map<number, number>();
    const tally = (status: number) => statuses.set(status, (statuses.get(status) ?? 0) + 1);
    // More distinct origins than cimd's maxCacheEntries (1000): Codex's decisive revoke flood.
    for (let i = 0; i < 1100; i++) {
      const junk = `https://attack${i}.example/c`;
      tally((await post("/api/auth/oauth2/revoke", { client_id: junk, token: "junk" })).status);
    }
    for (let i = 0; i < 40; i++) {
      const junk = `https://other${i}.example/c`;
      const basic = `Basic ${Buffer.from(`${encodeURIComponent(junk)}:x`).toString("base64")}`;
      const assertion = {
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: unsignedJwt({ iss: junk, sub: junk, aud: "x" }),
      };
      const sent = [
        post("/api/auth/oauth2/token", { grant_type: "client_credentials", client_id: junk }),
        post(
          "/api/auth/oauth2/token",
          { grant_type: "client_credentials" },
          { authorization: basic },
        ),
        post("/api/auth/oauth2/revoke", { token: "junk" }, { authorization: basic }),
        post("/api/auth/oauth2/token", {
          grant_type: "authorization_code",
          code: "j",
          ...assertion,
        }),
        post("/api/auth/oauth2/token", {
          grant_type: "refresh_token",
          refresh_token: "j",
          ...assertion,
        }),
        post("/api/auth/oauth2/revoke", { token: "junk", ...assertion }),
        post("/api/auth/oauth2/revoke", {
          client_id: `https://claude.ai/oauth/../x${i}`,
          token: "j",
        }),
        post("/api/auth/oauth2/revoke", { client_id: CLAUDE_ID, token: "junk" }),
        post("/api/auth/oauth2/revoke", { client_id: junk, client_id_2: junk, token: "j" }),
        anon.send(authorizePath(junk, `${junk}/cb`, pkce().challenge)),
      ];
      for (const res of await Promise.all(sent)) tally(res.status);
    }
    expect((await saveLinkWith(world, claude.access, "https://e.example/1")).status).toBe(200);
    const refreshed = await refresh(world, claude.refresh, { client_id: CLAUDE_ID });
    expect(refreshed.status).toBe(200);

    expect(statuses.has(200)).toBe(false);
    expect(statuses.has(429)).toBe(false);
    expect(world.net.calls.map((c) => c.url)).toEqual([CLAUDE_ID]);
    expect(world.count("oauthClient")).toBe(2);
  }, 60_000);

  it("refuses a client within F of its document being withdrawn, whatever cimd has cached", async () => {
    const world = await oauthWorld();
    const claude = await connectClaude(world);
    expect((await saveLinkWith(world, claude.access, "https://e.example/1")).status).toBe(200);
    world.net.status(CLAUDE_ID, 404);
    await world.refresher.cycle();
    expect((await saveLinkWith(world, claude.access, "https://e.example/2")).status).toBe(401);
    expect((await refresh(world, claude.refresh, { client_id: CLAUDE_ID })).status).toBe(400);
    expect(world.savedBy()).toEqual(["Claude"]);
  });

  it("sends the owner's browser to the error page when a connected client's document is withdrawn", async () => {
    const world = await oauthWorld();
    await connectClaude(world);
    world.net.status(CLAUDE_ID, 404);
    await world.refresher.cycle();
    const fetched = world.net.calls.length;
    const browser = world.agent();
    expect((await browser.signIn()).status).toBe(200);
    for (const agent of [browser, world.agent()]) {
      const az = await agent.send(authorizePath(CLAUDE_ID, CLAUDE_REDIRECT, pkce().challenge));
      expect(az.status).toBe(302);
      expect(az.headers.get("location")).toBe("/oauth-error?error=invalid_client");
      expect(az.headers.get("cache-control")).toBe("no-store");
      const page = await agent.send(az.headers.get("location") ?? "");
      expect(page.bytes.toString()).toContain("This app is not connected");
    }
    expect(world.net.calls.length).toBe(fetched);
    expect(world.count("oauthAccessToken")).toBe(1);
  });

  it("sends the owner to the error page once a failing client's snapshot is F old, and not before", async () => {
    const clock = stashClock();
    const world = await oauthWorld({ now: clock.now });
    await connectClaude(world);
    world.net.status(CLAUDE_ID, 503);
    clock.advance(FRESHNESS_MS - 1_000);
    await world.refresher.cycle();
    const browser = world.agent();
    expect((await browser.signIn()).status).toBe(200);
    const authorize = () =>
      browser.send(authorizePath(CLAUDE_ID, CLAUDE_REDIRECT, pkce().challenge));
    expect((await authorize()).headers.get("location")).toMatch(`${CLAUDE_REDIRECT}?code=`);
    clock.advance(1_000);
    expect((await authorize()).headers.get("location")).toBe("/oauth-error?error=invalid_client");
  });

  it("keeps a client through failed refreshes until F after its last success, then refuses it", async () => {
    const clock = stashClock();
    const world = await oauthWorld({ now: clock.now });
    const claude = await connectClaude(world);
    world.net.status(CLAUDE_ID, 503);
    clock.advance(FRESHNESS_MS - 1_000);
    await world.refresher.cycle();
    expect((await saveLinkWith(world, claude.access, "https://e.example/1")).status).toBe(200);
    clock.advance(1_000);
    expect((await saveLinkWith(world, claude.access, "https://e.example/2")).status).toBe(401);
    world.net.json(CLAUDE_ID, { ...(await import("./oauth-test-kit.js")).claudeDocument });
    await world.refresher.cycle();
    expect((await saveLinkWith(world, claude.access, "https://e.example/3")).status).toBe(200);
  });

  it("refreshes a jwks_uri change from v1 to v2 together with the document that makes it", async () => {
    const world = await oauthWorld();
    const v1 = "https://chatgpt.com/oauth/test-client/jwks-v1.json";
    const v2 = "https://chatgpt.com/oauth/test-client/jwks-v2.json";
    const k1 = signingKey("k1");
    const k2 = signingKey("k2");
    const longLived = { "cache-control": "public, max-age=3600" };
    world.net.json(CHATGPT_ID, chatgptDocument(v1), longLived);
    world.net.json(v1, { keys: [k1.jwk] }, longLived);
    const p = pkce();
    const { code } = await approve(world, CHATGPT_ID, CHATGPT_REDIRECT, { challenge: p.challenge });
    const tokens = await exchange(world, code, p.verifier, {
      redirect_uri: CHATGPT_REDIRECT,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: clientAssertion(k1, CHATGPT_ID),
    });
    expect(tokens.status).toBe(200);

    world.net.json(CHATGPT_ID, chatgptDocument(v2), longLived);
    world.net.json(v2, { keys: [k2.jwk] }, longLived);
    world.net.status(v1, 404);
    await world.refresher.cycle();
    const refreshed = await refresh(world, field(tokens, "refresh_token"), {
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: clientAssertion(k2, CHATGPT_ID),
    });
    expect(refreshed.status).toBe(200);
    expect(
      world.db.prepare("SELECT jwksUri FROM oauthClient WHERE clientId = ?").get(CHATGPT_ID),
    ).toEqual({ jwksUri: v2 });
  });
});

describe("pending connections", () => {
  async function startPending(world: World, i: number, browser = world.agent()) {
    const c = otherClient(i);
    world.net.json(c.id, c.document);
    const p = pkce();
    const res = await browser.send(authorizePath(c.id, c.redirect, p.challenge));
    return { ...c, res, verifier: p.verifier, browser };
  }

  it(`refuses a new connection while ${MAX_PENDING} wait, and one near its query's expiry still completes`, async () => {
    const clock = stashClock();
    const world = await oauthWorld({ now: clock.now });
    const browser = world.agent();
    await browser.signIn();
    const pending = [];
    for (let i = 0; i < MAX_PENDING; i++) pending.push(await startPending(world, i, browser));
    for (const p of pending) expect(p.res.headers.get("location")).toMatch(/^\/consent\?/);
    const refused = await startPending(world, 99, browser);
    expect(refused.res.status).toBe(429);
    expect(world.net.calls.map((c) => c.url)).not.toContain(refused.id);

    clock.advance(PENDING_MS - 10_000);
    await world.refresher.cycle();
    const first = pending[0];
    if (!first) throw new Error("no pending client");
    const query = new URL(first.res.headers.get("location") ?? "", "https://links.example").search;
    const accepted = await browser.send("/api/auth/oauth2/consent", {
      method: "POST",
      json: { accept: true, oauth_query: query.slice(1) },
    });
    expect(accepted.status).toBe(200);
    expect(new URL(field(accepted, "url")).searchParams.has("code")).toBe(true);
  });

  it("extends a pending client's pin when the owner reopens its authorize, so approving later with the new query works", async () => {
    const clock = stashClock();
    const world = await oauthWorld({ now: clock.now });
    const browser = world.agent();
    await browser.signIn();
    await startPending(world, 8, browser);
    clock.advance(400_000);
    const reopened = await startPending(world, 8, browser);
    expect(reopened.res.headers.get("location")).toMatch(/^\/consent\?/);

    clock.advance(300_000);
    await world.refresher.cycle();
    const query = new URL(reopened.res.headers.get("location") ?? "", "https://links.example")
      .search;
    const accepted = await browser.send("/api/auth/oauth2/consent", {
      method: "POST",
      json: { accept: true, oauth_query: query.slice(1) },
    });
    expect(accepted.status).toBe(200);
    expect(new URL(field(accepted, "url")).searchParams.has("code")).toBe(true);
  });

  it("recovers when consent is written but its re-run authorize fails: the refresher picks the client up and a retry succeeds", async () => {
    const clock = stashClock();
    const world = await oauthWorld({ now: clock.now });
    const browser = world.agent();
    await browser.signIn();
    const c = await startPending(world, 7, browser);
    const query = new URL(c.res.headers.get("location") ?? "", "https://links.example").search;
    clock.advance(PENDING_MS + 1_000);
    await world.refresher.cycle();
    const accepted = await browser.send("/api/auth/oauth2/consent", {
      method: "POST",
      json: { accept: true, oauth_query: query.slice(1) },
    });
    expect(accepted.status).toBe(400);
    expect(world.clients.isConnected(c.id)).toBe(true);

    await world.refresher.cycle();
    const p = pkce();
    const retry = await browser.send(authorizePath(c.id, c.redirect, p.challenge));
    const back = new URL(retry.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe(c.redirect);
    const code = back.searchParams.get("code") ?? "";
    const tokens = await exchange(world, code, p.verifier, {
      client_id: c.id,
      redirect_uri: c.redirect,
    });
    expect(tokens.status).toBe(200);
  });
});
