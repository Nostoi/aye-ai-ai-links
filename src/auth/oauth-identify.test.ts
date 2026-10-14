import { describe, expect, it } from "vitest";
import { createAgentKey } from "./agent-keys.js";
import { acceptsToken } from "./oauth-identify.js";
import {
  approve,
  connectClaude,
  DCR_REDIRECT,
  exchange,
  field,
  oauthWorld,
  pkce,
  RESOURCE,
  saveLinkWith,
} from "./oauth-test-kit.js";

const ACTIVE = {
  active: true,
  token_type: "Bearer",
  aud: RESOURCE,
  scope: "links offline_access",
  sub: "owner",
  client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
};

describe("acceptsToken", () => {
  it("accepts a live Bearer token for this resource with the links scope", () => {
    expect(acceptsToken(ACTIVE, RESOURCE)).toBe(true);
    expect(acceptsToken({ ...ACTIVE, aud: ["https://other.example", RESOURCE] }, RESOURCE)).toBe(
      true,
    );
  });

  it.each([
    ["inactive", { active: false }],
    ["for another audience", { aud: "https://links.example/other" }],
    ["for the resource with a trailing slash", { aud: `${RESOURCE}/` }],
    ["for an audience list without this resource", { aud: ["https://other.example"] }],
    ["without the links scope", { scope: "offline_access" }],
    ["whose scope only contains links as a substring", { scope: "links:read" }],
    ["sender-constrained by DPoP", { token_type: "DPoP" }],
    ["carrying a confirmation", { cnf: { jkt: "abc" } }],
    ["without a subject", { sub: "" }],
    ["without a client", { client_id: undefined }],
  ])("refuses a token %s", (_, change) => {
    expect(acceptsToken({ ...ACTIVE, ...change }, RESOURCE)).toBe(false);
  });
});

describe("oauthIdentify", () => {
  it("names a client without a registered name by its client_id", async () => {
    const world = await oauthWorld();
    const registered = await world.agent().send("/api/auth/oauth2/register", {
      method: "POST",
      origin: false,
      json: { redirect_uris: [DCR_REDIRECT], token_endpoint_auth_method: "none" },
    });
    const clientId = field(registered, "client_id");
    const p = pkce();
    const { code } = await approve(world, clientId, DCR_REDIRECT, { challenge: p.challenge });
    const tokens = await exchange(world, code, p.verifier, {
      client_id: clientId,
      redirect_uri: DCR_REDIRECT,
    });
    expect(
      (await saveLinkWith(world, field(tokens, "access_token"), "https://e.example/a")).status,
    ).toBe(200);
    expect(world.savedBy()).toEqual([clientId]);
  });

  it.each(["web", " Web ", "WEB"])(
    "names a client registered as %j by its client_id, since web marks the owner's own writes",
    async (name) => {
      const world = await oauthWorld();
      const registered = await world.agent().send("/api/auth/oauth2/register", {
        method: "POST",
        origin: false,
        json: {
          client_name: name,
          redirect_uris: [DCR_REDIRECT],
          token_endpoint_auth_method: "none",
        },
      });
      const clientId = field(registered, "client_id");
      const p = pkce();
      const { code } = await approve(world, clientId, DCR_REDIRECT, { challenge: p.challenge });
      const tokens = await exchange(world, code, p.verifier, {
        client_id: clientId,
        redirect_uri: DCR_REDIRECT,
      });
      expect(
        (await saveLinkWith(world, field(tokens, "access_token"), "https://e.example/w")).status,
      ).toBe(200);
      expect(world.savedBy()).toEqual([clientId]);
    },
  );

  it("still takes agent keys, rate limited in their own bucket, apart from an OAuth client of the same name", async () => {
    const world = await oauthWorld({ rateLimit: { limit: 1, now: () => 0 } });
    const registered = await world.agent().send("/api/auth/oauth2/register", {
      method: "POST",
      origin: false,
      json: {
        client_name: "codex",
        redirect_uris: [DCR_REDIRECT],
        token_endpoint_auth_method: "none",
      },
    });
    const clientId = field(registered, "client_id");
    const p = pkce();
    const { code } = await approve(world, clientId, DCR_REDIRECT, { challenge: p.challenge });
    const tokens = await exchange(world, code, p.verifier, {
      client_id: clientId,
      redirect_uri: DCR_REDIRECT,
    });
    const access = field(tokens, "access_token");
    const { key } = createAgentKey(world.keyStore, {
      owner: "owner",
      ownerName: "Owner",
      agent: "codex",
    });
    expect((await saveLinkWith(world, key, "https://e.example/1")).status).toBe(200);
    expect((await saveLinkWith(world, access, "https://e.example/2")).status).toBe(200);
    expect((await saveLinkWith(world, key, "https://e.example/3")).status).toBe(429);
    expect((await saveLinkWith(world, access, "https://e.example/4")).status).toBe(429);
    expect(world.savedBy()).toEqual(["codex", "codex"]);
  });

  it("refuses an unknown agent key without introspecting it", async () => {
    const world = await oauthWorld();
    let introspections = 0;
    const real = world.auth.api.oauth2Introspect;
    world.auth.api.oauth2Introspect = ((...args: Parameters<typeof real>) => {
      introspections++;
      return real(...args);
    }) as typeof real;
    expect((await saveLinkWith(world, "aak_not-a-real-key", "https://e.example/5")).status).toBe(
      401,
    );
    expect(introspections).toBe(0);
  });

  it("never introspects while an /api/auth request is inside better-auth, nor the reverse", async () => {
    const world = await oauthWorld();
    const { access } = await connectClaude(world);
    const log: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const handler = world.auth.handler;
    world.auth.handler = async (request: Request) => {
      log.push("auth in");
      entered();
      await held;
      const res = await handler(request);
      log.push("auth out");
      return res;
    };
    const introspect = world.auth.api.oauth2Introspect;
    world.auth.api.oauth2Introspect = (async (...args: Parameters<typeof introspect>) => {
      log.push("introspect in");
      const result = await introspect(...args);
      log.push("introspect out");
      return result;
    }) as typeof introspect;
    const session = world.agent().send("/api/auth/get-session");
    await inside;
    const call = saveLinkWith(world, access, "https://e.example/6");
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(["auth in"]);
    release();
    await session;
    expect((await call).status).toBe(200);
    expect(log).toEqual(["auth in", "auth out", "introspect in", "introspect out"]);
  });
});
