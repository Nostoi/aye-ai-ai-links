import { describe, expect, it } from "vitest";
import {
  approve,
  CHATGPT_ID,
  CHATGPT_REDIRECT,
  chatgptDocument,
  clientAssertion,
  exchange,
  field,
  oauthWorld,
  pkce,
  saveLinkWith,
  signingKey,
} from "../auth/oauth-test-kit.js";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

async function loggedWorld() {
  const lines: string[] = [];
  const world = await oauthWorld({ log: (line) => lines.push(line) });
  return { world, lines };
}

describe("the request log", () => {
  it("records each request of a ChatGPT connection, with the token refusal's error code and description, and no secret", async () => {
    const { world, lines } = await loggedWorld();
    const key = signingKey("k1");
    const jwksUri = "https://chatgpt.com/oauth/test-client/jwks.json";
    world.net.json(CHATGPT_ID, chatgptDocument(jwksUri));
    world.net.json(jwksUri, { keys: [key.jwk] });
    const p = pkce();
    const { code, browser } = await approve(world, CHATGPT_ID, CHATGPT_REDIRECT, {
      challenge: p.challenge,
    });
    const forgedAssertion = clientAssertion(signingKey("k1"), CHATGPT_ID);
    const forged = await exchange(world, code, p.verifier, {
      redirect_uri: CHATGPT_REDIRECT,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: forgedAssertion,
    });
    expect(forged.status).toBe(401);
    const assertion = clientAssertion(key, CHATGPT_ID);
    const tokens = await exchange(world, code, p.verifier, {
      redirect_uri: CHATGPT_REDIRECT,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion,
    });
    expect(tokens.status).toBe(200);
    const accessToken = field(tokens, "access_token");
    expect((await saveLinkWith(world, accessToken, "https://example.com/b")).status).toBe(200);

    expect(lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^\\[http\\] \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z POST /api/auth/oauth2/token 401 \\d+ms error=${field(forged, "error")} description=${escapeRegExp(JSON.stringify(field(forged, "error_description")))} ua=-$`,
        ),
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^\[http\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z POST \/api\/auth\/oauth2\/token 200 \d+ms ua=-$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^\[http\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z GET \/api\/auth\/oauth2\/authorize 302 /,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^\[http\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z POST \/mcp 200 /),
    );

    const secrets = [
      code,
      p.verifier,
      p.challenge,
      forgedAssertion,
      assertion,
      accessToken,
      field(tokens, "refresh_token"),
      ...browser.cookies.values(),
    ];
    const log = lines.join("\n");
    for (const secret of secrets) expect(log).not.toContain(secret);
  });

  it("records requests the host and Origin checks refuse before any door sees them", async () => {
    const { world, lines } = await loggedWorld();
    const agent = world.agent();
    const foreignHost = await agent.send("/login", {
      headers: { host: "evil.example", "user-agent": "Probe/1" },
    });
    expect(foreignHost.status).toBe(403);
    const foreignOrigin = await agent.send("/connections/disconnect", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(foreignOrigin.status).toBe(403);
    expect(lines).toEqual([
      expect.stringMatching(
        /^\[http\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z GET \/login 403 \d+ms (error=\S+ )?ua="Probe\/1"$/,
      ),
      expect.stringMatching(
        /^\[http\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z POST \/connections\/disconnect 403 \d+ms error=INVALID_ORIGIN ua=-$/,
      ),
    ]);
  });

  it("keeps the response when the log sink throws", async () => {
    const world = await oauthWorld({
      log: (line) => {
        if (line.includes("oauth2/token 200")) throw new Error("sink down");
      },
    });
    const key = signingKey("k1");
    const jwksUri = "https://chatgpt.com/oauth/test-client/jwks.json";
    world.net.json(CHATGPT_ID, chatgptDocument(jwksUri));
    world.net.json(jwksUri, { keys: [key.jwk] });
    const p = pkce();
    const { code } = await approve(world, CHATGPT_ID, CHATGPT_REDIRECT, { challenge: p.challenge });
    const tokens = await exchange(world, code, p.verifier, {
      redirect_uri: CHATGPT_REDIRECT,
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: clientAssertion(key, CHATGPT_ID),
    });
    expect(tokens.status).toBe(200);
    expect(field(tokens, "access_token")).toBeTruthy();
  });

  it("bounds the user agent so one line stays small", async () => {
    const { world, lines } = await loggedWorld();
    await world.agent().send("/login", { headers: { "user-agent": "x".repeat(8000) } });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThan(400);
    expect(lines[0]).toContain('ua="xxx');
  });
});
