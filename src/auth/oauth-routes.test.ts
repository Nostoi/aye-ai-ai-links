import { describe, expect, it } from "vitest";
import { AUTH_BODY_LIMIT } from "./http.js";
import {
  approve,
  authorizePath,
  CLAUDE_ID,
  CLAUDE_REDIRECT,
  claudeDocument,
  connectClaude,
  DCR_REDIRECT,
  exchange,
  field,
  oauthWorld,
  otherClientDocument,
  pkce,
  refresh,
  type World,
} from "./oauth-test-kit.js";

/** Counts requests that reach better-auth's handler. */
function countHandled(world: World) {
  const handled: string[] = [];
  const real = world.auth.handler;
  world.auth.handler = (request: Request) => {
    handled.push(`${request.method} ${new URL(request.url).pathname}`);
    return real(request);
  };
  return handled;
}

const registration = {
  client_name: "Some Agent",
  redirect_uris: [DCR_REDIRECT],
  token_endpoint_auth_method: "none",
};

type Case = { method: string; path: string; json?: unknown; form?: Record<string, string> };

/** Every route this PR adds, as a client or browser would send it. */
const NEW_ROUTES: Case[] = [
  { method: "GET", path: authorizePath(CLAUDE_ID, CLAUDE_REDIRECT, pkce().challenge) },
  { method: "POST", path: "/api/auth/oauth2/consent", json: { accept: true, oauth_query: "x=1" } },
  { method: "POST", path: "/api/auth/oauth2/token", form: { grant_type: "refresh_token" } },
  { method: "POST", path: "/api/auth/oauth2/revoke", form: { token: "junk" } },
  { method: "POST", path: "/api/auth/oauth2/register", json: registration },
  { method: "GET", path: "/api/auth/.well-known/oauth-authorization-server" },
  { method: "HEAD", path: "/api/auth/.well-known/oauth-authorization-server" },
  { method: "GET", path: "/.well-known/oauth-protected-resource" },
  { method: "GET", path: "/.well-known/oauth-protected-resource/mcp" },
  { method: "HEAD", path: "/.well-known/oauth-protected-resource/mcp" },
  { method: "GET", path: "/.well-known/oauth-authorization-server/api/auth" },
  { method: "GET", path: "/consent?x=1" },
];

const SERVER_TO_SERVER = new Set([
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/revoke",
  "/api/auth/oauth2/register",
]);

describe("route policies", () => {
  it.each(NEW_ROUTES)(
    "refuses $method $path with a foreign Origin before better-auth",
    async (c) => {
      const world = await oauthWorld();
      const handled = countHandled(world);
      const res = await world.agent().send(c.path, {
        method: c.method,
        json: c.json,
        form: c.form,
        headers: { origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
      expect(handled).toEqual([]);
    },
  );

  it.each(NEW_ROUTES)("refuses $method $path with a foreign Host before better-auth", async (c) => {
    const world = await oauthWorld();
    const handled = countHandled(world);
    const res = await world.agent().send(c.path, {
      method: c.method,
      json: c.json,
      form: c.form,
      headers: { host: "evil.example" },
    });
    expect(res.status).toBe(403);
    expect(handled).toEqual([]);
  });

  it.each(NEW_ROUTES.filter((c) => SERVER_TO_SERVER.has(c.path)))(
    "lets $method $path through without an Origin, as client backends send it",
    async (c) => {
      const world = await oauthWorld();
      const handled = countHandled(world);
      const res = await world.agent().send(c.path, {
        method: c.method,
        json: c.json,
        form: c.form,
        origin: false,
      });
      expect(res.status).not.toBe(403);
      expect(handled).toEqual([`POST ${c.path}`]);
    },
  );

  it("refuses consent without an Origin: it is a browser route", async () => {
    const world = await oauthWorld();
    const handled = countHandled(world);
    const res = await world.agent().send("/api/auth/oauth2/consent", {
      method: "POST",
      origin: false,
      json: { accept: true, oauth_query: "x=1" },
    });
    expect(res.status).toBe(403);
    expect(handled).toEqual([]);
  });

  it.each([
    ["POST", "/oauth2/introspect"],
    ["POST", "/oauth2/continue"],
    ["GET", "/oauth2/userinfo"],
    ["GET", "/oauth2/end-session"],
    ["POST", "/oauth2/authorize"],
    ["GET", "/oauth2/get-clients"],
    ["POST", "/oauth2/delete-consent"],
    ["GET", "/.well-known/openid-configuration"],
    ["GET", "/error"],
  ])("answers %s %s with 404 before better-auth", async (method, path) => {
    const world = await oauthWorld();
    const handled = countHandled(world);
    const res = await world.agent().send(`/api/auth${path}`, {
      method,
      ...(method === "POST" && { form: {} }),
    });
    expect(res.status).toBe(404);
    expect(handled).toEqual([]);
  });

  it("serves the resource metadata with the exact /mcp URL as its resource", async () => {
    const world = await oauthWorld();
    const res = await world.agent().send("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      resource: "https://links.example/mcp",
      authorization_servers: ["https://links.example/api/auth"],
    });
  });

  it("advertises no client_credentials grant and S256 only", async () => {
    const world = await oauthWorld();
    const res = await world.agent().send("/.well-known/oauth-authorization-server/api/auth");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe("registration", () => {
  const register = (world: World, json: unknown, headers: Record<string, string> = {}) =>
    world
      .agent()
      .send("/api/auth/oauth2/register", { method: "POST", origin: false, json, headers });
  const dcrRows = (world: World) =>
    (
      world.db
        .prepare("SELECT count(*) AS n FROM oauthClient WHERE clientDiscoveryId IS NULL")
        .get() as { n: number }
    ).n - 1;

  it("is limited globally, before better-auth", async () => {
    const world = await oauthWorld({ limits: { register: { limit: 2, windowMs: 60_000 } } });
    expect((await register(world, registration)).status).toBe(201);
    expect((await register(world, registration)).status).toBe(201);
    const third = await register(world, registration);
    expect(third.status).toBe(429);
    expect(dcrRows(world)).toBe(2);
  });

  it("refuses a body over the cap", async () => {
    const world = await oauthWorld();
    const res = await register(world, {
      ...registration,
      client_name: "x".repeat(AUTH_BODY_LIMIT),
    });
    expect(res.status).toBe(413);
    expect(dcrRows(world)).toBe(0);
  });

  it("refuses a jwks_uri, which would be fetched outside the guarded fetcher", async () => {
    const world = await oauthWorld();
    const handled = countHandled(world);
    const res = await register(world, {
      ...registration,
      token_endpoint_auth_method: "private_key_jwt",
      jwks_uri: "https://dcr-client.example/jwks.json",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_client_metadata" });
    expect(handled).toEqual([]);
    expect(dcrRows(world)).toBe(0);
  });

  it("refuses a body that is not JSON, so a jwks_uri cannot arrive another way", async () => {
    const world = await oauthWorld();
    const res = await world.agent().send("/api/auth/oauth2/register", {
      method: "POST",
      origin: false,
      form: { redirect_uris: DCR_REDIRECT, jwks_uri: "https://dcr-client.example/jwks.json" },
    });
    expect(res.status).toBe(400);
    expect(dcrRows(world)).toBe(0);
  });
});

describe("the auth lock and the network", () => {
  it("never fetches client metadata while the auth lock is held, across every allowed route", async () => {
    const world = await oauthWorld();
    const { access: _, refresh: claudeRefresh } = await connectClaude(world);
    const cycles: Promise<void>[] = [];
    // A refresher cycle runs alongside each step, so background fetches overlap locked requests.
    const alongside = async <T>(step: Promise<T>) => {
      cycles.push(world.refresher.cycle());
      return step;
    };

    // A pending client's prefetch, its consent page and consent.
    const other = otherClientDocument(3);
    world.net.json(other.id, other.document);
    const p = pkce();
    const { code, browser } = await alongside(
      approve(world, other.id, other.redirect, { challenge: p.challenge }),
    );
    expect(
      (
        await alongside(
          exchange(world, code, p.verifier, { client_id: other.id, redirect_uri: other.redirect }),
        )
      ).status,
    ).toBe(200);

    // A connected client's authorize without a session, then sign-in carrying its oauth_query.
    const fresh = world.agent();
    const az = await alongside(
      fresh.send(authorizePath(CLAUDE_ID, CLAUDE_REDIRECT, pkce().challenge)),
    );
    const login = new URL(az.headers.get("location") ?? "", "https://links.example");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.has("sig")).toBe(true);
    const resumed = await alongside(fresh.signIn({ oauth_query: login.search.slice(1) }));
    expect(resumed.status).toBe(200);
    expect(new URL(field(resumed, "url")).searchParams.has("code")).toBe(true);

    await alongside(refresh(world, claudeRefresh, { client_id: CLAUDE_ID }));
    await alongside(
      world.agent().send("/api/auth/oauth2/revoke", {
        method: "POST",
        origin: false,
        form: { client_id: CLAUDE_ID, token: "junk" },
      }),
    );
    await alongside(
      world
        .agent()
        .send("/api/auth/oauth2/register", { method: "POST", origin: false, json: registration }),
    );
    await alongside(world.agent().send("/.well-known/oauth-protected-resource/mcp"));
    await alongside(browser.send("/api/auth/get-session"));
    await alongside(browser.send("/api/auth/sign-out", { method: "POST" }));
    await Promise.all(cycles);

    expect(world.net.calls.length).toBeGreaterThan(cycles.length);
    expect(world.net.calls.filter((c) => c.locked)).toEqual([]);
  });

  it("makes the stash refuse a fetch attempted inside the lock", async () => {
    const world = await oauthWorld();
    world.net.json(CLAUDE_ID, claudeDocument);
    await expect(world.withAuthLock(() => world.stash.prefetch(CLAUDE_ID))).rejects.toThrow(
      /never run inside the auth lock/,
    );
    expect(world.net.calls).toEqual([]);
  });
});
