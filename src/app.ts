import { Hono } from "hono";
import type { WithAuthLock } from "./auth/auth-lock.js";
import { AUTH_BASE_PATH, type Auth } from "./auth/better-auth.js";
import type { Identify } from "./auth/caller.js";
import { authApp } from "./auth/http.js";
import type { RateLimitOptions } from "./http/rate-limit.js";
import { mcpApp } from "./mcp/http.js";
import type { McpDeps } from "./mcp/server.js";
import { webApp } from "./web/http.js";

/** better-auth and the lock every call into it goes through. */
export type AuthDeps = {
  auth: Auth;
  withAuthLock: WithAuthLock;
  /** The global sign-in limit; 10 per 15 minutes when left out. */
  loginLimit?: RateLimitOptions | undefined;
};

/**
 * The whole HTTP surface. Every door is mounted here, so tests drive the real composition. The
 * server always passes `auth`; without it, as in tests of the MCP door alone, the auth routes
 * and the web door are not mounted.
 */
export function createApp({
  deps,
  identify,
  auth,
  allowedHosts,
  rateLimit,
}: {
  deps: McpDeps;
  identify: Identify;
  auth?: AuthDeps | undefined;
  allowedHosts?: string[] | undefined;
  rateLimit?: RateLimitOptions | undefined;
}) {
  const app = new Hono();
  const mcp = mcpApp({ deps, identify, allowedHosts, rateLimit });
  app.route("/mcp", mcp.app);
  if (auth) {
    app.route(
      AUTH_BASE_PATH,
      authApp({
        handle: auth.auth.handler,
        withAuthLock: auth.withAuthLock,
        origin: new URL(auth.auth.options.baseURL).origin,
        loginLimit: auth.loginLimit,
      }),
    );
    app.route("/", webApp({ deps, auth: auth.auth, withAuthLock: auth.withAuthLock }));
  }
  return { app, close: mcp.close, calls: mcp.calls };
}
