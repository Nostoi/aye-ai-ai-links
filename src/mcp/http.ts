import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Caller, Identify } from "../auth/caller.js";
import { createRateLimiter, type RateLimitOptions } from "../http/rate-limit.js";
import { buildMcpServer, type McpDeps } from "./server.js";

/** Reads the caller back out of the authInfo that mcpApp built from `identify`. */
function callerFrom(authInfo: { clientId: string; extra?: Record<string, unknown> } | undefined) {
  const owner = authInfo?.extra?.owner;
  if (typeof owner !== "string" || owner === "") {
    throw new Error("MCP request reached the handler without an authenticated owner.");
  }
  return { owner, savedBy: authInfo?.clientId ?? "" } satisfies Caller;
}

/** Every request `identify` rejects shares this bucket, so guessing keys cannot use up an agent's allowance. */
const ANONYMOUS = "anonymous";

/**
 * The MCP door, served at `/` so a parent mounts it with `route("/mcp", ...)`. Order: Host and
 * Origin checks, `identify`, the rate limit (per caller, or the anonymous bucket), then the
 * handler. A request `identify` rejects gets 401 and never reaches the MCP handler, which
 * verifies nothing itself: it trusts the authInfo given here. `close` stops the handler.
 */
export function mcpApp({
  deps,
  identify,
  allowedHosts,
  rateLimit,
}: {
  deps: McpDeps;
  identify: Identify;
  allowedHosts?: string[] | undefined;
  rateLimit?: RateLimitOptions | undefined;
}) {
  // Keep the default legacy "stateless": Codex opens with a 2025-06-18 initialize (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility).
  const handler = createMcpHandler(({ authInfo }) => buildMcpServer(deps, callerFrom(authInfo)));
  const app = createMcpHonoApp(allowedHosts ? { allowedHosts } : {});
  const limiter = createRateLimiter(rateLimit);

  app.all("/", async (c) => {
    const caller = await identify(c.req.raw);
    const verdict = limiter(caller ? `${caller.owner}/${caller.savedBy}` : ANONYMOUS);
    if (!verdict.allowed) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32002, message: "Too many requests. Slow down and retry." },
          id: null,
        },
        429,
        { "Retry-After": String(verdict.retryAfterSeconds) },
      );
    }
    if (!caller) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Missing or invalid API key." },
          id: null,
        },
        401,
        { "WWW-Authenticate": "Bearer" },
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

  return { app, close: () => handler.close() };
}
