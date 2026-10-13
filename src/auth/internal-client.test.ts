import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import { buildAuth } from "./build-auth.js";
import { INTERNAL_CLIENT_ID } from "./internal-client.js";
import { TEST_BASE_URL, TEST_SECRET } from "./memory-auth.js";
import {
  approve,
  authorizePath,
  connectClaude,
  DCR_REDIRECT,
  field,
  oauthWorld,
  otherClientDocument,
  pkce,
  saveLinkWith,
  type World,
} from "./oauth-test-kit.js";

const DAY = 24 * 60 * 60_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const register = async (world: World, name: string) =>
  field(
    await world.agent().send("/api/auth/oauth2/register", {
      method: "POST",
      origin: false,
      json: {
        client_name: name,
        redirect_uris: [DCR_REDIRECT],
        token_endpoint_auth_method: "none",
      },
    }),
    "client_id",
  );

const clientIds = (db: Database.Database) =>
  (
    db.prepare("SELECT clientId FROM oauthClient ORDER BY clientId").all() as { clientId: string }[]
  ).map((r) => r.clientId);

/** The server's start on the same auth database, as after a restart: same network, same links. */
async function restart(world: World) {
  await world.refresher.stop();
  const again = await buildAuth({
    db: world.db,
    secret: TEST_SECRET,
    baseUrl: TEST_BASE_URL,
    fetch: world.net.fetch,
    keys: async () => null,
  });
  const links = openDatabase(":memory:");
  const deps = createDeps(links, new FakeEmbedder(DIMS));
  deps.store.ensureUser("owner", "Owner");
  const { app } = createApp({
    deps,
    identify: again.identify,
    auth: again,
    allowedHosts: ["links.example"],
  });
  return { ...world, ...again, app, links };
}

describe("the internal client and the startup prune", () => {
  it("stores dates as ISO text, which the prune compares as text", async () => {
    const world = await oauthWorld();
    await register(world, "Some Agent");
    const dates = world.db.prepare("SELECT createdAt FROM oauthClient").all() as {
      createdAt: unknown;
    }[];
    expect(dates.length).toBe(2);
    for (const d of dates) expect(d.createdAt).toMatch(ISO);
  });

  it("keeps the internal client through a prune after its secret rotates, and prunes only stale unconsented DCR clients", async () => {
    const world = await oauthWorld();
    const claude = await connectClaude(world);
    const stale = await register(world, "Abandoned");
    const consented = await register(world, "Kept");
    await approve(world, consented, DCR_REDIRECT);
    const abandonedCimd = otherClientDocument(1);
    world.net.json(abandonedCimd.id, abandonedCimd.document);
    const browser = world.agent();
    await browser.signIn();
    await browser.send(authorizePath(abandonedCimd.id, abandonedCimd.redirect, pkce().challenge));
    expect(clientIds(world.db)).toContain(abandonedCimd.id);
    const old = new Date(Date.now() - 2 * DAY).toISOString();
    world.db.prepare("UPDATE oauthClient SET createdAt = ?").run(old);
    const fresh = await register(world, "Recent");
    const oldSecret = world.internal.clientSecret;

    const after = await restart(world);
    expect(clientIds(after.db)).toEqual(
      [
        INTERNAL_CLIENT_ID,
        consented,
        fresh,
        "https://claude.ai/oauth/mcp-oauth-client-metadata",
        // The prune covers DCR clients only.
        abandonedCimd.id,
      ].sort(),
    );
    expect(clientIds(after.db)).not.toContain(stale);
    expect(after.internal.clientSecret).not.toBe(oldSecret);
    expect((await saveLinkWith(after, claude.access, "https://e.example/1")).status).toBe(200);
    await expect(
      after.auth.api.oauth2Introspect({
        body: { token: claude.access, client_id: INTERNAL_CLIENT_ID, client_secret: oldSecret },
      }),
    ).rejects.toMatchObject({
      body: { error: "invalid_client", error_description: "invalid client_secret" },
    });
  });

  it("fills the stash before it returns, so a connected client works on the first request after a restart", async () => {
    const world = await oauthWorld();
    const claude = await connectClaude(world);
    const calls = world.net.calls.length;
    const after = await restart(world);
    expect(world.net.calls.length).toBe(calls + 1);
    expect((await saveLinkWith(after, claude.access, "https://e.example/2")).status).toBe(200);
  });

  it("gives the internal client no way to get tokens of its own", async () => {
    const world = await oauthWorld();
    const row = world.db
      .prepare(
        "SELECT grantTypes, redirectUris, tokenEndpointAuthMethod FROM oauthClient WHERE clientId = ?",
      )
      .get(INTERNAL_CLIENT_ID);
    expect(row).toEqual({
      grantTypes: "[]",
      redirectUris: "[]",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    const browser = world.agent();
    await browser.signIn();
    const res = await browser.send(
      authorizePath(INTERNAL_CLIENT_ID, "https://e.example/cb", pkce().challenge),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      new RegExp(`^${TEST_BASE_URL}/api/auth/error\\?error=invalid_redirect&`),
    );
  });
});
