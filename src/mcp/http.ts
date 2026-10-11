import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Caller, Identify } from "../auth/caller.js";
import { buildMcpServer, type McpDeps } from "./server.js";

/** Reads the caller back out of the authInfo that mcpApp built from `identify`. */
function callerFrom(authInfo: { clientId: string; extra?: Record<string, unknown> } | undefined) {
  const owner = authInfo?.extra?.owner;
  if (typeof owner !== "string" || owner === "") {
    throw new Error("MCP request reached the handler without an authenticated owner.");
  }
  return { owner, savedBy: authInfo?.clientId ?? "" } satisfies Caller;
}

/**
 * The /mcp door. `identify` runs first; a request it rejects gets 401 and never reaches
 * the MCP handler. The handler itself verifies nothing: it trusts the authInfo given here.
 */
export function mcpApp({
  deps,
  identify,
  allowedHosts,
}: {
  deps: McpDeps;
  identify: Identify;
  allowedHosts?: string[];
}) {
  // Keep the default legacy "stateless": Codex opens with a 2025-06-18 initialize (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility).
  const handler = createMcpHandler(({ authInfo }) => buildMcpServer(deps, callerFrom(authInfo)));
  const app = createMcpHonoApp(allowedHosts ? { allowedHosts } : {});

  app.all("/mcp", async (c) => {
    const caller = await identify(c.req.raw);
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

  return app;
}
