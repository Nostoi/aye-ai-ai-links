import { Hono } from "hono";
import type { Identify } from "./auth/caller.js";
import type { RateLimitOptions } from "./http/rate-limit.js";
import { mcpApp } from "./mcp/http.js";
import type { McpDeps } from "./mcp/server.js";

/** The whole HTTP surface. Every door is mounted here, so tests drive the real composition. */
export function createApp({
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
  const app = new Hono();
  const mcp = mcpApp({ deps, identify, allowedHosts, rateLimit });
  app.route("/mcp", mcp.app);
  return { app, close: mcp.close, calls: mcp.calls };
}
