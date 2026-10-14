import { describe, expect, it } from "vitest";
import {
  approve,
  authorizePath,
  CHATGPT_ID,
  CHATGPT_REDIRECT,
  CLAUDE_ID,
  chatgptDocument,
  clientAssertion,
  connectClaude,
  exchange,
  field,
  oauthWorld,
  pkce,
  RESOURCE,
  refresh,
  saveLinkWith,
  signingKey,
  type World,
} from "./oauth-test-kit.js";

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** ChatGPT as it connects today: private_key_jwt, asking for `links` only. */
async function chatgptAsksForLinksOnly(world: World) {
  const key = signingKey("k1");
  const jwksUri = "https://chatgpt.com/oauth/test-client/jwks.json";
  world.net.json(CHATGPT_ID, chatgptDocument(jwksUri));
  world.net.json(jwksUri, { keys: [key.jwk] });
  const assertion = () => ({
    client_assertion_type: ASSERTION_TYPE,
    client_assertion: clientAssertion(key, CHATGPT_ID),
  });
  const p = pkce();
  const { code, browser, page } = await approve(world, CHATGPT_ID, CHATGPT_REDIRECT, {
    challenge: p.challenge,
    scope: "links",
  });
  const tokens = await exchange(world, code, p.verifier, {
    client_id: CHATGPT_ID,
    redirect_uri: CHATGPT_REDIRECT,
    ...assertion(),
  });
  return { tokens, assertion, browser, page };
}

describe("refresh tokens for connected apps", () => {
  it("gives an app that asks for links only a refresh token, which keeps it connected", async () => {
    const world = await oauthWorld();
    const { tokens, assertion, page } = await chatgptAsksForLinksOnly(world);
    expect(page.body).toContain("It stays connected while you use it, until you disconnect it");
    expect(tokens.status).toBe(200);
    expect(field(tokens, "scope")).toBe("links offline_access");
    const renewed = await refresh(world, field(tokens, "refresh_token"), {
      client_id: CHATGPT_ID,
      scope: "links",
      ...assertion(),
    });
    expect(renewed.status).toBe(200);
    const res = await saveLinkWith(world, field(renewed, "access_token"), "https://example.com/a");
    expect(res.status).toBe(200);
  });

  it.each([["refresh_token"], ["refresh_token "], [" refresh_token"], ["refresh_token\t"]])(
    "keeps rotating when an app refreshes asking for links only (grant_type %j), so a used refresh token is refused",
    async (grantType) => {
      const world = await oauthWorld();
      const { refresh: r0 } = await connectClaude(world);
      const form = { client_id: CLAUDE_ID, scope: "links", grant_type: grantType };
      const first = await refresh(world, r0, form);
      expect(first.status).toBe(200);
      const r1 = field(first, "refresh_token");
      const second = await refresh(world, r1, form);
      expect(second.status).toBe(200);
      expect(field(second, "refresh_token")).not.toBe("");
      const replay = await refresh(world, r1, form);
      expect(replay.status).toBe(400);
      expect(field(replay, "error")).toBe("invalid_grant");
    },
  );

  it("still refuses an authorize request with two scope parameters", async () => {
    const world = await oauthWorld();
    const { browser } = await chatgptAsksForLinksOnly(world);
    const p = pkce();
    const path = `${authorizePath(CHATGPT_ID, CHATGPT_REDIRECT, p.challenge, { scope: "links" })}&scope=bogus`;
    const res = await browser.send(path);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "", "https://x.example");
    expect(location.pathname).not.toBe("/consent");
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  describe("a token request in an odd shape never leaves a refresh token that stops rotating", () => {
    const FORM = "application/x-www-form-urlencoded";
    const client = `client_id=${encodeURIComponent(CLAUDE_ID)}&resource=${encodeURIComponent(RESOURCE)}`;
    const refreshBody = (r0: string) => `grant_type=refresh_token&refresh_token=${r0}&${client}`;
    const shapes: [string, string, (r0: string) => string][] = [
      ["scope twice", FORM, (r0) => `${refreshBody(r0)}&scope=links&scope=links`],
      ["scope empty, then links", FORM, (r0) => `${refreshBody(r0)}&scope=&scope=links`],
      [
        "grant_type twice",
        FORM,
        (r0) =>
          `grant_type=authorization_code&refresh_token=${r0}&${client}&grant_type=refresh_token&scope=links`,
      ],
      ...[
        `${FORM}; charset=UTF-8`,
        `text/plain, ${FORM}`,
        `${FORM}, ${FORM}`,
        `${FORM},`,
        `multipart/form-data; boundary=x, ${FORM}`,
      ].map((type): [string, string, (r0: string) => string] => [
        `Content-Type ${type}`,
        type,
        (r0) => `${refreshBody(r0)}&scope=links`,
      ]),
    ];

    it.each(shapes)("%s", async (_name, contentType, body) => {
      const world = await oauthWorld();
      const { refresh: r0 } = await connectClaude(world);
      const odd = await world.agent().send("/api/auth/oauth2/token", {
        method: "POST",
        origin: false,
        headers: { "content-type": contentType },
        rawForm: body(r0),
      });
      const form = { client_id: CLAUDE_ID, scope: "links" };
      const live = odd.status === 200 ? field(odd, "refresh_token") : r0;
      if (odd.status === 200) expect(field(odd, "scope")).toBe("links offline_access");
      const next = await refresh(world, live, form);
      expect(next.status).toBe(200);
      expect(field(next, "refresh_token")).not.toBe("");
      const replay = await refresh(world, live, form);
      expect(replay.status).toBe(400);
      expect(field(replay, "error")).toBe("invalid_grant");
    });
  });
});
