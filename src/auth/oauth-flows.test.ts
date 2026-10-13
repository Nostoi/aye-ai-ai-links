import { describe, expect, it } from "vitest";
import { TEST_BASE_URL } from "./memory-auth.js";
import {
  approve,
  CHATGPT_ID,
  CHATGPT_REDIRECT,
  CLAUDE_ID,
  CLAUDE_REDIRECT,
  chatgptDocument,
  claudeDocument,
  clientAssertion,
  DCR_REDIRECT,
  exchange,
  field,
  oauthWorld,
  pkce,
  saveLinkWith,
  signingKey,
} from "./oauth-test-kit.js";

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

describe("connecting an OAuth client, end to end", () => {
  it("Claude (CIMD, no client secret): login redirect, sign-in, consent, code, then /mcp as Claude", async () => {
    const world = await oauthWorld();
    world.net.json(CLAUDE_ID, claudeDocument);
    const p = pkce();
    const browser = world.agent();
    const first = await browser.send(
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: CLAUDE_ID,
        redirect_uri: CLAUDE_REDIRECT,
        scope: "links offline_access",
        state: "st-1",
        code_challenge: p.challenge,
        code_challenge_method: "S256",
        resource: `${TEST_BASE_URL}/mcp`,
      })}`,
    );
    // The app's own redirect: better-auth never saw it, so no client row and no fetch.
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toMatch(
      /^\/login\?next=%2Fapi%2Fauth%2Foauth2%2Fauthorize/,
    );
    expect(world.count("oauthClient")).toBe(1);
    expect(world.net.calls).toEqual([]);

    const { code, page, back } = await approve(world, CLAUDE_ID, CLAUDE_REDIRECT, {
      browser,
      challenge: p.challenge,
    });
    expect(page.body).toContain("Connect Claude?");
    expect(page.body).toContain("claude.ai");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(back.origin + back.pathname).toBe(CLAUDE_REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("iss")).toBe(`${TEST_BASE_URL}/api/auth`);

    const tokens = await exchange(world, code, p.verifier, {
      client_id: CLAUDE_ID,
      redirect_uri: CLAUDE_REDIRECT,
    });
    expect(tokens.status).toBe(200);
    const res = await saveLinkWith(world, field(tokens, "access_token"), "https://example.com/a");
    expect(res.status).toBe(200);
    expect(world.savedBy()).toEqual(["Claude"]);
    expect(world.net.calls.map((c) => c.url)).toEqual([CLAUDE_ID]);
  });

  it("ChatGPT (CIMD, private_key_jwt with a jwks_uri): its assertions are checked against the key set it publishes", async () => {
    const world = await oauthWorld();
    const key = signingKey("k1");
    const jwksUri = "https://chatgpt.com/oauth/test-client/jwks.json";
    world.net.json(CHATGPT_ID, chatgptDocument(jwksUri));
    world.net.json(jwksUri, { keys: [key.jwk] });
    const p = pkce();
    const { code } = await approve(world, CHATGPT_ID, CHATGPT_REDIRECT, { challenge: p.challenge });
    const forged = await exchange(world, code, p.verifier, {
      redirect_uri: CHATGPT_REDIRECT,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: clientAssertion(signingKey("k1"), CHATGPT_ID),
    });
    expect(forged.status).toBe(401);
    const tokens = await exchange(world, code, p.verifier, {
      redirect_uri: CHATGPT_REDIRECT,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: clientAssertion(key, CHATGPT_ID),
    });
    expect(tokens.status).toBe(200);
    const res = await saveLinkWith(world, field(tokens, "access_token"), "https://example.com/b");
    expect(res.status).toBe(200);
    expect(world.savedBy()).toEqual(["ChatGPT"]);
    expect(world.net.calls.map((c) => c.url)).toEqual([CHATGPT_ID, jwksUri]);
  });

  it("a DCR client (no metadata document, no secret)", async () => {
    const world = await oauthWorld();
    const registered = await world.agent().send("/api/auth/oauth2/register", {
      method: "POST",
      origin: false,
      json: {
        client_name: "Some Agent",
        redirect_uris: [DCR_REDIRECT],
        token_endpoint_auth_method: "none",
      },
    });
    expect(registered.status).toBe(201);
    const clientId = field(registered, "client_id");
    const p = pkce();
    const { code } = await approve(world, clientId, DCR_REDIRECT, { challenge: p.challenge });
    const tokens = await exchange(world, code, p.verifier, {
      client_id: clientId,
      redirect_uri: DCR_REDIRECT,
    });
    expect(tokens.status).toBe(200);
    const res = await saveLinkWith(world, field(tokens, "access_token"), "https://example.com/c");
    expect(res.status).toBe(200);
    expect(world.savedBy()).toEqual(["Some Agent"]);
    expect(world.net.calls).toEqual([]);
  });
});
