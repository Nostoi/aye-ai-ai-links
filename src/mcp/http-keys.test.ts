import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentKey, keyIdentify, revokeAgentKey } from "../auth/agent-keys.js";
import { createDeps } from "../deps.js";
import { openDatabase } from "../store/database.js";
import { SqliteKeyStore } from "../store/key-store.js";
import { mcpApp } from "./http.js";

type Json = {
  result: {
    isError?: boolean;
    structuredContent: {
      link: { id: string; savedBy: string; summary: string | null };
      links: unknown[];
    };
  };
};

async function callTool(app: Hono, key: string | null, name: string, args: unknown) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    host: "localhost",
  });
  if (key) headers.set("authorization", `Bearer ${key}`);
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  const res = await app.fetch(
    new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }),
  );
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data:"));
  const json: Json = data ? JSON.parse(data.slice(5)) : text ? JSON.parse(text) : null;
  return { status: res.status, body: json };
}

describe("MCP door with real agent keys", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: Hono;
  let keys: SqliteKeyStore;
  let markKey: string;
  let aliceKey: string;
  const linkCount = () => (db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n;
  const idsFor = async (owner: string) => createDeps(db).search.search(owner, "", {}, 50);

  beforeEach(() => {
    db = openDatabase(":memory:");
    keys = new SqliteKeyStore(db);
    markKey = createAgentKey(keys, { owner: "mark", ownerName: "Mark", agent: "codex" });
    aliceKey = createAgentKey(keys, {
      owner: "alice",
      ownerName: "Alice",
      agent: "claude-code",
    });
    app = mcpApp({ deps: createDeps(db), identify: keyIdentify(keys) });
  });

  const save = (key: string | null, extra: object = {}) =>
    callTool(app, key, "save_link", { url: "https://example.com/k", title: "kw", ...extra });

  it("refuses a request with no Authorization header", async () => {
    const res = await save(null);
    expect(res.status).toBe(401);
    expect(linkCount()).toBe(0);
  });

  it("refuses an unknown key of the right shape", async () => {
    const res = await save("aak_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(res.status).toBe(401);
    expect(linkCount()).toBe(0);
  });

  it("refuses a revoked key, and served it before revocation", async () => {
    const before = await save(markKey);
    expect(before.status).toBe(200);
    expect(linkCount()).toBe(1);
    revokeAgentKey(keys, "mark", "codex");
    const after = await callTool(app, markKey, "save_link", { url: "https://example.com/second" });
    expect(after.status).toBe(401);
    expect(linkCount()).toBe(1);
  });

  it("saves under the key's owner with the key's agent name", async () => {
    const res = await save(markKey);
    expect(res.body.result.structuredContent.link.savedBy).toBe("codex");
    expect(await idsFor("mark")).toHaveLength(1);
    expect(await idsFor("alice")).toEqual([]);
  });

  it("ignores spoofed owner and savedBy arguments", async () => {
    const res = await save(markKey, { owner: "alice", savedBy: "evil" });
    expect(res.body.result.structuredContent.link.savedBy).toBe("codex");
    expect(await idsFor("mark")).toHaveLength(1);
    expect(await idsFor("alice")).toEqual([]);
  });

  it("keeps alice out of mark's link", async () => {
    const saved = await save(markKey);
    const id = saved.body.result.structuredContent.link.id;
    const got = await callTool(app, aliceKey, "get_link", { id });
    expect(got.body.result.isError).toBe(true);
    const upd = await callTool(app, aliceKey, "update_link", { id, summary: "hijack" });
    expect(upd.body.result.isError).toBe(true);
    const found = await callTool(app, aliceKey, "search_links", { query: "kw" });
    expect(found.body.result.structuredContent.links).toEqual([]);
    const mine = await callTool(app, markKey, "get_link", { id });
    expect(mine.body.result.structuredContent.link.summary).toBeNull();
  });
});
