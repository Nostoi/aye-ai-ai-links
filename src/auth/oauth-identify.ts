import { AGENT_KEY_PREFIX, bearerToken } from "./agent-keys.js";
import type { WithAuthLock } from "./auth-lock.js";
import { type Auth, LINKS_SCOPE } from "./better-auth.js";
import type { Identify, Identity } from "./caller.js";
import type { InternalClient } from "./internal-client.js";
import type { OAuthClients } from "./oauth-clients.js";

type Introspection = Record<string, unknown>;

/**
 * Whether an introspection result is a live Bearer token for this resource with the `links`
 * scope. A sender-constrained token (`cnf`, or a type other than Bearer) needs a proof this
 * server never checks, so it is refused.
 */
export function acceptsToken(result: Introspection, resource: string): boolean {
  const { active, token_type, aud, scope, sub, client_id } = result;
  const audiences = Array.isArray(aud) ? aud : [aud];
  return (
    active === true &&
    token_type === "Bearer" &&
    !("cnf" in result) &&
    audiences.includes(resource) &&
    typeof scope === "string" &&
    scope.split(" ").includes(LINKS_SCOPE) &&
    typeof sub === "string" &&
    sub !== "" &&
    typeof client_id === "string" &&
    client_id !== ""
  );
}

/**
 * Identifies `/mcp` callers. An `aak_` bearer is an agent key. Any other bearer is an OAuth
 * access token, introspected in-process under the auth lock through the internal client. The
 * caller's `savedBy` is the client's registered name, else its id, and its requests count
 * against a bucket per client.
 */
export const oauthIdentify =
  ({
    auth,
    withAuthLock,
    keys,
    internal,
    clients,
    resource,
  }: {
    auth: Auth;
    withAuthLock: WithAuthLock;
    keys: Identify;
    internal: InternalClient;
    clients: OAuthClients;
    resource: string;
  }): Identify =>
  async (request) => {
    const token = bearerToken(request.headers.get("authorization"));
    if (token === null) return null;
    if (token.startsWith(AGENT_KEY_PREFIX)) return keys(request);
    return withAuthLock(async (): Promise<Identity | null> => {
      let result: Introspection;
      try {
        result = await auth.api.oauth2Introspect({
          body: {
            token,
            token_type_hint: "access_token",
            client_id: internal.clientId,
            client_secret: internal.clientSecret,
          },
        });
      } catch {
        // Some malformed tokens make better-auth throw rather than answer inactive (#11595).
        return null;
      }
      if (!acceptsToken(result, resource)) return null;
      const clientId = result.client_id as string;
      return {
        owner: result.sub as string,
        savedBy: clients.name(clientId) ?? clientId,
        rateKey: `oauth:${clientId}`,
      };
    });
  };
