import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Caller, Identify } from "./auth/caller.js";
import { createDeps } from "./deps.js";
import { openDatabase } from "./store/database.js";

const A: Caller = { owner: "owner-a", savedBy: "claude-code" };
const B: Caller = { owner: "owner-b", savedBy: "codex" };
const KEYS: Record<string, Caller> = { "key-a": A, "key-b": B };
const identify: Identify = async (request) => {
  const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return KEYS[key] ?? null;
};

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

function setup(limit: number) {
  const db = openDatabase(":memory:");
  const deps = createDeps(db);
  for (const o of [A.owner, B.owner]) deps.store.ensureUser(o, o);
  const built = createApp({ deps, identify, rateLimit: { limit, now: () => 0 } });
  const send = (key: string | null, extra: HeadersInit = {}) => {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: "localhost",
    });
    if (key) headers.set("authorization", `Bearer ${key}`);
    new Headers(extra).forEach((v, k) => {
      headers.set(k, v);
    });
    return built.app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify(LIST),
      }),
    );
  };
  return { ...built, db, send };
}

describe("createApp rate limiting", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup(2);
  });

  it("answers a caller's request over the limit with 429 and Retry-After", async () => {
    expect((await t.send("key-a")).status).toBe(200);
    expect((await t.send("key-a")).status).toBe(200);
    const third = await t.send("key-a");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });

  it("still answers a foreign Origin with 403 once the bucket is used up", async () => {
    await t.send("key-a");
    await t.send("key-a");
    expect((await t.send("key-a")).status).toBe(429);
    expect((await t.send("key-a", { origin: "http://evil.example" })).status).toBe(403);
  });

  it("still answers a foreign Host with 403 once the bucket is used up", async () => {
    await t.send(null);
    await t.send(null);
    expect((await t.send(null)).status).toBe(429);
    expect((await t.send("key-a", { host: "evil.example" })).status).toBe(403);
  });

  it("keeps anonymous requests from using up a keyed caller's allowance", async () => {
    for (let i = 0; i < 5; i++) await t.send("not-a-key");
    expect((await t.send("not-a-key")).status).toBe(429);
    expect((await t.send("key-a")).status).toBe(200);
  });

  it("answers an anonymous request under the limit with 401", async () => {
    expect((await t.send("not-a-key")).status).toBe(401);
  });

  it("counts one agent's requests apart from another's", async () => {
    await t.send("key-a");
    await t.send("key-a");
    expect((await t.send("key-a")).status).toBe(429);
    expect((await t.send("key-b")).status).toBe(200);
  });

  it("writes nothing for a request it throttles", async () => {
    const save = (key: string) =>
      t.app.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            host: "localhost",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "save_link", arguments: { url: "https://example.com/r" } },
          }),
        }),
      );
    await t.send("key-a");
    await t.send("key-a");
    expect((await save("key-a")).status).toBe(429);
    const n = (t.db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n;
    expect(n).toBe(0);
  });
});

describe("createApp composition", () => {
  it("does not apply the MCP Host and Origin checks to sibling routes", async () => {
    const t = setup(10);
    t.app.get("/health", (c) => c.text("ok"));
    const res = await t.app.fetch(
      new Request("http://localhost/health", {
        headers: { host: "evil.example", origin: "http://evil.example" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("exposes close", async () => {
    const t = setup(10);
    await expect(t.close()).resolves.toBeUndefined();
  });
});
