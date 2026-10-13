import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Caller, Identify } from "../auth/caller.js";
import { createRateLimiter, type RateLimitOptions } from "../http/rate-limit.js";
import { buildMcpServer, type McpDeps, type TrackCall } from "./server.js";

/** Reads the caller back out of the authInfo that mcpApp built from `identify`. */
function callerFrom(authInfo: { clientId: string; extra?: Record<string, unknown> } | undefined) {
  const owner = authInfo?.extra?.owner;
  if (typeof owner !== "string" || owner === "") {
    throw new Error("MCP request reached the handler without an authenticated owner.");
  }
  return { owner, savedBy: authInfo?.clientId ?? "" } satisfies Caller;
}

export function mcpApp({
  deps,
  identify,
  allowedHosts,
  rateLimit,
  challenge = "Bearer",
}: {
  deps: McpDeps;
  identify: Identify;
  allowedHosts?: string[] | undefined;
  rateLimit?: RateLimitOptions | undefined;
  /** The `WWW-Authenticate` value of a 401; with OAuth it names the resource metadata. */
  challenge?: string | undefined;
}) {
  // Tool calls still running. A response can be under way, or its connection closed, before
  // its call ends, so shutdown waits on the calls themselves, not on the HTTP requests.
  const running = new Set<Promise<unknown>>();
  const track: TrackCall = (call) => {
    running.add(call);
    const done = () => running.delete(call);
    call.then(done, done);
    return call;
  };
  // Keep the default legacy "stateless": Codex opens with a 2025-06-18 initialize (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility).
  const handler = createMcpHandler(({ authInfo }) =>
    buildMcpServer(deps, callerFrom(authInfo), track),
  );
  const app = createMcpHonoApp(allowedHosts ? { allowedHosts } : {});
  const limiter = createRateLimiter(rateLimit);

  app.all("/", async (c) => {
    const caller = await identify(c.req.raw);
    if (!caller) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Missing or invalid API key." },
          id: null,
        },
        401,
        { "WWW-Authenticate": challenge },
      );
    }
    const verdict = limiter(caller.rateKey);
    if (!verdict.allowed) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Too many requests. Slow down and retry." },
          id: null,
        },
        429,
        { "Retry-After": String(verdict.retryAfterSeconds) },
      );
    }
    return handler.fetch(c.req.raw, {
      authInfo: {
        token: "<redacted>",
        clientId: caller.savedBy,
        scopes: [],
        extra: { owner: caller.owner },
      },
    });
  });

  return {
    app,
    close: () => handler.close(),
    /** How many tool calls are running, and a promise that settles when those have ended. */
    calls: () => ({
      running: running.size,
      ended: Promise.allSettled([...running]).then(() => {}),
    }),
  };
}
