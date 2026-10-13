import { describe, expect, it } from "vitest";
import { disconnect, listConnections } from "./disconnect.js";
import { INTERNAL_CLIENT_ID } from "./internal-client.js";
import {
  type Agent,
  addSecondUser,
  approve,
  authorizePath,
  CLAUDE_ID,
  CLAUDE_REDIRECT,
  connectClaude,
  connectClaudeAs,
  DCR_REDIRECT,
  exchange,
  field,
  oauthWorld,
  otherClientDocument,
  pkce,
  refresh,
  SECOND_USER,
  saveLinkWith,
  type World,
} from "./oauth-test-kit.js";

const end = (world: World) => disconnect(world);

async function registerDcr(world: World) {
  const registered = await world.agent().send("/api/auth/oauth2/register", {
    method: "POST",
    origin: false,
    json: {
      client_name: "Some Agent",
      redirect_uris: [DCR_REDIRECT],
      token_endpoint_auth_method: "none",
    },
  });
  return field(registered, "client_id");
}

/** Registers and connects a DCR client end to end; `scope` without offline_access gives no refresh token. */
async function connectDcr(world: World, scope = "links offline_access") {
  const clientId = await registerDcr(world);
  const p = pkce();
  const { code } = await approve(world, clientId, DCR_REDIRECT, { challenge: p.challenge, scope });
  const tokens = await exchange(world, code, p.verifier, {
    client_id: clientId,
    redirect_uri: DCR_REDIRECT,
  });
  expect(tokens.status).toBe(200);
  const body = tokens.body as Record<string, unknown>;
  return {
    clientId,
    access: field(tokens, "access_token"),
    refresh: typeof body.refresh_token === "string" ? body.refresh_token : null,
  };
}

/** An unused code for a client the browser's user already connected: authorize skips consent. */
async function unusedCode(browser: Agent, clientId: string, redirect: string) {
  const p = pkce();
  const res = await browser.send(authorizePath(clientId, redirect, p.challenge));
  const code = new URL(res.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error(`no code: ${res.status} ${res.headers.get("location")}`);
  return { code, verifier: p.verifier };
}

const rows = (world: World, clientId: string) => {
  const n = (sql: string) => (world.db.prepare(sql).get(clientId) as { n: number }).n;
  return {
    access: n("SELECT count(*) AS n FROM oauthAccessToken WHERE clientId = ?"),
    refresh: n("SELECT count(*) AS n FROM oauthRefreshToken WHERE clientId = ?"),
    consent: n("SELECT count(*) AS n FROM oauthConsent WHERE clientId = ?"),
    codes: n(
      `SELECT count(*) AS n FROM verification WHERE CASE WHEN json_valid(value)
       THEN json_extract(value, '$.query.client_id') = ? END`,
    ),
    client: n("SELECT count(*) AS n FROM oauthClient WHERE clientId = ?"),
  };
};

function addVerification(world: World, id: string, value: string) {
  const at = new Date().toISOString();
  world.db
    .prepare(
      "INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, id, value, new Date(Date.now() + 600_000).toISOString(), at, at);
}

describe("disconnect", () => {
  it("refuses a DCR client's token, refresh and unused code, and leaves everything else", async () => {
    const world = await oauthWorld();
    const claude = await connectClaude(world);
    const dcr = await connectDcr(world);
    const browser = world.agent();
    await browser.signIn();
    const claudeCode = await unusedCode(browser, CLAUDE_ID, CLAUDE_REDIRECT);
    const dcrCode = await unusedCode(browser, dcr.clientId, DCR_REDIRECT);
    addVerification(world, "other-json", JSON.stringify({ type: "something-else" }));
    addVerification(world, "not-json", "not json at all");
    const claudeBefore = rows(world, CLAUDE_ID);
    expect(claudeBefore).toMatchObject({ access: 1, refresh: 1, consent: 1, codes: 1 });
    expect(rows(world, dcr.clientId)).toMatchObject({
      access: 1,
      refresh: 1,
      consent: 1,
      codes: 1,
    });
    const sessions = world.count("session");
    expect(sessions).toBeGreaterThan(0);

    expect(await end(world)("owner", dcr.clientId)).toBe(true);

    expect(rows(world, dcr.clientId)).toEqual({
      access: 0,
      refresh: 0,
      consent: 0,
      codes: 0,
      client: 1,
    });
    expect((await saveLinkWith(world, dcr.access, "https://example.com/a")).status).toBe(401);
    const refreshed = await refresh(world, dcr.refresh ?? "", { client_id: dcr.clientId });
    expect(refreshed.status).not.toBe(200);
    const exchanged = await exchange(world, dcrCode.code, dcrCode.verifier, {
      client_id: dcr.clientId,
      redirect_uri: DCR_REDIRECT,
    });
    expect(exchanged.status).not.toBe(200);

    expect(rows(world, CLAUDE_ID)).toEqual(claudeBefore);
    expect(world.count("session")).toBe(sessions);
    expect((await browser.send("/api/auth/get-session")).body).toMatchObject({
      user: { id: "owner" },
    });
    const kept = world.db.prepare(
      "SELECT id FROM verification WHERE id IN ('other-json', 'not-json')",
    );
    expect(kept.all()).toHaveLength(2);
    expect(rows(world, INTERNAL_CLIENT_ID).client).toBe(1);
    expect((await saveLinkWith(world, claude.access, "https://example.com/b")).status).toBe(200);
    const claudeExchange = await exchange(world, claudeCode.code, claudeCode.verifier, {
      client_id: CLAUDE_ID,
      redirect_uri: CLAUDE_REDIRECT,
    });
    expect(claudeExchange.status).toBe(200);
  });

  it("deletes an access token that has no refresh token", async () => {
    const world = await oauthWorld();
    const dcr = await connectDcr(world, "links");
    expect(dcr.refresh).toBeNull();
    const nulls = world.db.prepare(
      "SELECT count(*) AS n FROM oauthAccessToken WHERE clientId = ? AND refreshId IS NULL",
    );
    expect(nulls.get(dcr.clientId)).toEqual({ n: 1 });

    await end(world)("owner", dcr.clientId);

    expect(nulls.get(dcr.clientId)).toEqual({ n: 0 });
    expect((await saveLinkWith(world, dcr.access, "https://example.com/a")).status).toBe(401);
  });

  it("forgets a CIMD client's snapshot and its pin", async () => {
    const world = await oauthWorld();
    const claude = await connectClaude(world);
    expect(world.stash.isCurrent(CLAUDE_ID)).toBe(true);
    // Still pinned from its connection: no refresher cycle has run since.
    expect(world.stash.sync(new Set())).toEqual([CLAUDE_ID]);

    expect(await end(world)("owner", CLAUDE_ID)).toBe(true);

    expect(world.stash.isCurrent(CLAUDE_ID)).toBe(false);
    expect(world.stash.sync(new Set())).toEqual([]);
    expect((await saveLinkWith(world, claude.access, "https://example.com/a")).status).toBe(401);
  });

  it("answers false and changes nothing for a client the owner has not connected", async () => {
    const world = await oauthWorld();
    await connectClaude(world);
    const before = rows(world, CLAUDE_ID);
    expect(await end(world)("someone-else", CLAUDE_ID)).toBe(false);
    expect(await end(world)("owner", "https://never.example/metadata.json")).toBe(false);
    expect(rows(world, CLAUDE_ID)).toEqual(before);
    expect(world.stash.isCurrent(CLAUDE_ID)).toBe(true);
  });

  it("leaves a pending client, which nobody has approved yet, current", async () => {
    const world = await oauthWorld();
    const x = otherClientDocument(7);
    world.net.json(x.id, x.document);
    expect(await world.stash.prefetch(x.id)).toBe("ok");
    expect(await end(world)("owner", x.id)).toBe(false);
    expect(world.stash.isCurrent(x.id)).toBe(true);
  });
});

const B = SECOND_USER;

describe("disconnect with two users", () => {
  it("leaves the other user's connection to a shared CIMD client working, and forgets it after the last", async () => {
    const world = await oauthWorld();
    const a = await connectClaude(world);
    const bAccess = await connectClaudeAs(world, await addSecondUser(world));
    expect((await saveLinkWith(world, bAccess, "https://example.com/b0")).status).toBe(200);

    expect(await end(world)("owner", CLAUDE_ID)).toBe(true);

    expect((await saveLinkWith(world, a.access, "https://example.com/a1")).status).toBe(401);
    expect((await saveLinkWith(world, bAccess, "https://example.com/b1")).status).toBe(200);
    expect(world.stash.isCurrent(CLAUDE_ID)).toBe(true);
    expect(await listConnections(world)("owner")).toEqual([]);
    expect((await listConnections(world)(B.id)).map((c) => c.clientId)).toEqual([CLAUDE_ID]);

    expect(await end(world)(B.id, CLAUDE_ID)).toBe(true);
    expect(world.stash.isCurrent(CLAUDE_ID)).toBe(false);
    expect((await saveLinkWith(world, bAccess, "https://example.com/b2")).status).toBe(401);
  });

  it("keeps the other user's unused code for the same client, which still exchanges", async () => {
    const world = await oauthWorld();
    const aBrowser = world.agent();
    await connectClaude(world);
    await aBrowser.signIn();
    const bBrowser = await addSecondUser(world);
    await connectClaudeAs(world, bBrowser);
    const aCode = await unusedCode(aBrowser, CLAUDE_ID, CLAUDE_REDIRECT);
    const bCode = await unusedCode(bBrowser, CLAUDE_ID, CLAUDE_REDIRECT);
    expect(rows(world, CLAUDE_ID).codes).toBe(2);

    expect(await end(world)("owner", CLAUDE_ID)).toBe(true);

    expect(rows(world, CLAUDE_ID).codes).toBe(1);
    const survivors = world.db
      .prepare(
        `SELECT json_extract(value, '$.userId') AS userId FROM verification
         WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') = 'authorization_code' END`,
      )
      .all();
    expect(survivors).toEqual([{ userId: B.id }]);
    const aExchange = await exchange(world, aCode.code, aCode.verifier, {
      client_id: CLAUDE_ID,
      redirect_uri: CLAUDE_REDIRECT,
    });
    expect(aExchange.status).not.toBe(200);
    const bExchange = await exchange(world, bCode.code, bCode.verifier, {
      client_id: CLAUDE_ID,
      redirect_uri: CLAUDE_REDIRECT,
    });
    expect(bExchange.status).toBe(200);
  });
});

describe("listConnections", () => {
  it("lists the owner's connected apps with their names and first approval, CIMD and DCR alike", async () => {
    const world = await oauthWorld();
    const before = Date.now();
    await connectClaude(world);
    const dcr = await connectDcr(world);
    const list = await listConnections(world)("owner");
    // Consent times are stored to the second, so the two may tie: compare without order.
    expect(list.map((c) => [c.clientId, c.name]).sort()).toEqual(
      [
        [CLAUDE_ID, "Claude"],
        [dcr.clientId, "Some Agent"],
      ].sort(),
    );
    for (const c of list) {
      expect(c.connectedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(c.connectedAt.getTime()).toBeLessThanOrEqual(Date.now());
    }
    expect(await listConnections(world)("someone-else")).toEqual([]);
  });
});
