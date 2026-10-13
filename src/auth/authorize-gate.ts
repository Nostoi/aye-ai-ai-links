import { isCimdClientIdUrlCandidate } from "@better-auth/cimd";
import type { WithAuthLock } from "./auth-lock.js";
import type { Auth } from "./better-auth.js";
import { loginRedirect } from "./login-return.js";
import type { MetadataStash } from "./metadata-stash.js";
import type { OAuthClients } from "./oauth-clients.js";
import { OAUTH_ERROR_PATH } from "./oauth-error.js";
import { readSession } from "./session.js";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Answers `GET /oauth2/authorize`.
 * - For a client that is not connected, without a session: the app's own redirect to
 *   `/login?next=<this authorize URL>`. better-auth never sees it, so it creates no client row.
 * - For a CIMD client that is not connected, with the owner's session: a new connection. Its
 *   snapshot is fetched outside the lock and pinned for the signed query's lifetime, so the
 *   consent step can resolve it; refused while too many others are pending. When no current
 *   snapshot results, the browser goes to the OAuth error page.
 * - Anything else goes to better-auth under the lock.
 * This is a usability and database-growth guard. The admission check holds without it.
 */
export function authorizeGate({
  auth,
  withAuthLock,
  clients,
  stash,
  handle,
}: {
  auth: Auth;
  withAuthLock: WithAuthLock;
  clients: OAuthClients;
  stash: MetadataStash;
  handle: (request: Request) => Promise<Response>;
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const { caller, headers } = await readSession(auth, withAuthLock, request.headers);
    const connected = await withAuthLock(async () => clients.isConnected(clientId));
    let response: Response | undefined;
    if (!connected && !caller) {
      response = new Response(null, {
        status: 302,
        headers: { location: loginRedirect(url), ...NO_STORE },
      });
    } else {
      let pending = false;
      if (!connected && isCimdClientIdUrlCandidate(clientId)) {
        const result = await stash.prefetch(clientId);
        if (result === "full") {
          response = new Response(
            "Too many new connections are waiting for your approval. Approve or abandon one, then try again in a few minutes.",
            { status: 429, headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE } },
          );
        } else if (result !== "ok") {
          // Admission would refuse it with a JSON 400; the owner's browser gets the error page.
          response = new Response(null, {
            status: 302,
            headers: { location: `${OAUTH_ERROR_PATH}?error=invalid_client`, ...NO_STORE },
          });
        }
        pending = result === "ok";
      }
      response ??= await withAuthLock(async () => {
        // Pinned again here, so the pin outlasts the signed query better-auth is about to sign.
        if (pending) stash.pin(clientId);
        return handle(request);
      });
    }
    const out = new Response(response.body, response);
    for (const cookie of headers.getSetCookie()) out.headers.append("Set-Cookie", cookie);
    return out;
  };
}
