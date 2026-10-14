import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

/** The scope that makes better-auth issue a refresh token. */
export const OFFLINE_ACCESS = "offline_access";

/**
 * Every app the owner approves gets a refresh token: `offline_access` is added to a requested
 * scope that names others but not it. MCP clients may leave it out (ChatGPT does), and servers
 * should not ask for it, so the authorization server grants it itself (#102). It is added to
 * refreshes too, or a refresh asking for less would get a successor that never rotates (#105).
 * A missing or empty scope is left for better-auth to answer.
 */
function widened(scope: string): string | null {
  const scopes = scope.split(" ").filter(Boolean);
  if (scopes.length === 0 || scopes.includes(OFFLINE_ACCESS)) return null;
  return [...scopes, OFFLINE_ACCESS].join(" ");
}

/** The authorize URL with `offline_access` added to its one `scope`, or the same URL. */
export function authorizeWithOfflineAccess(url: string): string {
  const parsed = new URL(url);
  const values = parsed.searchParams.getAll("scope");
  const scope = values.length === 1 ? widened(values[0] ?? "") : null;
  if (!scope) return url;
  parsed.searchParams.set("scope", scope);
  return parsed.toString();
}

/**
 * Adds `offline_access` to a token request's scope after better-auth has parsed the body, so the
 * scope it widens is the one the token endpoint reads.
 */
export const offlineAccess = () =>
  ({
    id: "aye-offline-access",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const scope = typeof ctx.body?.scope === "string" ? widened(ctx.body.scope) : null;
            if (scope) return { context: { body: { ...ctx.body, scope } } };
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
