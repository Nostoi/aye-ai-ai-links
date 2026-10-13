import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { WithAuthLock } from "./auth-lock.js";
import type { Auth } from "./better-auth.js";
import type { OAuthClients } from "./oauth-clients.js";

export type ConsentDetails = { clientName: string; redirectHost: string };

/**
 * What the consent page shows for a signed authorize query, or null when the signature is bad
 * or expired, so nothing a third party wrote is shown as the request. The name falls back to
 * the client id.
 */
export const consentDetails =
  ({
    auth,
    withAuthLock,
    clients,
  }: {
    auth: Auth;
    withAuthLock: WithAuthLock;
    clients: OAuthClients;
  }) =>
  async (query: string): Promise<ConsentDetails | null> => {
    const { secret } = await auth.$context;
    if (!(await verifyOAuthQueryParams(query, secret))) return null;
    const params = new URLSearchParams(query);
    const clientId = params.get("client_id");
    let redirectHost: string;
    try {
      redirectHost = new URL(params.get("redirect_uri") ?? "").host;
    } catch {
      return null;
    }
    if (!clientId) return null;
    const name = await withAuthLock(async () => clients.name(clientId));
    return { clientName: name ?? clientId, redirectHost };
  };
