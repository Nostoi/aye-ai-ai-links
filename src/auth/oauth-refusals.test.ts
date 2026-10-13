import { describe, expect, it } from "vitest";
import {
  approve,
  authorizePath,
  CLAUDE_ID,
  CLAUDE_REDIRECT,
  claudeDocument,
  connectClaude,
  dpopProof,
  exchange,
  field,
  oauthWorld,
  pkce,
  RESOURCE,
  refresh,
  saveLinkWith,
  signingKey,
  TOKEN_URL,
  type World,
} from "./oauth-test-kit.js";

const CLAUDE = { client_id: CLAUDE_ID };

async function claudeCode(world: World, scope = "links offline_access") {
  world.net.json(CLAUDE_ID, claudeDocument);
  const p = pkce();
  const { code, browser } = await approve(world, CLAUDE_ID, CLAUDE_REDIRECT, {
    challenge: p.challenge,
    scope,
  });
  return { code, verifier: p.verifier, browser };
}

const liveTokens = (world: World) =>
  (
    world.db.prepare("SELECT count(*) AS n FROM oauthAccessToken WHERE revoked IS NULL").get() as {
      n: number;
    }
  ).n;

/** Wraps the auth adapter's refresh-token compare-and-swap, so a rotation can be held just after it. */
async function pauseAfterRotationClaims(world: World) {
  const { adapter } = await world.auth.$context;
  const original = adapter.incrementOne.bind(adapter);
  let reached!: () => void;
  let release!: () => void;
  const atPause = new Promise<void>((r) => {
    reached = r;
  });
  const released = new Promise<void>((r) => {
    release = r;
  });
  let armed = true;
  adapter.incrementOne = (async (args: Parameters<typeof original>[0]) => {
    const result = await original(args);
    if (armed && args.model === "oauthRefreshToken" && result) {
      armed = false;
      reached();
      await released;
    }
    return result;
  }) as typeof adapter.incrementOne;
  return { atPause, release, restore: () => (adapter.incrementOne = original) };
}

describe("refusals", () => {
  it("refuses a reused code, and the first exchange's tokens stop working", async () => {
    const world = await oauthWorld();
    const { code, verifier } = await claudeCode(world);
    const form = { ...CLAUDE, redirect_uri: CLAUDE_REDIRECT };
    const first = await exchange(world, code, verifier, form);
    expect(first.status).toBe(200);
    const again = await exchange(world, code, verifier, form);
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ error: "invalid_grant" });
    expect(typeof again.body === "object" && "access_token" in again.body).toBe(false);
    const res = await saveLinkWith(world, field(first, "access_token"), "https://e.example/0");
    expect(res.status).toBe(401);
    expect(liveTokens(world)).toBe(0);
  });

  it("refuses a replayed refresh token and kills the whole family", async () => {
    const world = await oauthWorld();
    const t0 = await connectClaude(world);
    const r1 = await refresh(world, t0.refresh, CLAUDE);
    expect(r1.status).toBe(200);
    const replay = await refresh(world, t0.refresh, CLAUDE);
    expect(replay.status).toBe(400);
    expect((await refresh(world, field(r1, "refresh_token"), CLAUDE)).status).toBe(400);
    expect(
      (await saveLinkWith(world, field(r1, "access_token"), "https://e.example/1")).status,
    ).toBe(401);
    expect(liveTokens(world)).toBe(0);
    expect(world.savedBy()).toEqual([]);
  });

  it("leaves no live token when a refresh races a replay of the token before it", async () => {
    const world = await oauthWorld();
    const t0 = await connectClaude(world);
    const r1 = await refresh(world, t0.refresh, CLAUDE);
    const pause = await pauseAfterRotationClaims(world);
    const rotation = refresh(world, field(r1, "refresh_token"), CLAUDE);
    await pause.atPause;
    const replay = refresh(world, t0.refresh, CLAUDE);
    pause.release();
    const [rotated, replayed] = await Promise.all([rotation, replay]);
    pause.restore();
    expect(replayed.status).toBe(400);
    if (rotated.status === 200) {
      expect(
        (await saveLinkWith(world, field(rotated, "access_token"), "https://e.example/2")).status,
      ).toBe(401);
      expect((await refresh(world, field(rotated, "refresh_token"), CLAUDE)).status).toBe(400);
    }
    expect(liveTokens(world)).toBe(0);
  });

  it("mints no token for another audience; /mcp's own audience check is in oauth-identify.test", async () => {
    const world = await oauthWorld();
    const { code, verifier } = await claudeCode(world);
    const other = await exchange(world, code, verifier, {
      ...CLAUDE,
      redirect_uri: CLAUDE_REDIRECT,
      resource: "https://links.example/other",
    });
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ error: "invalid_target" });
    expect(liveTokens(world)).toBe(0);
  });

  it("refuses plain PKCE before any code is issued", async () => {
    const world = await oauthWorld();
    world.net.json(CLAUDE_ID, claudeDocument);
    const browser = world.agent();
    await browser.signIn();
    const res = await browser.send(
      authorizePath(CLAUDE_ID, CLAUDE_REDIRECT, "plain-verifier-0123456789012345678901234567890", {
        code_challenge_method: "plain",
      }),
    );
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(CLAUDE_REDIRECT);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.has("code")).toBe(false);
  });

  it("refuses an unregistered redirect_uri, sending the browser to an error and not to it", async () => {
    const world = await oauthWorld();
    world.net.json(CLAUDE_ID, claudeDocument);
    const browser = world.agent();
    await browser.signIn();
    const res = await browser.send(
      authorizePath(CLAUDE_ID, "https://evil.example/cb", pkce().challenge),
    );
    const location = new URL(res.headers.get("location") ?? "", "https://links.example");
    expect(location.origin).toBe("https://links.example");
    expect(location.searchParams.get("error")).toBe("invalid_redirect");
    expect(world.db.prepare("SELECT count(*) AS n FROM verification").get()).toEqual({ n: 0 });
  });

  it("refuses an offline_access-only token at /mcp", async () => {
    const world = await oauthWorld();
    const { code, verifier } = await claudeCode(world, "offline_access");
    const tokens = await exchange(world, code, verifier, {
      ...CLAUDE,
      redirect_uri: CLAUDE_REDIRECT,
    });
    expect(tokens.status).toBe(200);
    expect(field(tokens, "scope")).toBe("offline_access");
    const res = await saveLinkWith(world, field(tokens, "access_token"), "https://e.example/4");
    expect(res.status).toBe(401);
    expect(world.savedBy()).toEqual([]);
  });

  it("refuses a DPoP-bound token sent as a plain Bearer token", async () => {
    const world = await oauthWorld();
    const { code, verifier } = await claudeCode(world);
    const proofKey = signingKey("dpop");
    const tokens = await world.agent().send("/api/auth/oauth2/token", {
      method: "POST",
      origin: false,
      headers: { dpop: dpopProof(proofKey, TOKEN_URL) },
      form: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        resource: RESOURCE,
        ...CLAUDE,
        redirect_uri: CLAUDE_REDIRECT,
      },
    });
    expect(tokens.status).toBe(200);
    expect(field(tokens, "token_type")).toBe("DPoP");
    const res = await saveLinkWith(world, field(tokens, "access_token"), "https://e.example/5");
    expect(res.status).toBe(401);
    expect(world.savedBy()).toEqual([]);
  });

  it("answers 401 with better-auth's challenge naming the resource metadata", async () => {
    const world = await oauthWorld();
    const res = await saveLinkWith(world, "not-a-token", "https://e.example/6");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://links.example/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
